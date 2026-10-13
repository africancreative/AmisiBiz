import { getTranslations } from "next-intl/server";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { AuthShell } from "@/components/layout/auth-shell";

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = await params;
  const { token } = await searchParams;
  const t = await getTranslations("auth.resetPassword");

  return (
    <AuthShell title={t("title")} subtitle={t("subtitle")}>
      <ResetPasswordForm locale={locale} token={token ?? ""} />
    </AuthShell>
  );
}
