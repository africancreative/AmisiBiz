import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { PageHeader } from "@amisibiz/ui/page-header";
import { AuditLogViewer } from "@/components/audit/audit-log-viewer";

export const dynamic = "force-dynamic";

/**
 * Tenant audit viewer (`/app/settings/audit`).
 *
 * Gated by `audit.read`, which only TENANT_OWNER and TENANT_ADMIN hold (and a
 * provider support grant, holding it read-only). The page guard is the same
 * `getWorkspaceState(locale, permission)` every other settings page uses, so a
 * denied member sees the standard `AccessDenied` and the read action
 * re-authorizes independently on every fetch.
 */
export default async function AuditPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.AUDIT_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const t = await getTranslations("audit");

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <AuditLogViewer
        source="tenant"
        tenantId={state.membership.tenantId}
        locale={locale}
      />
    </div>
  );
}
