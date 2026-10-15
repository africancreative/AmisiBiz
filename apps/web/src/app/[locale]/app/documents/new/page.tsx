import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";
import { tenantRoleHasPermission } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { NewDocumentClient } from "./new-document-client";
import { getContactsAction } from "@/server/actions/contact";

export const dynamic = "force-dynamic";

type DocumentTypeChoice = "QUOTATION" | "INVOICE" | "DELIVERY_NOTE";

interface NewDocumentPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    type?: string;
  }>;
}

export default async function NewDocumentPage({
  params,
  searchParams,
}: NewDocumentPageProps) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.DOCUMENTS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const resolvedSearchParams = await searchParams;
  const typeParam = resolvedSearchParams.type || "";

  const t = await getTranslations("modules.documents");
  const role = state.context.role;

  // Contacts for the picker: ACTIVE only, and within the action's own bound
  // (`pageSize` max 100 — asking for more would be a validation failure and the
  // picker would silently come back empty). A failure here is not fatal: the
  // form still works with no customer attached, which the engine allows.
  const contactsResult = await getContactsAction({
    tenantId: state.membership.tenantId,
    status: "ACTIVE",
    page: 1,
    pageSize: 100,
    sortBy: "firstName",
    sortOrder: "asc",
  });

  const contacts =
    contactsResult.success && contactsResult.data
      ? contactsResult.data.contacts
      : [];

  const canCreateQuotation = tenantRoleHasPermission(
    role,
    PERMISSIONS.QUOTATIONS_CREATE,
  );
  const canCreateInvoice = tenantRoleHasPermission(
    role,
    PERMISSIONS.INVOICES_CREATE,
  );
  const canCreateDeliveryNote = tenantRoleHasPermission(
    role,
    PERMISSIONS.DELIVERY_NOTES_CREATE,
  );

  // If the user doesn't have permission to create the requested type, deny the
  // page entirely rather than render a form that cannot submit.
  const requestedType = typeParam as DocumentTypeChoice | "";
  const allowedTypes: DocumentTypeChoice[] = [
    ...(canCreateQuotation ? ["QUOTATION" as const] : []),
    ...(canCreateInvoice ? ["INVOICE" as const] : []),
    ...(canCreateDeliveryNote ? ["DELIVERY_NOTE" as const] : []),
  ];

  if (requestedType && !allowedTypes.includes(requestedType)) {
    return <AccessDenied />;
  }

  return (
    <NewDocumentClient
      locale={locale}
      tenantId={state.membership.tenantId}
      contacts={contacts.map((c) => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        companyName: c.companyName,
        email: c.email,
        type: c.type,
      }))}
      initialType={requestedType}
      allowedTypes={allowedTypes}
      canCreateQuotation={canCreateQuotation}
      canCreateInvoice={canCreateInvoice}
      canCreateDeliveryNote={canCreateDeliveryNote}
      title={t("newDocument.title")}
      description={t("newDocument.description")}
    />
  );
}
