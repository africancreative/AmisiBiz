"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { registerAction } from "@/server/actions/auth";

type FieldErrors = Record<string, string[]>;

export function RegisterForm({ locale }: { locale: string }) {
  const t = useTranslations("auth.register");
  const router = useRouter();

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    tenantName: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [awaitingEmailConfirmation, setAwaitingEmailConfirmation] =
    useState(false);

  function update(field: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});

    const result = await registerAction(form, locale);

    if (!result.success) {
      setError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
      setPending(false);
      return;
    }

    if (result.data?.emailConfirmationRequired) {
      // Email confirmation is enabled: no session exists yet. Show the
      // "check your email" state instead of navigating.
      setAwaitingEmailConfirmation(true);
      setPending(false);
      return;
    }

    // The registration action established the session server-side; go to the
    // workspace dashboard.
    router.push(`/${locale}/dashboard`);
    router.refresh();
  }

  if (awaitingEmailConfirmation) {
    return (
      <div className="space-y-4">
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          <strong className="block font-semibold">
            {t("checkEmailTitle")}
          </strong>
          {t("checkEmailSubtitle")}
        </p>
        <Link
          href={`/${locale}/login`}
          className="block text-center text-sm font-medium text-brand-700 hover:underline"
        >
          {t("loginLink")}
        </Link>
      </div>
    );
  }

  function renderError(field: keyof typeof form) {
    const messages = fieldErrors[field];
    if (!messages || messages.length === 0) return null;
    return <p className="field-error">{messages[0]}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="name" className="label">
          {t("nameLabel")}
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          className="input"
          placeholder={t("namePlaceholder")}
          value={form.name}
          onChange={update("name")}
        />
        {renderError("name")}
      </div>

      <div>
        <label htmlFor="tenantName" className="label">
          {t("tenantNameLabel")}
        </label>
        <input
          id="tenantName"
          name="tenantName"
          type="text"
          required
          className="input"
          placeholder={t("tenantNamePlaceholder")}
          value={form.tenantName}
          onChange={update("tenantName")}
        />
        {renderError("tenantName")}
      </div>

      <div>
        <label htmlFor="email" className="label">
          {t("emailLabel")}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="input"
          placeholder={t("emailPlaceholder")}
          value={form.email}
          onChange={update("email")}
        />
        {renderError("email")}
      </div>

      <div>
        <label htmlFor="password" className="label">
          {t("passwordLabel")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          className="input"
          placeholder={t("passwordPlaceholder")}
          value={form.password}
          onChange={update("password")}
        />
        {renderError("password")}
      </div>

      <div>
        <label htmlFor="confirmPassword" className="label">
          {t("confirmPasswordLabel")}
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          className="input"
          value={form.confirmPassword}
          onChange={update("confirmPassword")}
        />
        {renderError("confirmPassword")}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="btn btn-primary w-full"
        disabled={pending}
      >
        {pending ? t("submitting") : t("submit")}
      </button>

      <p className="text-xs text-slate-500">{t("terms")}</p>

      <p className="text-center text-sm text-slate-600">
        {t("hasAccount")}{" "}
        <Link
          href={`/${locale}/login`}
          className="font-medium text-brand-700 hover:underline"
        >
          {t("loginLink")}
        </Link>
      </p>
    </form>
  );
}
