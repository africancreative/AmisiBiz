import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";
import { tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { DocumentDetailClient } from "./document-detail-client";

export const dynamic = "force-dynamic";

interface DocumentDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
}

export default async function DocumentDetailPage({
  params,
}: DocumentDetailPageProps) {
  const { locale, id } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.DOCUMENTS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const t = await getTranslations("modules.documents");
  const role = state.context.role;

  return (
    <DocumentDetailClient
      locale={locale}
      tenantId={state.membership.tenantId}
      documentId={id}
      canIssue={
        tenantRoleHasPermission(role, PERMISSIONS.QUOTATIONS_ISSUE) ||
        tenantRoleHasPermission(role, PERMISSIONS.INVOICES_ISSUE) ||
        tenantRoleHasPermission(role, PERMISSIONS.DELIVERY_NOTES_ISSUE)
      }
      canVoid={tenantRoleHasPermission(role, PERMISSIONS.INVOICES_VOID)}
      canRecordQuotationDecision={tenantRoleHasPermission(
        role,
        PERMISSIONS.QUOTATIONS_ISSUE,
      )}
      canConvert={tenantRoleHasPermission(role, PERMISSIONS.INVOICES_CREATE)}
      canCreateDeliveryNote={tenantRoleHasPermission(
        role,
        PERMISSIONS.DELIVERY_NOTES_CREATE,
      )}
      canRecordDelivery={tenantRoleHasPermission(
        role,
        PERMISSIONS.DELIVERY_NOTES_ISSUE,
      )}
      canRecordPayment={tenantRoleHasPermission(
        role,
        PERMISSIONS.INVOICES_ISSUE,
      )}
      canReversePayment={tenantRoleHasPermission(
        role,
        PERMISSIONS.INVOICES_ISSUE,
      )}
      canCreateReplacement={tenantRoleHasPermission(
        role,
        PERMISSIONS.INVOICES_CREATE,
      )}
      canDownload={tenantRoleHasPermission(
        role,
        PERMISSIONS.DOCUMENTS_DOWNLOAD,
      )}
      title={t("title")}
    />
  );
}
