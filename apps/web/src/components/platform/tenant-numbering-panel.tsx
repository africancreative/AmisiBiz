"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { updateTenantNumberingAction } from "@/server/actions/platform";
import { useProviderActionForm } from "@/components/platform/use-provider-action-form";

type SeriesType = "QUOTATION" | "INVOICE" | "DELIVERY_NOTE";
type PeriodStyle = "NONE" | "CALENDAR_YEAR" | "FINANCIAL_YEAR";
type Separator = "-" | "/" | "_" | ".";

export type NumberingSeries = {
  type: SeriesType;
  prefix: string;
  padding: number;
  separator: string;
  periodStyle: string;
  fiscalStartMonth: number;
};

type Draft = {
  prefix: string;
  padding: string;
  separator: Separator;
  periodStyle: PeriodStyle;
  fiscalStartMonth: string;
};

const TYPES: readonly SeriesType[] = ["QUOTATION", "INVOICE", "DELIVERY_NOTE"];
const SEPARATORS: readonly Separator[] = ["-", "/", "_", "."];
const PERIOD_STYLES: readonly PeriodStyle[] = [
  "NONE",
  "CALENDAR_YEAR",
  "FINANCIAL_YEAR",
];

const DEFAULTS: Record<SeriesType, Draft> = {
  QUOTATION: {
    prefix: "QTN",
    padding: "4",
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: "1",
  },
  INVOICE: {
    prefix: "INV",
    padding: "4",
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: "1",
  },
  DELIVERY_NOTE: {
    prefix: "DN",
    padding: "4",
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: "1",
  },
};

function toDraft(series: NumberingSeries | undefined): Draft {
  if (!series) return DEFAULTS.INVOICE;
  return {
    prefix: series.prefix,
    padding: String(series.padding),
    separator: (SEPARATORS as readonly string[]).includes(series.separator)
      ? (series.separator as Separator)
      : "-",
    periodStyle: (PERIOD_STYLES as readonly string[]).includes(
      series.periodStyle,
    )
      ? (series.periodStyle as PeriodStyle)
      : "CALENDAR_YEAR",
    fiscalStartMonth: String(series.fiscalStartMonth),
  };
}

/**
 * Document numbering configuration (part of Phase 2 requirement 7).
 *
 * This edits the *series* only. A document that was already issued keeps the
 * number it was given — numbers are immutable snapshots allocated from the
 * counter table — and no counter is advanced, reset or deleted here, so changing
 * a prefix never renumbers a business's history and never reuses a number.
 */
export function TenantNumberingPanel({
  tenantId,
  series,
}: {
  tenantId: string;
  series: NumberingSeries[];
}) {
  const t = useTranslations("admin.numbering");
  const te = useTranslations("documentEnums");
  const { pending, error, succeeded, run, fieldError } =
    useProviderActionForm();

  const [drafts, setDrafts] = useState<Record<SeriesType, Draft>>(() => ({
    QUOTATION: toDraft(series.find((row) => row.type === "QUOTATION")),
    INVOICE: toDraft(series.find((row) => row.type === "INVOICE")),
    DELIVERY_NOTE: toDraft(series.find((row) => row.type === "DELIVERY_NOTE")),
  }));

  function update(type: SeriesType, field: keyof Draft) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setDrafts((prev) => ({
        ...prev,
        [type]: { ...prev[type], [field]: event.target.value },
      }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await run(() =>
      updateTenantNumberingAction({
        tenantId,
        series: TYPES.map((type) => ({
          type,
          prefix: drafts[type].prefix.trim(),
          padding: Number(drafts[type].padding),
          separator: drafts[type].separator,
          periodStyle: drafts[type].periodStyle,
          fiscalStartMonth: Number(drafts[type].fiscalStartMonth) || 1,
        })),
      }),
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {TYPES.map((type) => {
        const draft = drafts[type];
        return (
          <fieldset
            key={type}
            className="space-y-3 border-t border-border pt-4"
          >
            <legend className="text-sm font-medium text-foreground">
              {te(`type.${type}`)}
            </legend>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`prefix-${tenantId}-${type}`} className="label">
                  {t("prefix")}
                </label>
                <input
                  id={`prefix-${tenantId}-${type}`}
                  className="input"
                  value={draft.prefix}
                  onChange={update(type, "prefix")}
                  maxLength={12}
                />
                {fieldError(`series.${type}.prefix`) ? (
                  <p className="field-error">
                    {fieldError(`series.${type}.prefix`)}
                  </p>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor={`padding-${tenantId}-${type}`}
                  className="label"
                >
                  {t("padding")}
                </label>
                <input
                  id={`padding-${tenantId}-${type}`}
                  className="input"
                  type="number"
                  min={3}
                  max={10}
                  value={draft.padding}
                  onChange={update(type, "padding")}
                />
              </div>
              <div>
                <label
                  htmlFor={`separator-${tenantId}-${type}`}
                  className="label"
                >
                  {t("separator")}
                </label>
                <select
                  id={`separator-${tenantId}-${type}`}
                  className="input"
                  value={draft.separator}
                  onChange={update(type, "separator")}
                >
                  {SEPARATORS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`period-${tenantId}-${type}`} className="label">
                  {t("periodStyle")}
                </label>
                <select
                  id={`period-${tenantId}-${type}`}
                  className="input"
                  value={draft.periodStyle}
                  onChange={update(type, "periodStyle")}
                >
                  {PERIOD_STYLES.map((value) => (
                    <option key={value} value={value}>
                      {te(`periodStyle.${value}`)}
                    </option>
                  ))}
                </select>
              </div>
              {draft.periodStyle === "FINANCIAL_YEAR" ? (
                <div>
                  <label
                    htmlFor={`fiscal-${tenantId}-${type}`}
                    className="label"
                  >
                    {t("fiscalStartMonth")}
                  </label>
                  <input
                    id={`fiscal-${tenantId}-${type}`}
                    className="input"
                    type="number"
                    min={1}
                    max={12}
                    value={draft.fiscalStartMonth}
                    onChange={update(type, "fiscalStartMonth")}
                  />
                </div>
              ) : null}
            </div>

            <p className="text-xs text-muted-foreground">
              {t("example", {
                prefix: draft.prefix || "—",
                separator: draft.separator,
                padding: draft.padding,
              })}
            </p>
          </fieldset>
        );
      })}

      <p className="text-xs text-muted-foreground">{t("immutabilityNote")}</p>

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
  );
}
