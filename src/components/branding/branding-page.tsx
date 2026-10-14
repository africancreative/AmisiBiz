"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { ColourInput, LogoUpload } from "./branding-form";
import { TenantTheme } from "./tenant-theme";
import {
  updateTenantBrandingAction,
  deleteLogoAction,
  getTenantBrandingAction,
} from "@/server/actions/branding";
import {
  brandingFormSchema,
  BRANDING_DEFAULT_VALUES,
  DOCUMENT_LAYOUTS,
  type BrandingFormValues,
  type DocumentLayout,
} from "@/lib/validations/branding";
import {
  WCAG_AA_NORMAL_TEXT_RATIO,
  contrastRatio,
} from "@/lib/branding/contrast";
import {
  CURRENCY_LABELS,
  SUPPORTED_CURRENCIES,
  toSupportedCurrency,
} from "@/lib/validation/common";

/**
 * Branding form.
 *
 * The schema, the colour rules and the contrast check all come from the same
 * modules the Server Action uses, so what this screen accepts is exactly what
 * the server will accept. Logo upload goes through `/api/branding/logo`, which
 * verifies the file bytes and the caller's membership; there is deliberately no
 * action-based upload path that could record a URL for bytes that were never
 * stored.
 */

/** Tenant rows store free-form strings; only a known layout is applied. */
function toDocumentLayout(value: string | null): DocumentLayout {
  return (DOCUMENT_LAYOUTS as readonly string[]).includes(value ?? "")
    ? (value as DocumentLayout)
    : "standard";
}

interface BrandingFormProps {
  tenantId: string;
}

export function BrandingForm({ tenantId }: BrandingFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = React.useState(false);
  const [logoUrl, setLogoUrl] = React.useState<string | null>(null);
  const [logoLoading, setLogoLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [contrastWarning, setContrastWarning] = React.useState<string | null>(
    null,
  );

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<BrandingFormValues>({
    resolver: zodResolver(brandingFormSchema),
    defaultValues: BRANDING_DEFAULT_VALUES,
  });

  const primaryColor = watch("primaryColor");
  const primaryForeground = watch("primaryForeground");

  React.useEffect(() => {
    let active = true;

    async function loadBranding() {
      const result = await getTenantBrandingAction(tenantId);
      if (!result.success || !result.data?.branding || !active) return;

      const b = result.data.branding;
      setValue("displayName", b.displayName ?? "");
      setValue("registeredName", b.registeredName ?? "");
      setValue("primaryColor", b.primaryColor);
      setValue("secondaryColor", b.secondaryColor);
      setValue("accentColor", b.accentColor);
      setValue("primaryForeground", b.primaryForeground);
      setValue("contactEmail", b.contactEmail ?? "");
      setValue("contactPhone", b.contactPhone ?? "");
      setValue("postalAddress", b.postalAddress ?? "");
      setValue("physicalAddress", b.physicalAddress ?? "");
      setValue("website", b.website ?? "");
      setValue("taxPin", b.taxPin ?? "");
      // Only a currency this build supports can be selected; anything else keeps
      // the documented default rather than rendering an invalid option.
      setValue("currency", toSupportedCurrency(b.currency));
      setValue("defaultFooter", b.defaultFooter ?? "");
      setValue("paymentInstructions", b.paymentInstructions ?? "");
      setValue("documentLayout", toDocumentLayout(b.documentLayout));
      setLogoUrl(b.logoUrl);
    }

    loadBranding();
    return () => {
      active = false;
    };
  }, [tenantId, setValue]);

  // Advisory only; the Server Action re-checks contrast before writing.
  React.useEffect(() => {
    const ratio = contrastRatio(primaryColor, primaryForeground);
    if (ratio !== null && ratio < WCAG_AA_NORMAL_TEXT_RATIO) {
      setContrastWarning(
        `Contrast is ${ratio.toFixed(2)}:1 — the minimum is ${WCAG_AA_NORMAL_TEXT_RATIO}:1. Adjust the colours so document text stays readable.`,
      );
    } else {
      setContrastWarning(null);
    }
  }, [primaryColor, primaryForeground]);

  const onSubmit = async (data: BrandingFormValues) => {
    if (contrastWarning) return;

    setIsLoading(true);
    setServerError(null);

    try {
      const result = await updateTenantBrandingAction({ tenantId, ...data });

      if (result.success) {
        router.refresh();
        return;
      }

      setServerError(result.error || "Failed to save branding");
      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          const message = messages[0];
          if (!message) continue;
          setError(field as keyof BrandingFormValues, { message });
        }
      }
    } catch {
      setServerError("Something went wrong while saving. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogoUpload = async (file: File) => {
    setLogoLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("tenantId", tenantId);

      const response = await fetch("/api/branding/logo", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();
      if (result.success) {
        setLogoUrl(result.data.logoUrl);
      } else {
        throw new Error(result.error || "Upload failed");
      }
    } finally {
      setLogoLoading(false);
    }
  };

  const handleLogoDelete = async () => {
    setLogoLoading(true);
    try {
      const result = await deleteLogoAction(tenantId);
      if (result.success) {
        setLogoUrl(null);
      } else {
        throw new Error(result.error || "Delete failed");
      }
    } finally {
      setLogoLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {serverError && <Alert tone="danger">{serverError}</Alert>}

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-6">
            <h2 className="text-lg font-semibold">Brand Identity</h2>
            <ColourInput
              label="Primary Colour"
              value={primaryColor}
              onChange={(v) => setValue("primaryColor", v)}
              error={errors.primaryColor?.message}
              description="Main brand colour used for headers and buttons on documents"
              required
            />
            <ColourInput
              label="Secondary Colour"
              value={watch("secondaryColor")}
              onChange={(v) => setValue("secondaryColor", v)}
              error={errors.secondaryColor?.message}
              description="Supporting colour for secondary elements"
              required
            />
            <ColourInput
              label="Accent Colour"
              value={watch("accentColor")}
              onChange={(v) => setValue("accentColor", v)}
              error={errors.accentColor?.message}
              description="Highlight colour for calls to action"
              required
            />
            <ColourInput
              label="Primary Foreground"
              value={primaryForeground}
              onChange={(v) => setValue("primaryForeground", v)}
              error={errors.primaryForeground?.message}
              description="Text colour on primary backgrounds (must meet 4.5:1 contrast)"
              required
            />
            {contrastWarning && <Alert tone="warning">{contrastWarning}</Alert>}
          </section>

          <section className="space-y-6">
            <h2 className="text-lg font-semibold">Logo</h2>
            <LogoUpload
              currentLogoUrl={logoUrl}
              onUpload={handleLogoUpload}
              onDelete={handleLogoDelete}
              isLoading={logoLoading}
            />
          </section>
        </div>

        <section className="space-y-6 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">Business Details</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor="displayName"
                className="block text-sm font-medium text-foreground"
              >
                Display Name
              </label>
              <Input
                id="displayName"
                placeholder="Your Business Ltd"
                {...register("displayName")}
                maxLength={100}
              />
              {errors.displayName && (
                <p className="text-xs text-destructive" role="alert">
                  {errors.displayName.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="registeredName"
                className="block text-sm font-medium text-foreground"
              >
                Registered Name
              </label>
              <Input
                id="registeredName"
                placeholder="Your Business Limited"
                {...register("registeredName")}
                maxLength={200}
              />
              {errors.registeredName && (
                <p className="text-xs text-destructive" role="alert">
                  {errors.registeredName.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="contactEmail"
                className="block text-sm font-medium text-foreground"
              >
                Contact Email
              </label>
              <Input
                id="contactEmail"
                type="email"
                placeholder="contact@business.com"
                {...register("contactEmail")}
                maxLength={254}
              />
              {errors.contactEmail && (
                <p className="text-xs text-destructive" role="alert">
                  {errors.contactEmail.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="contactPhone"
                className="block text-sm font-medium text-foreground"
              >
                Contact Phone
              </label>
              <Input
                id="contactPhone"
                placeholder="+254 700 000 000"
                {...register("contactPhone")}
                maxLength={50}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="website"
                className="block text-sm font-medium text-foreground"
              >
                Website
              </label>
              <Input
                id="website"
                placeholder="https://business.com"
                {...register("website")}
                maxLength={254}
              />
              {errors.website && (
                <p className="text-xs text-destructive" role="alert">
                  {errors.website.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="taxPin"
                className="block text-sm font-medium text-foreground"
              >
                Tax PIN
              </label>
              <Input
                id="taxPin"
                placeholder="A001234567Z"
                {...register("taxPin")}
                maxLength={50}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="currency"
                className="block text-sm font-medium text-foreground"
              >
                Currency
              </label>
              <Select id="currency" {...register("currency")}>
                {SUPPORTED_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {CURRENCY_LABELS[code] ?? code}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Phase 04 ships Kenyan Shilling only; additional currencies are
                introduced with the multi-currency pricing phase, so the server
                rejects any other code.
              </p>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="documentLayout"
                className="block text-sm font-medium text-foreground"
              >
                Document Layout
              </label>
              <Select id="documentLayout" {...register("documentLayout")}>
                <option value="standard">Standard</option>
                <option value="compact">Compact</option>
                <option value="detailed">Detailed</option>
              </Select>
            </div>
          </div>
        </section>

        <section className="space-y-6 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">Addresses</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor="postalAddress"
                className="block text-sm font-medium text-foreground"
              >
                Postal Address
              </label>
              <Textarea
                id="postalAddress"
                placeholder="P.O. Box 12345-00100, Nairobi"
                {...register("postalAddress")}
                maxLength={500}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="physicalAddress"
                className="block text-sm font-medium text-foreground"
              >
                Physical Address
              </label>
              <Textarea
                id="physicalAddress"
                placeholder="123 Business Street, Westlands, Nairobi"
                {...register("physicalAddress")}
                maxLength={500}
                rows={3}
              />
            </div>
          </div>
        </section>

        <section className="space-y-6 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">
            Document Footer & Payment Instructions
          </h2>
          <div className="space-y-1.5">
            <label
              htmlFor="defaultFooter"
              className="block text-sm font-medium text-foreground"
            >
              Default Footer
            </label>
            <Textarea
              id="defaultFooter"
              placeholder="Thank you for your business. Payment due within 30 days."
              {...register("defaultFooter")}
              maxLength={1000}
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="paymentInstructions"
              className="block text-sm font-medium text-foreground"
            >
              Payment Instructions
            </label>
            <Textarea
              id="paymentInstructions"
              placeholder="Bank: ABC Bank, Account: 1234567890, Branch: Westlands, Swift: ABCBKENA"
              {...register("paymentInstructions")}
              maxLength={2000}
              rows={3}
            />
          </div>
        </section>

        <div className="flex justify-end gap-3 border-t border-border pt-6">
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.back()}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading || isSubmitting}>
            {isLoading || isSubmitting ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </form>

      <section className="space-y-4 border-t border-border pt-6">
        <h2 className="text-lg font-semibold">Live Preview</h2>
        <TenantTheme
          branding={{
            displayName: watch("displayName") || "Your Business Ltd",
            primaryColor: watch("primaryColor"),
            secondaryColor: watch("secondaryColor"),
            accentColor: watch("accentColor"),
            primaryForeground: watch("primaryForeground"),
            logoUrl: logoUrl,
          }}
          className="overflow-hidden rounded-lg border border-border"
        >
          <div className="bg-tenant text-tenant-foreground p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                {logoUrl && (
                  // Plain <img> on purpose: `logoUrl` is the same-origin,
                  // tenant-and-signature-checked `/api/branding/logo` route, not
                  // an arbitrary remote host, so next/image's remote-pattern
                  // allow-listing would add configuration without adding safety.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt={`${watch("displayName") || "Your business"} logo`}
                    className="h-12 w-auto mb-4 object-contain"
                    referrerPolicy="no-referrer"
                  />
                )}
                <p className="text-lg font-semibold">
                  {watch("displayName") || "Your Business Ltd"}
                </p>
                <p className="text-sm opacity-80">INV-0001</p>
              </div>
              <span className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-accent-foreground">
                INVOICE
              </span>
            </div>
            <div className="space-y-2 border-t border-tenant-foreground/20 pt-4 text-sm opacity-80">
              <p className="font-medium">
                {watch("displayName") || "Your Business Ltd"}
              </p>
              <p>
                {watch("physicalAddress") || "123 Business Street, Nairobi"}
              </p>
              <p>
                {watch("contactEmail") || "contact@business.com"} ·{" "}
                {watch("contactPhone") || "+254 700 000 000"}
              </p>
              <p>
                {watch("taxPin")
                  ? `PIN: ${watch("taxPin")}`
                  : "PIN: A001234567Z"}
              </p>
            </div>
            <div className="mt-8 grid grid-cols-4 gap-4 text-sm opacity-80">
              <div>
                <p className="font-medium">Description</p>
                <p>Consulting Services</p>
              </div>
              <div>
                <p className="font-medium">Qty</p>
                <p>10</p>
              </div>
              <div>
                <p className="font-medium">Unit Price</p>
                <p>KES 5,000.00</p>
              </div>
              <div>
                <p className="font-medium">Total</p>
                <p>KES 50,000.00</p>
              </div>
            </div>
            <div className="mt-6 text-right text-sm opacity-80">
              <p>Subtotal: KES 50,000.00</p>
              <p>VAT (16%): KES 8,000.00</p>
              <p className="font-semibold">Total: KES 58,000.00</p>
            </div>
            <p className="mt-8 text-xs opacity-60 text-center">
              {watch("defaultFooter") || "Thank you for your business."}
            </p>
          </div>
        </TenantTheme>
      </section>
    </div>
  );
}
