import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { AuthShell } from "@/components/layout/auth-shell";
import { getSessionUser } from "@/lib/auth/session-user";

export const dynamic = "force-dynamic";

/**
 * Password-recovery page. The user arrives here only after `/auth/callback`
 * has exchanged the email link for a signed-in recovery session; without one
 * (expired link, already-used link) we show the invalid-link state instead of
 * a form the action would reject anyway.
 */
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("auth.resetPassword");
  const user = await getSessionUser();

  return (
    <AuthShell title={t("title")} subtitle={t("subtitle")}>
      {user ? (
        <ResetPasswordForm locale={locale} />
      ) : (
        <div className="space-y-4">
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {t("invalidToken")}
          </p>
          <Link
            href={`/${locale}/forgot-password`}
            className="block text-center text-sm font-medium text-brand-700 hover:underline"
          >
            {t("backToLogin")}
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
