import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";
import { tenantRoleHasPermission } from "@amisibiz/auth";
import { formatPercent } from "@amisibiz/documents";
import { AccessDenied } from "@/components/layout/access-denied";
import {
  NewDocumentClient,
  type ItemOption,
  type TaxRateOption,
} from "./new-document-client";
import type { DocumentTypeValue } from "@/components/documents/document-labels";
import { getContactsAction } from "@/server/actions/contact";
import { getItemsAction, getTaxCategoriesAction } from "@/server/actions/item";

export const dynamic = "force-dynamic";

type DocumentTypeChoice = DocumentTypeValue;

interface NewDocumentPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    type?: string;
  }>;
}

/**
 * The tenant's ACTIVE catalogue, as the form needs it.
 *
 * This is a PREVIEW, not an authority. The server re-resolves every line against
 * `Item` and `ContactItem` inside the write transaction
 * (`server/services/documents/lines.ts`), so nothing the browser displays here
 * decides what gets stored. It exists because a person writing a document should
 * see the price they are about to put on it instead of discovering it in a
 * failure — and because the picker is the only way to reach the customer-specific
 * pricing that resolver implements.
 *
 * A Decimal stays exact text (`toFixed(4)`, the money scale); it never becomes a
 * JS number on the way to the page.
 */
async function loadItemOptions(tenantId: string): Promise<ItemOption[]> {
  const result = await getItemsAction({
    tenantId,
    status: "ACTIVE",
    page: 1,
    // The action's own bound: asking for more would be a validation failure and
    // the picker would silently come back empty.
    pageSize: 100,
    sortBy: "name",
    sortOrder: "asc",
  });

  if (!result.success || !result.data) return [];

  return result.data.items.map((item) => ({
    itemId: item.id,
    name: item.name,
    sku: item.sku,
    description: item.description,
    unitOfMeasure: item.unitOfMeasure,
    unitPrice: item.unitPrice.toFixed(4),
    currency: item.currency,
    // The relation rather than the bare column: a rate id whose row cannot be
    // read is exactly the case the resolver refuses to price at an unverified 0%.
    taxRateId: item.taxRate?.id ?? null,
    taxName: item.taxRate?.name ?? null,
    taxRate: item.taxRate ? item.taxRate.rate.toFixed(4) : "0.0000",
  }));
}

/** The tenant's tax classifications — used by the lines that are NOT catalogue lines. */
async function loadTaxRateOptions(tenantId: string): Promise<TaxRateOption[]> {
  const result = await getTaxCategoriesAction({
    tenantId,
    page: 1,
    pageSize: 100,
  });

  if (!result.success || !result.data) return [];

  return result.data.categories.flatMap((category) =>
    category.rates
      .filter((rate) => rate.isActive)
      .map((rate) => ({
        id: rate.id,
        label: `${category.name}: ${rate.name} (${formatPercent(
          rate.rate.toFixed(4),
        )})`,
      })),
  );
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
  const tenantId = state.membership.tenantId;

  // Contacts for the picker: ACTIVE only, and within the action's own bound
  // (`pageSize` max 100 — asking for more would be a validation failure and the
  // picker would silently come back empty). A failure here is not fatal: the
  // form still works with no customer attached, which the engine allows.
  const contactsResult = await getContactsAction({
    tenantId,
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

  // Catalogue access is its own permission, separate from document access. A role
  // that may write documents but may not read the catalogue still gets a working
  // form: every line is then a manual line, which the engine prices from the
  // request rather than from a catalogue it cannot show.
  const canReadCatalogue = tenantRoleHasPermission(
    role,
    PERMISSIONS.ITEMS_READ,
  );
  // Annotated rather than inferred: the empty branch needs the same tuple shape,
  // or the destructured arrays below would lose their element types.
  const noCatalogue: [ItemOption[], TaxRateOption[]] = [[], []];
  const [itemOptions, taxRateOptions] = canReadCatalogue
    ? await Promise.all([
        loadItemOptions(tenantId),
        loadTaxRateOptions(tenantId),
      ])
    : noCatalogue;

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
  const canCreateOrder = tenantRoleHasPermission(
    role,
    PERMISSIONS.ORDERS_CREATE,
  );

  // If the user doesn't have permission to create the requested type, deny the
  // page entirely rather than render a form that cannot submit.
  const requestedType = typeParam as DocumentTypeChoice | "";
  const allowedTypes: DocumentTypeChoice[] = [
    ...(canCreateQuotation ? ["QUOTATION" as const] : []),
    ...(canCreateOrder ? ["ORDER" as const] : []),
    ...(canCreateInvoice ? ["INVOICE" as const] : []),
    ...(canCreateDeliveryNote ? ["DELIVERY_NOTE" as const] : []),
  ];

  if (requestedType && !allowedTypes.includes(requestedType)) {
    return <AccessDenied />;
  }

  return (
    <NewDocumentClient
      locale={locale}
      tenantId={tenantId}
      contacts={contacts.map((c) => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        companyName: c.companyName,
        email: c.email,
        type: c.type,
      }))}
      itemOptions={itemOptions}
      taxRateOptions={taxRateOptions}
      canReadCatalogue={canReadCatalogue}
      initialType={requestedType}
      allowedTypes={allowedTypes}
      canCreateQuotation={canCreateQuotation}
      canCreateInvoice={canCreateInvoice}
      canCreateDeliveryNote={canCreateDeliveryNote}
      canCreateOrder={canCreateOrder}
      title={t("newDocument.title")}
      description={t("newDocument.description")}
    />
  );
}
