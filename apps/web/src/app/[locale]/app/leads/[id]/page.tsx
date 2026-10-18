import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS, tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { LeadDetailClient } from "./lead-detail-client";

export const dynamic = "force-dynamic";

interface LeadDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
}

export default async function LeadDetailPage({ params }: LeadDetailPageProps) {
  const { locale, id } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.LEADS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const role = state.context.role;

  return (
    <LeadDetailClient
      locale={locale}
      tenantId={state.membership.tenantId}
      leadId={id}
      readonly={state.readonly}
      canUpdate={tenantRoleHasPermission(role, PERMISSIONS.LEADS_UPDATE)}
      canConvert={tenantRoleHasPermission(role, PERMISSIONS.LEADS_CONVERT)}
      canReadTasks={tenantRoleHasPermission(role, PERMISSIONS.TASKS_READ)}
      canManageTasks={tenantRoleHasPermission(role, PERMISSIONS.TASKS_MANAGE)}
      canReadTimeline={tenantRoleHasPermission(
        role,
        PERMISSIONS.ACTIVITIES_READ,
      )}
      canViewPipelines={tenantRoleHasPermission(
        role,
        PERMISSIONS.PIPELINES_READ,
      )}
      canReadDocuments={tenantRoleHasPermission(
        role,
        PERMISSIONS.DOCUMENTS_READ,
      )}
    />
  );
}
