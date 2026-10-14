import { getTranslations } from "next-intl/server";
import { RegisterForm } from "@/components/auth/register-form";
import { AuthShell } from "@/components/layout/auth-shell";

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("auth.register");

  return (
    <AuthShell title={t("title")} subtitle={t("subtitle")}>
      <RegisterForm locale={locale} />
    </AuthShell>
  );
}
