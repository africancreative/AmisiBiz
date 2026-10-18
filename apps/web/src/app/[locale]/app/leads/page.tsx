import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS, tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { parsePageParam } from "@/lib/utils";
import { LeadsClient } from "./leads-client";

export const dynamic = "force-dynamic";

interface LeadsPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    page?: string;
    q?: string;
    status?: string;
    view?: string;
  }>;
}

export default async function LeadsPage({
  params,
  searchParams,
}: LeadsPageProps) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.LEADS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const resolvedSearchParams = await searchParams;
  // Untrusted query text: the page number is parsed into a bounded integer,
  // the view token is whitelisted in the client.
  const page = parsePageParam(resolvedSearchParams.page);
  const q = resolvedSearchParams.q || "";
  const status = resolvedSearchParams.status || "";
  const view = resolvedSearchParams.view || "";

  const t = await getTranslations("crm.leads");
  const role = state.context.role;

  return (
    <LeadsClient
      locale={locale}
      tenantId={state.membership.tenantId}
      initialPage={page}
      initialQ={q}
      initialStatus={status}
      initialView={view}
      readonly={state.readonly}
      canCreate={tenantRoleHasPermission(role, PERMISSIONS.LEADS_CREATE)}
      canUpdate={tenantRoleHasPermission(role, PERMISSIONS.LEADS_UPDATE)}
      canConvert={tenantRoleHasPermission(role, PERMISSIONS.LEADS_CONVERT)}
      canViewPipelines={tenantRoleHasPermission(
        role,
        PERMISSIONS.PIPELINES_READ,
      )}
      canReadContacts={tenantRoleHasPermission(role, PERMISSIONS.CONTACTS_READ)}
      title={t("title")}
      description={t("description")}
    />
  );
}
