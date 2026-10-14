"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { forgotPasswordAction } from "@/server/actions/auth";

export function ForgotPasswordForm({ locale }: { locale: string }) {
  const t = useTranslations("auth.forgotPassword");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await forgotPasswordAction({ email }, locale);
    setPending(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          {t("success")}
        </p>
        <Link
          href={`/${locale}/login`}
          className="block text-center text-sm font-medium text-brand-700 hover:underline"
        >
          {t("backToLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
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

      <Link
        href={`/${locale}/login`}
        className="block text-center text-sm font-medium text-brand-700 hover:underline"
      >
        {t("backToLogin")}
      </Link>
    </form>
  );
}
