import Link from "next/link";
import { getTranslations, usePathname } from "next-intl/server";
import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { Badge } from "@amisibiz/ui/badge";
import { Form, FormControl, FormLabel, FormMessage } from "@amisibiz/ui/form";
import {
  Input,
  InputPlaceholder,
  InputRightElement,
} from "@amisibiz/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@amisibiz/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsPanel } from "@amisibiz/ui/tabs";
import { Loader2Icon, AlertCircleIcon, CheckCircleIcon } from "@amisibiz/ui/icons";
import { PlusIcon, BuildingIcon, CalendarIcon, MapPinIcon, GlobeIcon, PhoneIcon, MailIcon } from "@amisibiz/ui/icons";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { searchTenants, listPlanOptions } from "@/lib/admin/tenant-queries";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { prisma } from "@amisibiz/database";
import { generateTenantSlug, validateSubdomain } from "@/lib/admin/subdomain";
import { useNavigate } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminBusinessRegistrationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");
  const pathname = await usePathname();

  // Check authorization
  const session = await _requirePlatformAuth();

  const [planOptions, setPlanOptions] = useState<
    { id: string; code: string; name: string }[]
>([]);
  const [subdomains, setSubdomains] = useState<Set<string>>(new Set());
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [loadingSubdomains, setLoadingSubdomains] = useState(true);

  // Fetch plan options
  useEffect(() => {
    ;(async () => {
      setLoadingPlans(true);
      const plans = await listPlanOptions();
      setPlanOptions(plans);
      setLoadingPlans(false);
    })();
  }, []);

  // Fetch existing subdomains to prevent duplicates
  useEffect(() => {
    ;(async () => {
      setLoadingSubdomains(true);
      const allTenants = await prisma.tenant.findMany({
        select: { slug: true },
      });
      const existing = new Set(allTenants.map((t) => t.slug));
      setSubdomains(existing);
      setLoadingSubdomains(false);
    })();
  }, []);

  // Form schema using Zod for validation
  const registrationSchema = z.object({
    legalName: z
      .string()
      .min(2, { message: t("validation.minLength", { min: 2 }) })
      .max(100, { message: t("validation.maxLength", { max: 100 }) }),
    tradingName: z.string().max(100).optional(),
    contactName: z
      .string()
      .min(2, { message: t("validation.minLength", { min: 2 }) })
      .max(100, { message: t("validation.maxLength", { max: 100 }) }),
    email: z.string().email({ message: t("validation.email") }),
    phone: z.string().optional(),
    country: z.string().default("KE"),
    timezone: z.string().default("UTC"),
    planId: z.string().min(1, { message: t("validation.required") }),
    subdomain: z
      .string()
      .min(3, { message: t("validation.minLength", { min: 3 }) })
      .max(63, { message: t("validation.maxLength", { max: 63 }) })
      .refine(
        (val) => validateSubdomain(val),
        { message: t("validation.subdomainInvalid") }
      )
      .refine(
        (val) => !subdomains.has(val),
        { message: t("validation.subdomainTaken") }
      ),
  });

  const [
    legalName,
    setLegalName,
    tradingName,
    setTradingName,
    contactName,
    setContactName,
    email,
    setEmail,
    phone,
    setPhone,
    country,
    setCountry,
    timezone,
    setTimezone,
    planId,
    setPlanId,
    subdomain,
    setSubdomain,
  ] = useForm<z.infer<typeof registrationSchema>>({
    defaultValues: {
      legalName: "",
      tradingName: "",
      contactName: "",
      email: "",
      phone: "",
      country: "KE",
      timezone: "UTC",
      planId: "",
      subdomain: "",
    },
    resolver: async (data) => {
      const result = registrationSchema.safeParse(data);
      if (!result.success) {
        return result.error.formErrors.field;
      }
      return null;
    },
  });

  const handleSubmit = async (data: z.infer<typeof registrationSchema>) => {
    if (!session.user.id) {
      throw new Error(t("auth.notSignedIn"));
    }

    // Validate that the admin has permission to create tenants
    await authorizePlatform(session.user.id, PERMISSIONS.TENANTS_CREATE);

    // Start transactional registration
    try {
      await prisma.$transaction(async (tx) => {
        // Generate unique tenant identifier
        const slug = generateTenantSlug(data.legalName, data.subdomain);

        // Create the tenant (PENDING by default - not auto-active)
        const tenant = await tx.tenant.create({
          data: {
            name: data.legalName,
            slug,
            status: "PENDING",
            country: data.country,
            timezone: data.timezone,
            planId: data.planId,
            createdBy: session.user.id, // Platform admin who created it
          },
        });

        // Create initial owner membership for the platform admin
        // (The platform admin becomes the first owner)
        await tx.tenantMember.create({
          data: {
            tenantId: tenant.id,
            userId: session.user.id,
            role: "TENANT_OWNER",
            isDefault: true,
          },
        });

        // TODO: Create initial branding/configuration records if provided
        // TODO: Send welcome email / onboarding flow

        // Log the creation event
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: session.user.id,
            action: "tenant.created",
            resource: "Tenant",
            resourceId: tenant.id,
            metadata: {
              legalName: data.legalName,
              subdomain: data.subdomain,
              planId: data.planId,
              createdBy: session.user.id,
            },
            ipAddress: undefined,
            userAgent: undefined,
          },
        });
      });

      // Success - navigate back to directory
      ;(async () => {
        // In a full implementation, show a toast notification
        window.location.href = `/${locale}/admin/tenants`;
      })();
    } catch (error) {
      console.error("Registration failed:", error);
      // Error handling - the form will show validation errors
    }
  };

  // --- Subdomain validation UI ---
  const [subdomainValid, setSubdomainValid] = useState<boolean | null>(null);
  const [subdomainAvailable, setSubdomainAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    ;(async () => {
      if (!subdomain || subdomain.length < 3) {
        setSubdomainValid(null);
        setSubdomainAvailable(null);
        return;
      }
      const isValid = validateSubdomain(subdomain);
      setSubdomainValid(isValid);

      // Check against existing tenants
      const exists = await prisma.tenant.findFirst({
        where: { slug: subdomain },
      });
      setSubdomainAvailable(!exists);
    })();
  }, [subdomain]);

  const isFormValid = Boolean(
    legalName &&
    contactName &&
    email &&
    planId &&
    subdomain &&
    subdomainValid &&
    subdomainAvailable
  );

  if (loadingPlans) {
    return (
      <Card>
        <CardHeader>{t("registerTitle")}</CardHeader>
        <CardContent className="h-64 flex items-center justify-center">
          <Loader2Icon className="h-6 w-6 animate-spin text-primary" />
          <span className="ml-3">{t("loadingPlans")}</span>
        </CardContent>
      </Card>
    );
  }

  if (loadingSubdomains) {
    return (
      <Card>
        <CardHeader>{t("registerTitle")}</CardHeader>
        <CardContent className="h-64 flex items-center justify-center">
          <Loader2Icon className="h-6 w-6 animate-spin text-primary" />
          <span className="ml-3">{t("loadingSubdomains")}</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("registerTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit}
            className="space-y-6"
            disabled={!isFormValid}
          >
            {/* Basic Information Section */}
            <Card>
              <CardHeader>
                <CardTitle>{t("register.basicInfo")}</CardTitle>
              </CardHeader>
              <CardContent>
                <Form {...registrationSchema} {...registrationSchema.formErrors}>
                  <FormControl>
                    <FormLabel>{t("register.legalName")}</FormLabel>
                    <Input
                      placeholder={t("register.legalNamePlaceholder")}
                      value={legalName}
                      onChange={(e) => setLegalName(e.target.value)}
                    />
                    <FormMessage name="legalName" />
                  </FormControl>

                  <FormControl>
                    <FormLabel>{t("register.tradingName")}</FormLabel>
                    <Input
                      placeholder={t("register.tradingNamePlaceholder")}
                      value={tradingName ?? ""}
                      onChange={(e) => setTradingName(e.target.value)}
                    />
                    <FormMessage name="tradingName" />
                  </FormControl>

                  <FormControl>
                    <FormLabel>{t("register.contactName")}</FormLabel>
                    <Input
                      placeholder={t("register.contactNamePlaceholder")}
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                    />
                    <FormMessage name="contactName" />
                  </FormControl>

                  <FormControl>
                    <FormLabel>{t("register.email")}</FormLabel>
                    <Input
                      type="email"
                      placeholder={t("register.emailPlaceholder")}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <FormMessage name="email" />
                  </FormControl>

                  <FormControl>
                    <FormLabel>{t("register.phone")}</FormLabel>
                    <Input
                      placeholder={t("register.phonePlaceholder")}
                      value={phone ?? ""}
                      onChange={(e) => setPhone(e.target.value)}
                      type="tel"
                    />
                    <FormMessage name="phone" />
                  </FormControl>
                </CardContent>
              </Card>

              {/* Location & Plan Section */}
              <Card>
                <CardHeader>
                  <CardTitle>{t("register.locationPlan")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <FormControl>
                    <FormLabel>{t("register.country")}</FormLabel>
                    <Select
                      value={country}
                      onValueChange={(val) => setCountry(val as string)}
                    >
                      {/* Basic country options - in production use i18n data */}
                      <SelectTrigger>
                        <SelectValue placeholder={t("register.countrySelect")} />
                        <SelectContent>
                          <SelectItem value="KE">Kenya</SelectItem>
                          <SelectItem value="TZ">Tanzania</SelectItem>
                          <SelectItem value="UG">Uganda</SelectItem>
                          <SelectItem value="RW">Rwanda</SelectItem>
                          <SelectItem value="ET">Ethiopia</SelectItem>
                          <SelectItem value="US">United States</SelectItem>
                          <SelectItem value="GB">United Kingdom</SelectItem>
                        </SelectContent>
                      </Select>
                    </Select>
                  </FormControl>

                  <FormControl>
                    <FormLabel>{t("register.timezone")}</FormLabel>
                    <Select
                      value={timezone}
                      onValueChange={(val) => setTimezone(val as string)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("register.timezoneSelect")} />
                        <SelectContent>
                          <SelectItem value="UTC">UTC</SelectItem>
                          <SelectItem value="EAT">East Africa Time</SelectItem>
                          <SelectItem value="WAT">West Africa Time</SelectItem>
                          <SelectItem value="GMT">Greenwich Mean Time</SelectItem>
                        </SelectContent>
                      </Select>
                    </Select>
                  </FormControl>

                  <FormControl>
                    <FormLabel>{t("register.plan")}</FormLabel>
                    <Select
                      value={planId}
                      onValueChange={(val) => setPlanId(val as string)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("register.planSelect")} />
                        <SelectContent>
                          {planOptions.map((plan) => (
                            <SelectItem key={plan.id} value={plan.id}>
                              {plan.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Select>
                  </FormControl>

                  <FormControl>
                    <FormLabel>{t("register.subdomain")}</FormLabel>
                    <Input
                      placeholder={t("register.subdomainPlaceholder")}
                      value={subdomain}
                      onChange={(e) => setSubdomain(e.target.value)}
                      disabled={!subdomainValid || !subdomainAvailable}
                      className={cn(
                        "input",
                        subdomainValid === false && "border-red-500",
                        subdomainAvailable === false && "border-red-500",
                        subdomainValid === true && subdomainAvailable === true && "border-primary-500"
                      )}
                    />
                    <FormMessage name="subdomain" />

                    {/* Subdomain status badges */}
                    {subdomainValid !== null && (
                      <div className="mt-2 text-xs">
                        {subdomainValid === false && (
                          <Badge tone="destructive">{t("validation.subdomainInvalid")}</Badge>
                        )}
                        {subdomainAvailable === false && (
                          <Badge tone="destructive">{t("validation.subdomainTaken")}</Badge>
                        )}
                        {subdomainValid === true && subdomainAvailable === true && (
                          <Badge tone="success">{t("validation.subdomainAvailable")}</Badge>
                        )}
                      </div>
                    )}
                  </FormControl>
                </CardContent>
              </Card>

              {/* Consent & Confirmation */}
              <Card>
                <CardHeader>
                  <CardTitle>{t("register.confirmation")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {t("register.confirmationText", {
                      // New business starts PENDING, not ACTIVE
                      requiresApproval: t("register.requiresApproval"),
                    })}
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t("register.lifecycleNote")}
                  </p>
                </CardContent>
              </Card>
            </Card>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!isFormValid}
                className="btn btn-primary flex-1"
              >
                {t("register.createTenant")}
              </button>
              <Link
                href={`/${locale}/admin/tenants`}
                className="btn btn-secondary flex-1"
              >
                {t("cancel")}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** Platform auth guard for registration page */
async function _requirePlatformAuth() {
  // Use the existing requireAuth pattern from the admin layout
  const { import: requireAuth } = await import("@/lib/auth/helpers");
  return requireAuth();
}

/** Generate a unique tenant slug from legal name and subdomain */
function generateTenantSlug(legalName: string, subdomain: string): string {
  // Normalize: lowercase, replace non-alphanumeric with hyphens, trim hyphens
  const normalized = legalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Combine with subdomain if provided, otherwise use normalized name
  if (subdomain) {
    const cleanSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `${cleanSubdomain}-${normalized}`.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  }
  return normalized.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

/** Validate subdomain format: only lowercase alphanumeric, hyphens, starts/ends with alphanumeric */
function validateSubdomain(subdomain: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain);
}