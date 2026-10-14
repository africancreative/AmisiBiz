import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { PageHeader } from "@amisibiz/ui/page-header";
import { BrandingForm } from "@/components/branding/branding-page";

export const dynamic = "force-dynamic";

export default async function BrandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getWorkspaceState(
    locale,
    PERMISSIONS.BUSINESS_SETTINGS_READ,
  );
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const t = await getTranslations("branding");

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <BrandingForm tenantId={state.membership.tenantId} />
    </div>
  );
}
