import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { tenantRoleHasPermission } from "@/lib/auth/permissions";
import { AccessDenied } from "@/components/layout/access-denied";
import { ItemsClient } from "./items-client";

export const dynamic = "force-dynamic";

interface ItemsPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    page?: string;
    search?: string;
    type?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: string;
  }>;
}

export default async function ItemsPage({
  params,
  searchParams,
}: ItemsPageProps) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.ITEMS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const resolvedSearchParams = await searchParams;
  const page = parseInt(resolvedSearchParams.page || "1", 10);
  const search = resolvedSearchParams.search || "";
  const type = resolvedSearchParams.type || "";
  const status = resolvedSearchParams.status || "";
  const sortBy = resolvedSearchParams.sortBy || "createdAt";
  const sortOrder = resolvedSearchParams.sortOrder || "desc";

  const t = await getTranslations("modules.items");
  const tModules = await getTranslations("modules");
  const role = state.context.role;

  return (
    <ItemsClient
      locale={locale}
      tenantId={state.membership.tenantId}
      initialPage={page}
      initialSearch={search}
      initialType={type}
      initialStatus={status}
      initialSortBy={sortBy}
      initialSortOrder={sortOrder}
      canCreate={tenantRoleHasPermission(role, PERMISSIONS.ITEMS_CREATE)}
      canUpdate={tenantRoleHasPermission(role, PERMISSIONS.ITEMS_UPDATE)}
      canDelete={tenantRoleHasPermission(role, PERMISSIONS.ITEMS_DELETE)}
      title={t("title")}
      description={t("description")}
    />
  );
}