import { z } from "zod";

/**
 * Document QUERY validation.
 *
 * Phase 05 owns document creation, numbering and totals. What Phase 04 needs is
 * the contact's document history, and a history list is still a server entry
 * point: `getDocumentsAction` previously cast its input to an interface, so a
 * client could send `pageSize: 1e9` or an arbitrary `sortBy` that Prisma would
 * reject mid-query. Bounding the read is the minimum that keeps the CRM screen
 * honest without starting the documents phase early.
 *
 * `tenantId` is validated as a cuid and then re-authorized; it is never trusted
 * merely because it parses.
 */
export const DOCUMENT_TYPES = ["INVOICE", "QUOTE"] as const;
export const DOCUMENT_STATUSES = [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "VOID",
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
