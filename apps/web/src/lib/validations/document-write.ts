import { z } from "zod";
import {
  currencySchema,
  decimalStringSchema,
  moneySchema,
  percentSchema,
} from "@amisibiz/domain";
import { unitOfMeasureSchema } from "./item";
import { DOCUMENT_TYPES } from "./document";

/**
 * Document WRITE validation.
 *
 * These schemas are the boundary between a browser and the document engine.
 * Everything they accept is a *request*: money is a decimal STRING (never a JS
 * `number`, so a total cannot be shifted in the last binary place before it ever
 * reaches the engine), quantities and prices are bounded, and ownership ids are
 * only ever checked for shape here — the engine re-resolves every `itemId`,
 * `taxRateId` and `contactId` against the authorized tenant, because a schema
 * cannot know who owns a row.
 *
 * `tenantId` is deliberately absent from every input: the tenant comes from the
 * authorized context, never from the request body. A caller cannot name a tenant
 * to write into.
 *
 * The discount mechanism is validated more strictly still inside
 * `resolveLines`: a line may carry EITHER a percentage OR an amount, never both,
 * and the "other" field must be zero. Here we only bound the values; the engine
 * (and a database CHECK) enforce the exclusivity, so the two cannot drift.
 */

/* --------------------------------- shared --------------------------------- */

/** A calendar date, coerced from an ISO string or a `Date`. */
const dateSchema = z.coerce.date();

const optionalDateSchema = dateSchema.nullish();

export const DOCUMENT_PAYMENT_METHODS = [
  "CASH",
  "BANK_TRANSFER",
  "MOBILE_MONEY",
  "CARD",
  "CHEQUE",
  "OTHER",
] as const;

export const documentPaymentMethodSchema = z.enum(DOCUMENT_PAYMENT_METHODS);

export const QUOTATION_DECISIONS = [
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
] as const;

export const quotationDecisionSchema = z.enum(QUOTATION_DECISIONS);

/**
 * A single priced line. The description is required and bounded to match the
 * database CHECK; the rest are the descriptive facts the engine freezes into the
 * snapshot. `taxRateId` is a link, never a rate: the engine copies the rate and
 * label from the tenant's own `TaxRate`, so a browser cannot invoice at 0% VAT by
 * sending a doctored fraction.
 */
export const documentLineInputSchema = z.object({
  itemId: z.string().uuid("Invalid item ID").nullish(),
  itemCode: z.string().trim().max(50).nullish(),
  description: z.string().trim().min(1, "A line needs a description").max(500),
  unitOfMeasure: unitOfMeasureSchema.default("each"),
  quantity: decimalStringSchema(4)
    .refine((value) => Number(value) > 0, "Quantity must be greater than zero")
    .refine(
      (value) => Number(value) <= 999999.9999,
      "Quantity is larger than the schema allows",
    ),
  unitPrice: moneySchema,
  discountType: z.enum(["PERCENT", "AMOUNT"]).nullish(),
  discountPercent: percentSchema.default("0"),
  discountAmount: moneySchema.default("0"),
  taxRateId: z.string().uuid("Invalid tax rate ID").nullish(),
});

export type DocumentLineInputPayload = z.infer<typeof documentLineInputSchema>;

const headerFields = {
  contactId: z.string().uuid("Invalid customer ID").nullish(),
  currency: currencySchema.default("KES"),
  /** Defaults to now; a back-dated draft is a business decision, not a mistake. */
  issueDate: dateSchema.default(() => new Date()),
  dueDate: optionalDateSchema,
  expiryDate: optionalDateSchema,
  deliveryDate: optionalDateSchema,
  deliveryNote: z.string().trim().max(2000).nullish(),
  customerNote: z.string().trim().max(2000).nullish(),
  terms: z.string().trim().max(2000).nullish(),
};

/* --------------------------------- drafts --------------------------------- */

export const createDocumentDraftSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  ...headerFields,
  sourceDocumentId: z.string().uuid().nullish(),
  replacementOfId: z.string().uuid().nullish(),
  /** Makes a retried create/convert return the same document. */
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid idempotency key")
    .nullish(),
  lines: z
    .array(documentLineInputSchema)
    .min(1, "A document needs at least one line")
    .max(1000, "A document cannot have more than 1000 lines"),
});

export const updateDocumentDraftSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
  ...headerFields,
  sourceDocumentId: z.string().uuid().nullish(),
  replacementOfId: z.string().uuid().nullish(),
  lines: z
    .array(documentLineInputSchema)
    .min(1, "A document needs at least one line")
    .max(1000, "A document cannot have more than 1000 lines"),
});

/* -------------------------------- issuance -------------------------------- */

/**
 * Issuance may amend the dates and notes on the way through, but never the lines
 * or the currency: those were agreed on the draft and are frozen by the snapshot.
 */
export const issueDocumentSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
  issueDate: dateSchema.optional(),
  dueDate: optionalDateSchema,
  expiryDate: optionalDateSchema,
  deliveryDate: optionalDateSchema,
  deliveryNote: z.string().trim().max(2000).nullish(),
  customerNote: z.string().trim().max(2000).nullish(),
  terms: z.string().trim().max(2000).nullish(),
});

/** A reason is mandatory: a void or a reversal without one is not auditable. */
export const documentReasonSchema = z
  .string()
  .trim()
  .min(3, "Please give a reason")
  .max(500);

export const voidDocumentSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
  reason: documentReasonSchema,
});

/* ------------------------------- quotations ------------------------------- */

export const recordQuotationDecisionSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
  decision: quotationDecisionSchema,
  reason: z.string().trim().max(500).nullish(),
});

export const convertQuotationSchema = z.object({
  quotationId: z.string().uuid("Invalid quotation ID"),
  issueDate: dateSchema.optional(),
  dueDate: optionalDateSchema,
});

/* ------------------------------ delivery notes ---------------------------- */

export const createDeliveryNoteSchema = z.object({
  sourceDocumentId: z.string().uuid("Invalid source document ID"),
  deliveryDate: optionalDateSchema,
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid idempotency key")
    .nullish(),
});

export const deliveryAcknowledgementSchema = z.object({
  lineId: z.string().uuid("Invalid line ID"),
  deliveredQuantity: decimalStringSchema(4),
});

/**
 * A delivery is recorded as a set of per-line quantities the customer has
 * acknowledged. An empty array is allowed (it re-derives the status without
 * changing anything); the engine rejects a quantity that exceeds the line or
 * that would reduce a previously recorded delivery.
 */
export const recordDeliverySchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
  acknowledgements: z.array(deliveryAcknowledgementSchema).max(1000),
});

/* --------------------------------- payments ------------------------------- */

export const recordPaymentSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
  amount: decimalStringSchema(4).refine(
    (value) => Number(value) > 0,
    "A payment must be greater than zero",
  ),
  occurredOn: dateSchema,
  method: documentPaymentMethodSchema.default("BANK_TRANSFER"),
  reference: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const reversePaymentSchema = z.object({
  paymentId: z.string().uuid("Invalid payment ID"),
  reason: documentReasonSchema,
});

/* --------------------------------- locators ------------------------------- */

export const documentWriteLocatorSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  documentId: z.string().uuid("Invalid document ID"),
});

export type CreateDocumentDraftInput = z.infer<
  typeof createDocumentDraftSchema
>;
export type UpdateDocumentDraftInput = z.infer<
  typeof updateDocumentDraftSchema
>;
export type IssueDocumentInput = z.infer<typeof issueDocumentSchema>;
export type VoidDocumentInput = z.infer<typeof voidDocumentSchema>;
export type RecordQuotationDecisionInput = z.infer<
  typeof recordQuotationDecisionSchema
>;
export type ConvertQuotationInput = z.infer<typeof convertQuotationSchema>;
export type CreateDeliveryNoteInput = z.infer<typeof createDeliveryNoteSchema>;
export type RecordDeliveryInput = z.infer<typeof recordDeliverySchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;
