import type { BadgeTone } from "@amisibiz/ui/badge";

/**
 * The document type vocabulary used by every surface that shows a `Document`.
 *
 * ORDER is a `Document` row of type `ORDER` — there is no separate order entity —
 * so every screen that labels a document has to name the four stored types. The
 * `documentEnums` message namespace is the translation home for these words, but
 * its `type` block does not carry an `ORDER` key yet (the consolidated i18n pass
 * owns `messages/**`), so a `useTranslations("documentEnums")` call on
 * `type.ORDER` would render an error instead of a label. English lives here for
 * that reason, with the ORDER-aware status tones next to it so the list, the
 * detail screen and the customer-360 document table cannot drift apart.
 *
 * The copy rule this file exists to enforce: an order is a commercial request,
 * never a tax document. Only `INVOICE` is called an invoice, and nothing here
 * describes an order PDF as one.
 */
export const DOCUMENT_TYPE_VALUES = [
  "QUOTATION",
  "INVOICE",
  "DELIVERY_NOTE",
  "ORDER",
] as const;

export type DocumentTypeValue = (typeof DOCUMENT_TYPE_VALUES)[number];

/** Narrowed filter value for the documents list: a type, or "all types". */
export type DocumentTypeFilter = DocumentTypeValue | "";

export function isDocumentTypeValue(value: string): value is DocumentTypeValue {
  return (DOCUMENT_TYPE_VALUES as readonly string[]).includes(value);
}

/** A document type as a person reads it. Unknown values come back verbatim. */
export function documentTypeLabel(type: string): string {
  switch (type) {
    case "QUOTATION":
      return "Quotation";
    case "INVOICE":
      return "Invoice";
    case "DELIVERY_NOTE":
      return "Delivery note";
    case "ORDER":
      return "Order";
    default:
      return type;
  }
}

/**
 * The list row's type chip.
 *
 * Colour is decoration only: the label text is always present, so a chip is never
 * the sole carrier of the type on a mobile width or in a screen-reader sweep.
 */
export function documentTypeChipClass(type: string): string {
  switch (type) {
    case "QUOTATION":
      return "bg-blue-100 text-blue-800";
    case "INVOICE":
      return "bg-green-100 text-green-800";
    case "DELIVERY_NOTE":
      return "bg-purple-100 text-purple-800";
    case "ORDER":
      return "bg-amber-100 text-amber-900";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/**
 * Status tones, including the ones an ORDER reaches.
 *
 * `CANCELLED` is an unfulfilled order's exit and `VOID` an issued order's
 * correction path; both are the server's derivation, and this only says how loud
 * the badge is.
 */
export function documentStatusTone(status: string): BadgeTone {
  switch (status) {
    case "PAID":
    case "ACCEPTED":
    case "DELIVERED":
      return "success";
    case "OVERDUE":
    case "VOID":
    case "REJECTED":
    case "CANCELLED":
    case "EXPIRED":
      return "danger";
    case "ISSUED":
      return "info";
    case "PARTIALLY_PAID":
    case "PARTIALLY_DELIVERED":
      return "warning";
    default:
      return "neutral";
  }
}

/** Every status the list's filter offers, mirroring the query schema's enum. */
export const DOCUMENT_STATUS_FILTER_VALUES = [
  "DRAFT",
  "ISSUED",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "VOID",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
] as const;

export function isDocumentStatusValue(value: string): boolean {
  return (DOCUMENT_STATUS_FILTER_VALUES as readonly string[]).includes(value);
}

/** A status as a person reads it, when no translation entry is available. */
export function documentStatusLabel(status: string): string {
  switch (status) {
    case "VOID":
      return "Voided";
    case "PARTIALLY_PAID":
      return "Partially paid";
    case "PARTIALLY_DELIVERED":
      return "Partially delivered";
    case "DRAFT":
      return "Draft";
    case "ISSUED":
      return "Issued";
    case "PAID":
      return "Paid";
    case "OVERDUE":
      return "Overdue";
    case "CANCELLED":
      return "Cancelled";
    case "ACCEPTED":
      return "Accepted";
    case "REJECTED":
      return "Rejected";
    case "EXPIRED":
      return "Expired";
    case "DELIVERED":
      return "Delivered";
    default:
      return status.replace(/_/g, " ");
  }
}
