import { z } from "zod";

/**
 * Document QUERY validation.
 *
 * Phase 04 introduced this read path for the contact's document history, when
 * `Document` was a header table and the vocabulary was free text. Phase 05 owns
 * the document engine, and the lists below are now the database enum itself, so
 * a query can never filter on a type or a status that cannot exist.
 *
 * A history list is still a server entry point: `getDocumentsAction` previously
 * cast its input to an interface, so a client could send `pageSize: 1e9` or an
 * arbitrary `sortBy` that Prisma would reject mid-query. The bounds below are
 * what keep the read honest; the write-side schemas are added with the engine.
 *
 * `tenantId` is validated as a cuid and then re-authorized; it is never trusted
 * merely because it parses.
 */
export const DOCUMENT_TYPES = [
  "QUOTATION",
  "INVOICE",
  "DELIVERY_NOTE",
] as const;
export const DOCUMENT_STATUSES = [
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

export const documentQuerySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  contactId: z.string().cuid("Invalid contact ID").optional(),
  search: z.string().trim().max(100).optional(),
  type: z.enum(DOCUMENT_TYPES).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
  sortBy: z
    .enum(["createdAt", "updatedAt", "issuedAt", "number", "total"])
    .default("issuedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const documentLocatorSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  documentId: z.string().cuid("Invalid document ID"),
});

export type DocumentQueryInput = z.infer<typeof documentQuerySchema>;
export type DocumentLocatorInput = z.infer<typeof documentLocatorSchema>;
