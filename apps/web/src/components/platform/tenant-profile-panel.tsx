"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { updateTenantProfileAction } from "@/server/actions/platform";
import { useProviderActionForm } from "@/components/platform/use-provider-action-form";

type ProfileValues = {
  name: string;
  country: string;
  currency: string;
  timezone: string;
  locale: string;
};

/**
 * Provider-side workspace profile (name, country, currency, timezone, locale).
 *
 * Only the fields the operator actually filled in are sent: every field in
 * `platformUpdateTenantSchema` is optional precisely so a partial patch can never
 * blank a value the form did not display. The workspace's business data is not
 * reachable from here — this panel edits configuration columns on the tenant row
 * and nothing else.
 */
export function TenantProfilePanel({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: ProfileValues;
}) {
  const t = useTranslations("admin.profile");
  const { pending, error, succeeded, run, fieldError } =
    useProviderActionForm();
  const [form, setForm] = useState<ProfileValues>(initial);

  function update(field: keyof ProfileValues) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const payload: Record<string, string> = { tenantId };
    for (const [field, value] of Object.entries(form)) {
      const trimmed = value.trim();
      if (trimmed.length > 0) payload[field] = trimmed;
    }

    await run(() => updateTenantProfileAction(payload));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor={`profile-name-${tenantId}`} className="label">
          {t("name")}
        </label>
        <input
          id={`profile-name-${tenantId}`}
          className="input"
          value={form.name}
          onChange={update("name")}
          maxLength={100}
        />
        {fieldError("name") ? (
          <p className="field-error">{fieldError("name")}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`profile-country-${tenantId}`} className="label">
            {t("country")}
          </label>
          <input
            id={`profile-country-${tenantId}`}
            className="input"
            value={form.country}
            onChange={update("country")}
            placeholder={t("countryPlaceholder")}
            maxLength={2}
          />
          {fieldError("country") ? (
            <p className="field-error">{fieldError("country")}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor={`profile-currency-${tenantId}`} className="label">
            {t("currency")}
          </label>
          <input
            id={`profile-currency-${tenantId}`}
            className="input"
            value={form.currency}
            onChange={update("currency")}
            maxLength={3}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t("currencyHint")}
          </p>
          {fieldError("currency") ? (
            <p className="field-error">{fieldError("currency")}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor={`profile-timezone-${tenantId}`} className="label">
            {t("timezone")}
          </label>
          <input
            id={`profile-timezone-${tenantId}`}
            className="input"
            value={form.timezone}
            onChange={update("timezone")}
            maxLength={64}
          />
          {fieldError("timezone") ? (
            <p className="field-error">{fieldError("timezone")}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor={`profile-locale-${tenantId}`} className="label">
            {t("locale")}
          </label>
          <select
            id={`profile-locale-${tenantId}`}
            className="input"
            value={form.locale}
            onChange={update("locale")}
          >
            {["en", "fr", "sw"].map((value) => (
              <option key={value} value={value}>
                {t(`localeNames.${value}`)}
              </option>
            ))}
          </select>
        </div>
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
  );
}
