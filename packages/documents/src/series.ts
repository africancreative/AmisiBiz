/**
 * Document series — the four document types every tenant starts with.
 *
 * Mirrors the `DocumentType` Prisma enum. The numbering rows themselves live
 * in the database (`DocumentNumbering`, one row per tenant per type);
 * `allocate_document_number()` applies the same defaults on first use, so a
 * tenant provisioned before the table existed can still issue documents.
 * This constant is only the provisioning seed and the shared vocabulary.
 */

export const DOCUMENT_TYPES = [
  "QUOTATION",
  "INVOICE",
  "DELIVERY_NOTE",
  "ORDER",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DEFAULT_DOCUMENT_SERIES = [
  { type: "QUOTATION", prefix: "QUO" },
  { type: "INVOICE", prefix: "INV" },
  { type: "DELIVERY_NOTE", prefix: "DN" },
  { type: "ORDER", prefix: "ORD" },
] as const satisfies readonly { type: DocumentType; prefix: string }[];
