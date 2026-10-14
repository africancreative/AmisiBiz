"use client";

import { useLocale, useTranslations } from "next-intl";
import { TenantTheme } from "@/components/branding/tenant-theme";
import type { TenantBranding } from "@/lib/branding/tokens";
import type { DocumentType } from "@prisma/client";

/**
 * Branding preview shells for quotations, invoices and delivery notes.
 *
 * These are shells, not documents. They render the tenant's saved (or in-form)
 * branding tokens, business details and configured numbering *shape* against
 * clearly labelled placeholder content, so a provider can see that the branding
 * they just set actually reaches a document before Phase 05 produces real ones.
 *
 * Two things this deliberately does not claim:
 *  - it is not a PDF, and no document, number or total here has been issued;
 *  - no tax is computed. Tax categories belong to the document phase, and an
 *    ordinary AmisiBiz document is never presented as a KRA/eTIMS tax invoice.
 */

const SHELLS: readonly {
  type: DocumentType;
  metaKey: "validUntil" | "dueOn" | "deliveredOn";
  showsPrice: boolean;
}[] = [
  { type: "QUOTATION", metaKey: "validUntil", showsPrice: true },
  { type: "INVOICE", metaKey: "dueOn", showsPrice: true },
  { type: "DELIVERY_NOTE", metaKey: "deliveredOn", showsPrice: false },
];

/** The free-text business details a document letterhead reads. */
export type DocumentPreviewDetails = {
  contactEmail?: string | null;
  contactPhone?: string | null;
  postalAddress?: string | null;
  physicalAddress?: string | null;
  website?: string | null;
  taxPin?: string | null;
  defaultFooter?: string | null;
  paymentInstructions?: string | null;
};

const PLACEHOLDER_UNIT_PRICE = 2500;
const PLACEHOLDER_QUANTITY = 2;

/**
 * Formatting is best-effort on purpose: the figure is a placeholder, so an
 * unfamiliar currency code must degrade to `<CODE> 2,500.00` rather than throw
 * in the middle of an admin page.
 */
function formatAmount(value: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

const EMPTY_DASH = "—";

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-tenant-foreground/70">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function Shell({
  type,
  metaKey,
  showsPrice,
  branding,
  details,
  currency,
  documentLayout,
  sampleNumber,
  locale,
}: {
  type: DocumentType;
  metaKey: "validUntil" | "dueOn" | "deliveredOn";
  showsPrice: boolean;
  branding: TenantBranding;
  details: DocumentPreviewDetails;
  currency: string;
  documentLayout: string;
  sampleNumber: string | null;
  locale: string;
}) {
  const t = useTranslations("admin.preview");
  const tEnums = useTranslations("documentEnums");

  const compact = documentLayout === "compact";
  const detailed = documentLayout === "detailed";

  const lines = [
    {
      description: t("sampleItem"),
      quantity: PLACEHOLDER_QUANTITY,
    },
  ];
  if (detailed) {
    lines.push({
      description: t("sampleItemTwo"),
      quantity: 1,
    });
  }

  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * PLACEHOLDER_UNIT_PRICE,
    0,
  );

  return (
    <TenantTheme
      branding={branding}
      className="overflow-hidden rounded-lg border border-border"
    >
      <div
        className={`flex flex-col gap-4 bg-tenant text-tenant-foreground ${
          compact ? "p-4" : "p-5"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {branding.logoUrl ? (
              // Plain <img> on purpose: logoUrl is the same-origin, tenant- and
              // signature-checked branding route, never an arbitrary host.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.logoUrl}
                alt=""
                className="mb-2 h-8 w-auto max-w-32 object-contain"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <p className="truncate text-sm font-semibold">
              {branding.displayName || EMPTY_DASH}
            </p>
            <p className="text-xs text-tenant-foreground/80">
              {tEnums(`type.${type}`)}
            </p>
          </div>
          <span className="shrink-0 rounded bg-tenant-secondary px-2 py-1 text-xs font-semibold text-tenant-foreground">
            {t("placeholderTag")}
          </span>
        </div>

        <div className="space-y-1 border-t border-tenant-foreground/20 pt-3">
          <MetaRow
            label={t("documentNumber")}
            value={sampleNumber ?? t("numberNotConfigured")}
          />
          <MetaRow label={t("customer")} value={t("sampleCustomer")} />
          <MetaRow label={t("issuedOn")} value={t("sampleDate")} />
          <MetaRow label={t(metaKey)} value={t("sampleDate")} />
        </div>

        <div className="space-y-1 text-xs text-tenant-foreground/90">
          {details.physicalAddress ? (
            <p className="break-words">{details.physicalAddress}</p>
          ) : null}
          {details.postalAddress ? (
            <p className="break-words">{details.postalAddress}</p>
          ) : null}
          {!details.physicalAddress && !details.postalAddress ? (
            <p className="italic opacity-70">{t("noAddress")}</p>
          ) : null}
          <p className="break-words">
            {[details.contactEmail, details.contactPhone]
              .filter((value): value is string => Boolean(value))
              .join(" · ") || t("noContact")}
          </p>
          {details.taxPin ? (
            <p>{t("taxPin", { value: details.taxPin })}</p>
          ) : null}
        </div>

        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-tenant-foreground/20 font-semibold">
              <th className="py-1 pr-2">{t("description")}</th>
              <th className="py-1 pr-2 text-right">{t("quantity")}</th>
              <th className="py-1 pr-2">{t("unit")}</th>
              {showsPrice ? (
                <th className="py-1 text-right">{t("amount")}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.description}
                className="border-b border-dashed border-tenant-foreground/15"
              >
                <td className="py-1.5 pr-2 align-top break-words">
                  {line.description}
                </td>
                <td className="py-1.5 pr-2 text-right align-top">
                  {showsPrice
                    ? line.quantity
                    : t("deliveredOf", {
                        delivered: line.quantity,
                        ordered: line.quantity,
                      })}
                </td>
                <td className="py-1.5 pr-2 align-top">{t("sampleUnit")}</td>
                {showsPrice ? (
                  <td className="py-1.5 text-right align-top">
                    {formatAmount(
                      line.quantity * PLACEHOLDER_UNIT_PRICE,
                      currency,
                      locale,
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>

        {showsPrice ? (
          <div className="space-y-1 text-right text-xs">
            <p>
              {t("subtotal")}:{" "}
              <span className="font-semibold">
                {formatAmount(subtotal, currency, locale)}
              </span>
            </p>
            <p className="text-tenant-foreground/70">{t("noTaxInPreview")}</p>
          </div>
        ) : (
          <p className="text-xs text-tenant-foreground/80">
            {t("deliverySignatureNote")}
          </p>
        )}

        {details.paymentInstructions ? (
          <p className="break-words text-xs text-tenant-foreground/80">
            {details.paymentInstructions}
          </p>
        ) : null}

        <div className="flex items-end justify-between gap-4 border-t border-tenant-foreground/20 pt-3">
          <p className="text-xs text-tenant-foreground/70">
            {details.defaultFooter || EMPTY_DASH}
          </p>
          <span className="text-[10px] uppercase tracking-wide text-tenant-foreground/60">
            {t("layout", { layout: tEnums(`layout.${documentLayout}`) })}
          </span>
        </div>
      </div>
    </TenantTheme>
  );
}

export function DocumentPreview({
  branding,
  details,
  currency,
  documentLayout,
  sampleNumbers,
}: {
  branding: TenantBranding;
  details: DocumentPreviewDetails;
  currency: string;
  documentLayout: string;
  sampleNumbers: Partial<Record<DocumentType, string>>;
}) {
  const t = useTranslations("admin.preview");
  const locale = useLocale();

  return (
    <div className="space-y-3">
      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
        {t("placeholderNote")}
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        {SHELLS.map((shell) => (
          <Shell
            key={shell.type}
            type={shell.type}
            metaKey={shell.metaKey}
            showsPrice={shell.showsPrice}
            branding={branding}
            details={details}
            currency={currency}
            documentLayout={documentLayout}
            sampleNumber={sampleNumbers[shell.type] ?? null}
            locale={locale}
          />
        ))}
      </div>
    </div>
  );
}
