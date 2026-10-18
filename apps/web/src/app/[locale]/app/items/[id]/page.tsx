import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS, tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { ItemDetailClient } from "./item-detail-client";

export const dynamic = "force-dynamic";

interface ItemDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
}

/**
 * Product detail (`/app/items/[id]`) — the catalogue surface that owns images,
 * variants and this item's share links (AGENT 02 module B).
 *
 * The gate is `ITEMS_READ`, the same permission `getItemAction` demands; the id
 * in the path is only ever a locator, and the action re-checks it against the
 * authorized tenant, so a foreign or malformed uuid renders "not found" rather
 * than another workspace's row.
 */
export default async function ItemDetailPage({ params }: ItemDetailPageProps) {
  const { locale, id } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.ITEMS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const role = state.context.role;

  return (
    <ItemDetailClient
      locale={locale}
      tenantId={state.membership.tenantId}
      itemId={id}
      readonly={state.readonly}
      canCreate={tenantRoleHasPermission(role, PERMISSIONS.ITEMS_CREATE)}
      canUpdate={tenantRoleHasPermission(role, PERMISSIONS.ITEMS_UPDATE)}
      canDelete={tenantRoleHasPermission(role, PERMISSIONS.ITEMS_DELETE)}
      canShareRead={tenantRoleHasPermission(role, PERMISSIONS.SHARE_LINKS_READ)}
      canShareManage={tenantRoleHasPermission(
        role,
        PERMISSIONS.SHARE_LINKS_MANAGE,
      )}
    />
  );
}
