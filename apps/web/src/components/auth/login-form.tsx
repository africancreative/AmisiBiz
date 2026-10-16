"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { loginAction } from "@/server/actions/auth";

export function LoginForm({ locale }: { locale: string }) {
  const t = useTranslations("auth.login");
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    searchParams.get("error") === "link_expired"
      ? t("error.linkExpired")
      : null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    // Credentials go straight to the server action — the browser never holds
    // a Supabase client or session token (cookies are httpOnly).
    const result = await loginAction({ email, password });

    if (!result.success) {
      setError(result.error || t("error.generic"));
      setPending(false);
      return;
    }

    // Only honour callback URLs that stay within this locale's routes to
    // prevent open-redirect abuse.
    const callbackUrl = searchParams.get("callbackUrl");
    const defaultTarget =
      result.data?.platformRole === "SUPER_ADMIN"
        ? `/${locale}/admin`
        : `/${locale}/dashboard`;
    const target =
      callbackUrl && callbackUrl.startsWith(`/${locale}/`)
        ? callbackUrl
        : defaultTarget;

    router.push(target);
    router.refresh();
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
          placeholder={t("emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label htmlFor="password" className="label">
            {t("passwordLabel")}
          </label>
          <Link
            href={`/${locale}/forgot-password`}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            {t("forgotPassword")}
          </Link>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input"
          placeholder={t("passwordPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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

      <p className="text-center text-sm text-slate-600">
        {t("noAccount")}{" "}
        <Link
          href={`/${locale}/register`}
          className="font-medium text-brand-700 hover:underline"
        >
          {t("registerLink")}
        </Link>
      </p>
    </form>
  );
}
