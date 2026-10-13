"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { resetPasswordAction } from "@/server/actions/auth";

export function ResetPasswordForm({
  locale,
  token,
}: {
  locale: string;
  token: string;
}) {
  const t = useTranslations("auth.resetPassword");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await resetPasswordAction({
      token,
      password,
      confirmPassword,
    });
    setPending(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    setDone(true);
  }

  if (!token) {
    return (
      <div className="space-y-4">
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {t("invalidToken")}
        </p>
        <Link
          href={`/${locale}/forgot-password`}
          className="block text-center text-sm font-medium text-brand-700 hover:underline"
        >
          {t("backToLogin")}
        </Link>
      </div>
    );
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
        <label htmlFor="password" className="label">
          {t("passwordLabel")}
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="confirmPassword" className="label">
          {t("confirmPasswordLabel")}
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          className="input"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
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
