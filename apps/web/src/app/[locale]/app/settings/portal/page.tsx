import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS, tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { PageHeader } from "@amisibiz/ui/page-header";
import { Alert } from "@amisibiz/ui/alert";
import { PortalAccessClient } from "@/components/portal/portal-access-client";

export const dynamic = "force-dynamic";

/**
 * Customer portal access management (`/app/settings/portal`).
 *
 * The guard is deliberately two-part. `getWorkspaceState` is called WITHOUT a
 * permission so that a suspended workspace reaches this component instead of the
 * generic denial the layout would render: the owner still needs to see which of
 * their customers hold a login, and the difference between "not your page" and
 * "your page, paused" is worth a sentence. The authorization that actually
 * matters is inside the Server Actions, which all ask for
 * `PERMISSIONS.PORTAL_ACCESS_MANAGE` — a write permission, so
 * `authorizeTenant` refuses them for a suspended workspace, for a provider
 * support grant, and for every tenant role except owner and admin.
 */
export default async function PortalAccessPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  if (
    !tenantRoleHasPermission(
      state.context.role,
      PERMISSIONS.PORTAL_ACCESS_MANAGE,
    )
  ) {
    return <AccessDenied />;
  }

  const t = await getTranslations("portalAccess");

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      {state.readonly ? (
        // Nothing is fetched for a suspended workspace: the read action asks for
        // the same manage permission as the writes, and a suspended tenant has
        // none of them. This is the explanation, not a degraded screen.
        <Alert tone="warning" title={t("suspendedTitle")}>
          {t("suspendedDescription")}
        </Alert>
      ) : (
        <PortalAccessClient tenantId={state.membership.tenantId} />
      )}
    </div>
  );
}
