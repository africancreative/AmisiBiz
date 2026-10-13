"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createTenantAction } from "@/server/actions/platform";

type FieldErrors = Record<string, string[]>;

export function CreateTenantForm({ locale }: { locale: string }) {
  const t = useTranslations("admin.create");
  const router = useRouter();

  const [form, setForm] = useState({
    name: "",
    slug: "",
    ownerEmail: "",
    currency: "USD",
    timezone: "UTC",
    locale: "en",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function update(field: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});

    const payload = {
      name: form.name,
      currency: form.currency,
      timezone: form.timezone,
      locale: form.locale,
      ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
      ...(form.ownerEmail.trim() ? { ownerEmail: form.ownerEmail.trim() } : {}),
    };

    const result = await createTenantAction(payload);
    if (!result.success) {
      setError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
      setPending(false);
      return;
    }

    router.push(`/${locale}/admin/tenants/${result.data?.tenantId ?? ""}`);
    router.refresh();
  }

  function renderError(field: string) {
    const messages = fieldErrors[field];
    if (!messages || messages.length === 0) return null;
    return <p className="field-error">{messages[0]}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4" noValidate>
      <div>
        <label htmlFor="ct-name" className="label">
          {t("fieldName")}
        </label>
        <input
          id="ct-name"
          className="input"
          required
          value={form.name}
          onChange={update("name")}
        />
        {renderError("name")}
      </div>

      <div>
        <label htmlFor="ct-slug" className="label">
          {t("fieldSlug")}
        </label>
        <input
          id="ct-slug"
          className="input"
          value={form.slug}
          onChange={update("slug")}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t("fieldSlugHint")}
        </p>
        {renderError("slug")}
      </div>

      <div>
        <label htmlFor="ct-owner" className="label">
          {t("fieldOwnerEmail")}
        </label>
        <input
          id="ct-owner"
          type="email"
          className="input"
          value={form.ownerEmail}
          onChange={update("ownerEmail")}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t("fieldOwnerHint")}
        </p>
        {renderError("ownerEmail")}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="ct-currency" className="label">
            {t("fieldCurrency")}
          </label>
          <select
            id="ct-currency"
            className="input"
            value={form.currency}
            onChange={update("currency")}
          >
            {["USD", "EUR", "GBP", "KES", "TZS", "NGN"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ct-timezone" className="label">
            {t("fieldTimezone")}
          </label>
          <input
            id="ct-timezone"
            className="input"
            value={form.timezone}
            onChange={update("timezone")}
          />
        </div>
        <div>
          <label htmlFor="ct-locale" className="label">
            {t("fieldLocale")}
          </label>
          <select
            id="ct-locale"
            className="input"
            value={form.locale}
            onChange={update("locale")}
          >
            {["en", "fr", "sw"].map((l) => (
              <option key={l} value={l}>
                {l}
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

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? t("creating") : t("createSubmit")}
      </button>
    </form>
  );
}
