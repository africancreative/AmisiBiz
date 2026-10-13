import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { verifyEmailAction } from "@/server/actions/auth";
import { AuthShell } from "@/components/layout/auth-shell";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = await params;
  const { token } = await searchParams;
  const t = await getTranslations("auth.verifyEmail");

  const result = token
    ? await verifyEmailAction({ token })
    : ({ success: false, error: "" } as const);

  return (
    <AuthShell title={t("title")}>
      <div className="space-y-4 text-center">
        {result.success ? (
          <Alert tone="success">{t("success")}</Alert>
        ) : (
          <Alert tone="danger">{t("error")}</Alert>
        )}
        <Link
          href={`/${locale}/login`}
          className="inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          {t("backToLogin")}
        </Link>
      </div>
    </AuthShell>
  );
}
