import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { AccessDenied } from "@/components/layout/access-denied";
import { PageHeader } from "@amisibiz/ui/page-header";
import { StatusIndicator } from "@amisibiz/ui/status-indicator";
import { DashboardOverview } from "@/components/dashboard/dashboard-overview";
import { getDashboardOverviewAction } from "@/server/actions/dashboard";
import { PERMISSIONS, tenantRoleHasPermission } from "@amisibiz/auth";

export const dynamic = "force-dynamic";

export default async function WorkspaceOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Requiring `documents.read` gates the whole dashboard: every tenant role that
  // may see business documents also holds contacts and items read, and the
  // customer-portal role holds none of them. A portal user is therefore refused
  // here rather than shown a page of empty counters.
  const state = await getWorkspaceState(locale, PERMISSIONS.DOCUMENTS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const { session, membership, context } = state;
  const tDash = await getTranslations("dashboard");
  const tTeam = await getTranslations("team");

  const { tenant, role } = membership;

  const overviewResult = await getDashboardOverviewAction(tenant.id);

  const canCreateDocument =
    tenantRoleHasPermission(role, PERMISSIONS.QUOTATIONS_CREATE) ||
    tenantRoleHasPermission(role, PERMISSIONS.INVOICES_CREATE) ||
    tenantRoleHasPermission(role, PERMISSIONS.DELIVERY_NOTES_CREATE);

  return (
    <div className="space-y-6">
      <PageHeader
        title={tDash("welcome", {
          name: session.user.name ?? session.user.email ?? "",
        })}
        description={`${tenant.name} · ${tTeam(`roles.${role}`)}`}
        actions={
          <StatusIndicator
            tone={tenant.status === "ACTIVE" ? "success" : "warning"}
          >
            {tenant.status}
          </StatusIndicator>
        }
      />

      {overviewResult.success && overviewResult.data ? (
        <DashboardOverview
          locale={locale}
          roleLabel={tTeam(`roles.${role}`)}
          readonly={context.readonly}
          canCreateDocument={canCreateDocument}
          tenant={{
            name: tenant.name,
            slug: tenant.slug,
            status: tenant.status,
            currency: tenant.currency,
            timezone: tenant.timezone,
            locale: tenant.locale,
          }}
          data={overviewResult.data}
        />
      ) : null}

      {!overviewResult.success ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {overviewResult.error}
        </p>
      ) : null}
    </div>
  );
}
