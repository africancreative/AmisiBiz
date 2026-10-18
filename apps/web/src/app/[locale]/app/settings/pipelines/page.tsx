import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS, tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { PipelinesClient } from "./pipelines-client";

export const dynamic = "force-dynamic";

interface PipelinesPageProps {
  params: Promise<{ locale: string }>;
}

export default async function PipelinesPage({ params }: PipelinesPageProps) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.PIPELINES_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const t = await getTranslations("crm.pipelines");
  const role = state.context.role;

  return (
    <PipelinesClient
      tenantId={state.membership.tenantId}
      readonly={state.readonly}
      canManage={tenantRoleHasPermission(role, PERMISSIONS.PIPELINES_MANAGE)}
      canViewLeads={tenantRoleHasPermission(role, PERMISSIONS.LEADS_READ)}
      locale={locale}
      title={t("title")}
      description={t("description")}
    />
  );
}
