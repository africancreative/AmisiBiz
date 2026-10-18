import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";
import { tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { parsePageParam } from "@/lib/utils";
import { DocumentsClient } from "./documents-client";

export const dynamic = "force-dynamic";

interface DocumentsPageProps {
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

export default async function DocumentsPage({
  params,
  searchParams,
}: DocumentsPageProps) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.DOCUMENTS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const resolvedSearchParams = await searchParams;
  const page = parsePageParam(resolvedSearchParams.page);
  const search = resolvedSearchParams.search || "";
  const type = resolvedSearchParams.type || "";
  const status = resolvedSearchParams.status || "";
  const sortBy = resolvedSearchParams.sortBy || "createdAt";
  const sortOrder = resolvedSearchParams.sortOrder || "desc";

  const t = await getTranslations("modules.documents");
  const role = state.context.role;

  return (
    <DocumentsClient
      locale={locale}
      tenantId={state.membership.tenantId}
      initialPage={page}
      initialSearch={search}
      initialType={type}
      initialStatus={status}
      initialSortBy={sortBy}
      initialSortOrder={sortOrder}
      canCreateQuotation={tenantRoleHasPermission(
        role,
        PERMISSIONS.QUOTATIONS_CREATE,
      )}
      canCreateInvoice={tenantRoleHasPermission(
        role,
        PERMISSIONS.INVOICES_CREATE,
      )}
      canCreateDeliveryNote={tenantRoleHasPermission(
        role,
        PERMISSIONS.DELIVERY_NOTES_CREATE,
      )}
      canCreateOrder={tenantRoleHasPermission(role, PERMISSIONS.ORDERS_CREATE)}
      canDownload={tenantRoleHasPermission(
        role,
        PERMISSIONS.DOCUMENTS_DOWNLOAD,
      )}
      title={t("title")}
      description={t("description")}
    />
  );
}
