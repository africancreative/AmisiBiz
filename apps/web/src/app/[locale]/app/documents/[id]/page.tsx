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
      // ORDER shares the document engine but not the invoice permission keys: the
      // actions dispatch on the STORED type (`VOID_PERMISSION`,
      // `PAYMENT_PERMISSION`, `ISSUE_PERMISSION` in `server/actions/document.ts`),
      // so each order verb is offered only when its own ORDERS_* key is held.
      // Folding these into the invoice flags above would show buttons the server
      // is obliged to refuse.
      canIssueOrder={tenantRoleHasPermission(role, PERMISSIONS.ORDERS_ISSUE)}
      canVoidOrder={tenantRoleHasPermission(role, PERMISSIONS.ORDERS_VOID)}
      canRecordOrderPayment={tenantRoleHasPermission(
        role,
        PERMISSIONS.ORDERS_ISSUE,
      )}
      canReverseOrderPayment={tenantRoleHasPermission(
        role,
        PERMISSIONS.ORDERS_ISSUE,
      )}
      canCreateOrder={tenantRoleHasPermission(role, PERMISSIONS.ORDERS_CREATE)}
      canCreateInvoice={tenantRoleHasPermission(
        role,
        PERMISSIONS.INVOICES_CREATE,
      )}
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
