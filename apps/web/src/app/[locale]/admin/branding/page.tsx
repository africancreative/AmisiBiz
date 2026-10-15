import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { Badge } from "@amisibiz/ui/badge";
import { TableContainer, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@amisibiz/ui/table";
import { EmptyState } from "@amisibiz/ui/state";
import { Loader2Icon, AlertCircleIcon, CheckCircleIcon } from "@amisibiz/ui/icons";
import { useEffect, useState } from "react";
import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { updateTenantBranding, resetTenantBranding } from "@/server/actions/branding/management";
import { useNavigate } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminBrandingPage({
  params,
}: {
  params: Promise<{ locale: string; tenantId: string }>;
>) {
  const { locale, tenantId } = await params;
  const t = await getTranslations("admin");

  // Authorization check
  const session = await _requirePlatformAuth();
  await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_TENANTS_READ);

  // Fetch current branding config
  const branding = await prisma.tenantBranding.findUnique({
    where: { tenantId },
    // Select only the fields needed for the UI
    select: {
      displayName: true,
      registeredName: true,
      primaryColor: true,
      secondaryColor: true,
      accentColor: true,
      primaryForeground: true,
      logoUrl: true,
      contactEmail: true,
      contactPhone: true,
      postalAddress: true,
      physicalAddress: true,
      website: true,
      currency: true,
      defaultFooter: true,
      documentLayout: true,
      invoiceTemplate: true,
      quotationTemplate: true,
      deliveryNoteTemplate: true,
      documentNumberingPrefix: true,
      documentNumberingPadding: true,
      documentPeriodStyle: true,
      fiscalStartMonth: true,
      etimsCompatible: true,
      etimsDocumentType: true,
      etimsSerialNumber: true,
      etimsLastSync: true,
    },
  });

  // State for action forms
  const [actionStatus, setActionStatus] = useState<{
    type "update" | "reset";
    loading: boolean;
    error: string | null;
    data?: Partial<{
      displayName: string;
      registeredName: string;
      primaryColor: string;
      secondaryColor: string;
      accentColor: string;
      primaryForeground: string;
      logoFile?: File;
      logoUrl: string;
      contactEmail: string;
      contactPhone: string;
      postalAddress: string;
      physicalAddress: string;
      website: string;
      taxPin: string;
      currency: string;
      defaultFooter: string;
      documentLayout: string;
      invoiceTemplate: string;
      quotationTemplate: string;
      deliveryNoteTemplate: string;
      documentNumberingPrefix: string;
      documentNumberingPadding: number;
      documentPeriodStyle: string;
      fiscalStartMonth: number;
      etimsCompatible: boolean;
    }>;
  }>({ type: "update" as const, loading: false, error: null, data: {} });

  // Fetch existing tenant info for defaults
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, slug: true },
  });

  // --- Update Branding Form ---
  const handleUpdate = async () => {
    if (!actionStatus.data) return;

    setActionStatus({ type: "update", loading: true, error: null, data: {} });

    // If a new logo file was selected, upload it first
    let logoUrl = actionStatus.data.logoUrl;
    if (actionStatus.data.logoFile) {
      const uploadResult = await uploadBrandingLogo(
        actionStatus.data.logoFile,
        tenantId
      );
      if (!uploadResult.success) {
        setActionStatus({
          type: "update",
          loading: false,
          error: uploadResult.error,
          data: {},
        });
        return;
      }
      logoUrl = uploadResult.logoUrl;
    }

    const result = await updateTenantBranding(
      tenantId,
      {
        ...actionStatus.data,
        logoUrl,
      },
      "Branding configuration updated by administrator"
    );

    setActionStatus({
      type: "update",
      loading: false,
      error: result.error || null,
      data: {},
    });

    if (result.success) {
      window.location.reload();
    }
  };

  // --- Reset Branding Form ---
  const handleReset = async () => {
    setActionStatus({ type: "reset", loading: true, error: null });

    const result = await resetTenantBranding(
      tenantId,
      "Branding reset by administrator"
    );

    setActionStatus({
      type: "reset",
      loading: false,
      error: result.error || null,
    });

    if (result.success) {
      window.location.reload();
    }
  };

  // --- Logo Upload UI ---
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);

  const handleLogoChange = (e: React.ChangeEvent) => {
    const file = e.target.files[0];
    if file {
      setLogoFile(file);
    }
  };

  const handleLogoRemove = () => {
    setLogoFile(null);
  };

  // --- Preview generation ---
  useEffect(() => {
    // In a full implementation, this would generate live previews
    // for each document type (invoice, quotation, delivery note)
    // using the selected template and branding configuration.
    const previewTimeout = setTimeout(() => {
      // Placeholder: no preview generation on initial load
    }, 500);
    return () => clearTimeout(previewTimeout);
  }, [
    branding.documentLayout,
    branding.invoiceTemplate,
    quotationTemplate,
    deliveryNoteTemplate,
  ]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t("brandingTitle", { tenant: tenant?.name })}</h1>
        <p className="text-muted-foreground">
          {t("brandingDescription", { tenantSlug: tenant?.slug })}
        </p>
      </div>

      {/* Current Branding Configuration Summary */}
      <Card>
        <CardHeader>
          <CardTitle>{t("currentConfiguration")}</CardTitle>
        </CardHeader>
        <CardContent>
          {branding ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">{t("displayName")}</p>
                <p className="font-medium text-foreground">{branding.displayName || t("notSet")}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("primaryColor")}</p>
                <span
                  className={`h-8 w-8 rounded ${branding.primaryColor}`
                  }
                  style={branding.primaryColor ? { backgroundColor: branding.primaryColor } : {}}
                  />
                <span className="ml-2 text-xs font-medium text-primary">
                  {branding.primaryColor}
                </span>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("documentLayout")}</p>
                <span className="ml-2 text-xs font-medium text-primary">
                  {t(`layout.${branding.documentLayout}`) || branding.documentLayout}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div>
                <p className="text-sm text-muted-foreground">{t("invoiceTemplate")}</p>
                <span className="ml-2 text-xs font-medium text-primary">
                  {t(`template.${branding.invoiceTemplate}`) || branding.invoiceTemplate}
                </span>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("quotationTemplate")}</p>
                <span className="ml-2 text-xs font-medium text-primary">
                  {t(`template.${branding.quotationTemplate}`) || branding.quotationTemplate}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">{t("noBrandingConfig")}</p>
          )}
        </CardContent>
      </Card>

      {/* Branding Configuration Form */}
      <Card>
        <CardHeader>
          <CardTitle>{t("configureBranding")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleUpdate();
            }}
            className="space-y-6"
            disabled={actionStatus.loading}
          >
            {/* Basic Information Section */}
            <Card>
              <CardHeader>
                <CardTitle>{t("basicInfo")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("displayName")}
                    </label>
                    <input
                      type="text"
                      value={actionStatus.data.displayName || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, displayName: e.target.value },
                        }))
                      }
                      className="input w-full"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("registeredName")}
                    </label>
                    <input
                      type="text"
                      value={actionStatus.data.registeredName || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, registeredName: e.target.value },
                        }))
                      }
                      className="input w-full"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("primaryColor")}
                    </label>
                    <input
                      type="color"
                      value={actionStatus.data.primaryColor || "#1d4ed8"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, primaryColor: e.target.value },
                        }))
                      }
                      className="w-auto input color-picker"
                    />
                    <span className="ml-2 text-xs font-medium">
                      {actionStatus.data.primaryColor}
                    </span>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("secondaryColor")}
                    </label>
                    <input
                      type="color"
                      value={actionStatus.data.secondaryColor || "#1e3a5f"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, secondaryColor: e.target.value },
                        }))
                      }
                      className="w-auto input color-picker"
                    />
                    <span className="ml-2 text-xs font-medium">
                      {actionStatus.data.secondaryColor}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("accentColor")}
                    </label>
                    <input
                      type="color"
                      value={actionStatus.data.accentColor || "#f59e0b"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, accentColor: e.target.value },
                        }))
                      }
                      className="w-auto input color-picker"
                    />
                    <span className="ml-2 text-xs font-medium">
                      {actionStatus.data.accentColor}
                    </span>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("primaryForeground")}
                    </label>
                    <input
                      type="color"
                      value={actionStatus.data.primaryForeground || "#f8fafc"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, primaryForeground: e.target.value },
                        }))
                      }
                      className="w-auto input color-picker"
                    />
                    <span className="ml-2 text-xs font-medium">
                      {actionStatus.data.primaryForeground}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Contact Information */}
            <Card>
              <CardHeader>
                <CardTitle>{t("contactInfo")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("contactEmail")}
                    </label>
                    <input
                      type="email"
                      value={actionStatus.data.contactEmail || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, contactEmail: e.target.value },
                        }))
                      }
                      className="input w-full"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("contactPhone")}
                    </label>
                    <input
                      type="tel"
                      value={actionStatus.data.contactPhone || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, contactPhone: e.target.value },
                        }))
                      }
                      className="input w-full"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("postalAddress")}
                    </label>
                    <textarea
                      value={actionStatus.data.postalAddress || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, postalAddress: e.target.value },
                        }))
                      }
                      className="input w-full rounded min-h-10"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("physicalAddress")}
                    </label>
                    <textarea
                      value={actionStatus.data.physicalAddress || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, physicalAddress: e.target.value },
                        }))
                      }
                      className="input w-full rounded min-h-10"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Website & Tax */}
            <Card>
              <CardHeader>
                <CardTitle>{t("websiteTax")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("website")}
                    </label>
                    <input
                      type="url"
                      value={actionStatus.data.website || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, website: e.target.value },
                        }))
                      }
                      className="input w-full"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("taxPin")}
                    </label>
                    <input
                      type="text"
                      value={actionStatus.data.taxPin || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, taxPin: e.target.value },
                        }))
                      }
                      className="input w-full"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("currency")}
                    </label>
                    <select
                      value={actionStatus.data.currency || "KES"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, currency: e.target.value },
                        }))
                      }
                      className="input"
                    >
                      <option value="KES">KES (Kenya)</option>
                      <option value="TZS">TZS (Tanzania)</option>
                      <option value="UGX">UGX (Uganda)</option>
                      <option value="RWF">RWF (Rwanda)</option>
                      <option value="ETB">ETB (Ethiopia)</option>
                      <option value="USD">USD (United States)</option>
                      <option value="GBP">GBP (United Kingdom)</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("defaultFooter")}
                    </label>
                    <textarea
                      value={actionStatus.data.defaultFooter || ""}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, defaultFooter: e.target.value },
                        }))
                      }
                      className="input w-full rounded min-h-10"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Document Template Settings */}
            <Card>
              <CardHeader>
                <CardTitle>{t("documentTemplates")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("documentLayout")}
                    </label>
                    <select
                      value={actionStatus.data.documentLayout || "standard"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, documentLayout: e.target.value },
                        }))
                      }
                      className="input"
                    >
                      <option value="standard">Standard</option>
                      <option value="legal">Legal</option>
                      <option value="booklet">Booklet</option>
                      <option value="narrow">Narrow</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("invoiceTemplate")}
                    </label>
                    <select
                      value={actionStatus.data.invoiceTemplate || "standard"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, invoiceTemplate: e.target.value },
                        }))
                      }
                      className="input"
                    >
                      <option value="standard">Standard</option>
                      <option value="detailed">Detailed</option>
                      <option value="minimal">Minimal</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("quotationTemplate")}
                    </label>
                    <select
                      value={actionStatus.data.quotationTemplate || "standard"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, quotationTemplate: e.target.value },
                        }))
                      }
                      className="input"
                    >
                      <option value="standard">Standard</option>
                      <option value="detailed">Detailed</option>
                      <option value="minimal">Minimal</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t("deliveryNoteTemplate")}
                    </label>
                    <select
                      value={actionStatus.data.deliveryNoteTemplate || "standard"}
                      onChange={(e) =>
                        setActionStatus((prev) => ({
                          ...prev,
                          data: { ...prev.data, deliveryNoteTemplate: e.target.value },
                        }))
                      }
                      className="input"
                    >
                      <option value="standard">Standard</option>
                      <option value="comprehensive">Comprehensive</option>
                      <option value="minimal">Minimal</option>
                    </select>
                  </div>
                </div>

                {/* Document Numbering Preferences */}
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground">
                    {t("documentNumbering")}
                  </p>
                  <div className="grid grid-cols-3 gap-4 mt-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("numberingPrefix")}
                      </label>
                      <input
                        value={actionStatus.data.documentNumberingPrefix || ""}
                        onChange={(e) =>
                          setActionStatus((prev) => ({
                            ...prev,
                            data: { ...prev.data, documentNumberingPrefix: e.target.value },
                          }))
                        }
                        className="input w-full"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("numberingPadding")}
                      </label>
                      <select
                        value={actionStatus.data.documentNumberingPadding || 4}
                        onChange={(e) =>
                          setActionStatus((prev) => ({
                            ...prev,
                            data: { ...prev.data, documentNumberingPadding: parseInt(e.target.value) },
                          }))
                        }
                        className="input w-full"
                      >
                        <option value="2">2</option>
                        <option value="3">3</option>
                        <option value="4">4</option>
                        <option value="5">5</option>
                        <option value="6">6</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("periodStyle")}
                      </label>
                      <select
                        value={actionStatus.data.documentPeriodStyle || "CALENDAR_YEAR"}
                        onChange={(e) =>
                          setActionStatus((prev) => ({
                            ...prev,
                            data: { ...prev.data, documentPeriodStyle: e.target.value },
                          }))
                        }
                        className="input w-full"
                      >
                        <option value="CALENDAR_YEAR">Calendar Year</option>
                        <option value="FINANCIAL_YEAR">Financial Year</option>
                        <option value="NONE">No Period</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("fiscalStartMonth")}
                      </label>
                      <select
                        value={actionStatus.data.fiscalStartMonth || 1}
                        onChange={(e) =>
                          setActionStatus((prev) => ({
                            ...prev,
                            data: { ...prev.data, fiscalStartMonth: parseInt(e.target.value) },
                          }))
                        }
                        className="input w-full"
                      >
                        <option value="1">January (1)</option>
                        <option value="2">February (2)</option>
                        <option value="3">March (3)</option>
                        <option value="4">April (4)</option>
                        <option value="5">May (5)</option>
                        <option value="6">June (6)</option>
                        <option value="7">July (7)</option>
                        <option value="8">August (8)</option>
                        <option value="9">September (9)</option>
                        <option value="10">October (10)</option>
                        <option value="11">November (11)</option>
                        <option value="12">December (12)</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("etimsCompatible")}
                      </label>
                      <select
                        value={actionStatus.data.etimsCompatible || false}
                        onChange={(e) =>
                          setActionStatus((prev) => ({
                            ...prev,
                            data: { ...prev.data, etimsCompatible: e.target.value === "true" },
                          }))
                        }
                        className="input w-full"
                      >
                        <option value="false">No eTIMS integration</option>
                        <option value="true">eTIMS compatible</option>
                      </select>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* eTIMS Integration Settings (future) */}
            {actionStatus.data.etimsCompatible && (
              <Card>
                <CardHeader>
                  <CardTitle>{t("eTIMSIntegration")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {t("eTIMSNote")}
                  </p>
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("etimsDocumentType")}
                      </label>
                      <input
                        value={actionStatus.data.etimsDocumentType || ""}
                        onChange={(e) =>
                          setActionStatus((prev) => ({
                            ...prev,
                            data: { ...prev.data, etimsDocumentType: e.target.value },
                          }))
                        }
                        className="input w-full"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("etimsSerialNumber")}
                      </label>
                      <input
                        value={actionStatus.data.etimsSerialNumber || ""}
                        onChange={(e) =>
                          setActionStatus((prev) => ({
                            ...prev,
                            data: { ...prev.data, etimsSerialNumber: e.target.value },
                          }))
                        }
                        className="input w-full"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3 mt-6">
              {/* Cancel button */}
              <Link
                href={`/${locale}/admin/tenants/${tenantId}`}
                className="btn btn-secondary flex-1"
              >
                {t("cancel")}
              </Link>

              {/* Update button */}
              <button
                type="submit"
                disabled={actionStatus.loading}
                className="btn btn-primary flex-1"
              >
                {actionStatus.type === "update" ? t("updating") : t("updateBranding")}
              </button>

              {/* Reset button */}
              {actionStatus.type === "update" && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    handleReset();
                  }}
                  className="btn btn-danger flex-1"
                >
                  {t("resetBranding")}
                </button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Logo Upload Section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("logoUpload")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("logoUploadHelp")}
          </p>

          <div className="mt-3">
            <input
              type="file"
              accept="image/png, image/jpeg, image/webp, svg+xml"
              onChange={(e) => handleLogoChange(e)}
              className="input w-full mb-2"
              disabled={logoUploading}
            />
            {logoFile && (
              <div className="flex items-center gap-3 text-sm">
                <span className="text-primary font-medium">
                  {logoFile.name}
                </span>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    handleLogoRemove();
                  }}
                  className="text-red-600 hover:underline cursor-pointer ml-3"
                >
                  {t("remove")}
                </button>
              </div>
            )}
          </div>

          {logoUploading && (
            <p className="text-primary text-sm mt-2">
              {t("uploading")}
            </p>
          )}

          {actionStatus.error && (
            <p className="text-red-600 text-sm mt-2">{actionStatus.error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Platform auth guard for branding page */
async function _requirePlatformAuth() {
  const { import: requireAuth } = await import("@/lib/auth/helpers");
  return requireAuth();
}