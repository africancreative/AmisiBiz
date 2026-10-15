"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { DocumentPreview } from "@/components/platform/document-preview";
import { useProviderActionForm } from "@/components/platform/use-provider-action-form";
import { updateTenantBrandingForTenantAction } from "@/server/actions/platform";
import { DOCUMENT_LAYOUTS } from "@/lib/validations/branding";
import type { TenantBrandingDetail } from "@/lib/admin/tenant-queries";
import {
  CURRENCY_LABELS,
  SUPPORTED_CURRENCIES,
  WCAG_AA_NORMAL_TEXT_RATIO,
  contrastRatio,
  toSupportedCurrency,
} from "@amisibiz/domain";
import type { DocumentType } from "@prisma/client";

/**
 * Provider-side branding configuration (Phase 2 requirement 7).
 *
 * The field set is exactly the set a business admin may set, and the patch goes
 * through the same validated writer, so provider and tenant edits can never
 * produce two different shapes of row — and switching on tenant self-service
 * branding later is a permission change rather than a schema or template change.
 *
 * The logo is uploaded through the provider route, which verifies the file's
 * magic bytes and dimensions — the same classification the tenant route uses —
 * before it stores anything or hands back a URL. The text patch below still
 * cannot set `logoUrl`, so a colour/name/address save can never point a
 * workspace's documents at bytes nobody validated.
 */

type Draft = {
  displayName: string;
  registeredName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  primaryForeground: string;
  contactEmail: string;
  contactPhone: string;
  postalAddress: string;
  physicalAddress: string;
  website: string;
  taxPin: string;
  currency: string;
  defaultFooter: string;
  paymentInstructions: string;
  documentLayout: string;
};

const FALLBACK: Draft = {
  displayName: "",
  registeredName: "",
  primaryColor: "#1d4ed8",
  secondaryColor: "#1e3a5f",
  accentColor: "#f59e0b",
  primaryForeground: "#f8fafc",
  contactEmail: "",
  contactPhone: "",
  postalAddress: "",
  physicalAddress: "",
  website: "",
  taxPin: "",
  currency: "KES",
  defaultFooter: "",
  paymentInstructions: "",
  documentLayout: "standard",
};

function toDraft(branding: TenantBrandingDetail | null): Draft {
  if (!branding) return FALLBACK;

  return {
    displayName: branding.displayName ?? "",
    registeredName: branding.registeredName ?? "",
    // Colours are never cleared, so a stored value is always usable; an unknown
    // string simply falls back rather than reaching the preview as CSS text.
    primaryColor: branding.primaryColor || FALLBACK.primaryColor,
    secondaryColor: branding.secondaryColor || FALLBACK.secondaryColor,
    accentColor: branding.accentColor || FALLBACK.accentColor,
    primaryForeground: branding.primaryForeground || FALLBACK.primaryForeground,
    contactEmail: branding.contactEmail ?? "",
    contactPhone: branding.contactPhone ?? "",
    postalAddress: branding.postalAddress ?? "",
    physicalAddress: branding.physicalAddress ?? "",
    website: branding.website ?? "",
    taxPin: branding.taxPin ?? "",
    currency: branding.currency || FALLBACK.currency,
    defaultFooter: branding.defaultFooter ?? "",
    paymentInstructions: branding.paymentInstructions ?? "",
    documentLayout: DOCUMENT_LAYOUTS.includes(
      branding.documentLayout as (typeof DOCUMENT_LAYOUTS)[number],
    )
      ? branding.documentLayout
      : FALLBACK.documentLayout,
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function TenantBrandingPanel({
  tenantId,
  initial,
  workspaceName,
  sampleNumbers,
}: {
  tenantId: string;
  initial: TenantBrandingDetail | null;
  /** Shown when the workspace has no display name of its own yet. */
  workspaceName: string;
  sampleNumbers: Partial<Record<DocumentType, string>>;
}) {
  const t = useTranslations("admin.branding");
  const tEnums = useTranslations("documentEnums");
  const { pending, error, succeeded, run, fieldError } =
    useProviderActionForm();

  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const router = useRouter();

  // The logo is the one branding value a text patch cannot move, so it is
  // uploaded through the provider route and refreshed into the server-rendered
  // page rather than held in the draft.
  const [logoUrl, setLogoUrl] = useState<string | null>(
    initial?.logoUrl ?? null,
  );
  const [logoPending, setLogoPending] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  // A colour the field has never held a valid value for falls back to the
  // documented default, so a half-typed hex can't blank a saved colour.
  const color = (key: keyof Draft) =>
    HEX.test(draft[key]) ? draft[key] : FALLBACK[key as keyof typeof FALLBACK];

  const update =
    (field: keyof Draft) =>
    (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) =>
      setDraft((prev) => ({ ...prev, [field]: event.target.value }));

  async function onLogoSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    setLogoError(null);
    setLogoPending(true);
    try {
      const body = new FormData();
      body.append("file", file);

      const response = await fetch(`/api/platform/tenants/${tenantId}/logo`, {
        method: "POST",
        body,
      });
      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        data?: { logoUrl?: string };
        error?: string;
      } | null;

      if (!response.ok || !payload?.success || !payload.data?.logoUrl) {
        setLogoError(payload?.error ?? t("logoUploadFailed"));
        return;
      }

      setLogoUrl(payload.data.logoUrl);
      router.refresh();
    } catch {
      setLogoError(t("logoUploadFailed"));
    } finally {
      setLogoPending(false);
      input.value = "";
    }
  }

  const ratio = contrastRatio(
    color("primaryColor"),
    color("primaryForeground"),
  );
  const contrastProblem =
    ratio !== null && ratio < WCAG_AA_NORMAL_TEXT_RATIO
      ? t("contrastWarning", {
          ratio: ratio.toFixed(2),
          min: WCAG_AA_NORMAL_TEXT_RATIO,
        })
      : null;

  // The stored currency may be one this build cannot offer; keep it visible as a
  // disabled option instead of silently rewriting the workspace's currency.
  const currencyOptions = SUPPORTED_CURRENCIES.includes(
    draft.currency as (typeof SUPPORTED_CURRENCIES)[number],
  )
    ? SUPPORTED_CURRENCIES
    : ([draft.currency, ...SUPPORTED_CURRENCIES] as string[]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (contrastProblem) return;

    // Every field is sent: the server patch treats an empty string as "clear this
    // free-text value" and never nulls a colour, currency or layout, so a partial
    // submission could otherwise blank a field this form does display.
    const payload = { tenantId, ...draft };

    await run(() => updateTenantBrandingForTenantAction(payload));
  }

  const textField = (
    field: keyof Draft,
    label: string,
    options: { type?: string; maxLength?: number; textarea?: boolean } = {},
  ) => (
    <div key={field}>
      <label htmlFor={`branding-${field}-${tenantId}`} className="label">
        {label}
      </label>
      {options.textarea ? (
        <textarea
          id={`branding-${field}-${tenantId}`}
          className="input min-h-20 w-full"
          value={draft[field]}
          onChange={update(field)}
          maxLength={options.maxLength}
          disabled={pending}
        />
      ) : (
        <input
          id={`branding-${field}-${tenantId}`}
          className="input"
          type={options.type ?? "text"}
          value={draft[field]}
          onChange={update(field)}
          maxLength={options.maxLength}
          disabled={pending}
        />
      )}
      {fieldError(field) ? (
        <p className="field-error">{fieldError(field)}</p>
      ) : null}
    </div>
  );

  const colorField = (field: keyof Draft, label: string, hint: string) => (
    <div key={field} className="space-y-1.5">
      <label htmlFor={`branding-${field}-${tenantId}`} className="label">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`branding-${field}-${tenantId}`}
          className="input w-32"
          type="text"
          value={draft[field]}
          onChange={update(field)}
          maxLength={7}
          disabled={pending}
        />
        <input
          aria-label={t("colorPicker", { label })}
          className="h-8 w-8 shrink-0 cursor-pointer rounded border border-border p-0"
          type="color"
          value={color(field)}
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, [field]: event.target.value }))
          }
          disabled={pending}
        />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {fieldError(field) ? (
        <p className="field-error">{fieldError(field)}</p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <div className="space-y-3">
          {colorField("primaryColor", t("primaryColor"), t("primaryColorHint"))}
          {colorField(
            "secondaryColor",
            t("secondaryColor"),
            t("secondaryColorHint"),
          )}
          {colorField("accentColor", t("accentColor"), t("accentColorHint"))}
          {colorField(
            "primaryForeground",
            t("primaryForeground"),
            t("primaryForegroundHint"),
          )}
          {contrastProblem ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {contrastProblem}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {textField("displayName", t("displayName"), { maxLength: 100 })}
          {textField("registeredName", t("registeredName"), { maxLength: 200 })}
          {textField("contactEmail", t("contactEmail"), {
            type: "email",
            maxLength: 254,
          })}
          {textField("contactPhone", t("contactPhone"), { maxLength: 50 })}
          {textField("website", t("website"), { maxLength: 254 })}
          {textField("taxPin", t("taxPin"), { maxLength: 50 })}
        </div>

        <div className="grid gap-4">
          {textField("physicalAddress", t("physicalAddress"), {
            maxLength: 500,
            textarea: true,
          })}
          {textField("postalAddress", t("postalAddress"), {
            maxLength: 500,
            textarea: true,
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`branding-currency-${tenantId}`} className="label">
              {t("currency")}
            </label>
            <select
              id={`branding-currency-${tenantId}`}
              className="input"
              value={draft.currency}
              onChange={update("currency")}
              disabled={pending}
            >
              {currencyOptions.map((code) => (
                <option
                  key={code}
                  value={code}
                  disabled={toSupportedCurrency(code) !== code}
                >
                  {CURRENCY_LABELS[
                    code as (typeof SUPPORTED_CURRENCIES)[number]
                  ] ?? code}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("currencyHint")}
            </p>
            {fieldError("currency") ? (
              <p className="field-error">{fieldError("currency")}</p>
            ) : null}
          </div>
          <div>
            <label
              htmlFor={`branding-documentLayout-${tenantId}`}
              className="label"
            >
              {t("documentLayout")}
            </label>
            <select
              id={`branding-documentLayout-${tenantId}`}
              className="input"
              value={draft.documentLayout}
              onChange={update("documentLayout")}
              disabled={pending}
            >
              {DOCUMENT_LAYOUTS.map((layout) => (
                <option key={layout} value={layout}>
                  {tEnums(`layout.${layout}`)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("documentLayoutHint")}
            </p>
          </div>
        </div>

        <div className="grid gap-4">
          {textField("defaultFooter", t("defaultFooter"), {
            maxLength: 1000,
            textarea: true,
          })}
          {textField("paymentInstructions", t("paymentInstructions"), {
            maxLength: 2000,
            textarea: true,
          })}
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <p className="label">{t("logo")}</p>
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="h-10 w-auto max-w-40 object-contain"
              referrerPolicy="no-referrer"
            />
          ) : (
            <p className="text-xs text-muted-foreground">{t("logoEmpty")}</p>
          )}
          <input
            aria-label={t("logoUpload")}
            accept="image/png,image/jpeg,image/webp"
            className="block text-xs file:mr-3 file:rounded file:border file:border-border file:bg-background file:px-2 file:py-1"
            disabled={logoPending}
            onChange={onLogoSelected}
            type="file"
          />
          <p className="text-xs text-muted-foreground">{t("logoHint")}</p>
          {logoPending ? (
            <p className="text-xs text-muted-foreground">
              {t("logoUploading")}
            </p>
          ) : null}
          {logoError ? (
            <p role="alert" className="field-error">
              {logoError}
            </p>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        {succeeded && !error ? (
          <p className="text-sm text-emerald-700">{t("saved")}</p>
        ) : null}

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? t("saving") : t("save")}
        </button>
      </form>

      <div className="border-t border-border pt-6">
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          {t("previewTitle")}
        </h3>
        <DocumentPreview
          branding={{
            displayName: draft.displayName.trim() || workspaceName,
            primaryColor: color("primaryColor"),
            secondaryColor: color("secondaryColor"),
            accentColor: color("accentColor"),
            primaryForeground: color("primaryForeground"),
            logoUrl: logoUrl ?? null,
          }}
          details={{
            contactEmail: draft.contactEmail,
            contactPhone: draft.contactPhone,
            postalAddress: draft.postalAddress,
            physicalAddress: draft.physicalAddress,
            website: draft.website,
            taxPin: draft.taxPin,
            defaultFooter: draft.defaultFooter,
            paymentInstructions: draft.paymentInstructions,
          }}
          currency={draft.currency}
          documentLayout={draft.documentLayout}
          sampleNumbers={sampleNumbers}
        />
      </div>
    </div>
  );
}
