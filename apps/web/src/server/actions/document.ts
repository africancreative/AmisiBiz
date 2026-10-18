"use server";

import { z } from "zod";
import { prisma } from "@amisibiz/database";
import { requireAuth } from "@/lib/auth/helpers";
import { PERMISSIONS, type Permission } from "@amisibiz/auth";
import {
  authorizeTenant,
  AuthorizationError,
  type TenantAuthzContext,
} from "@/server/auth/authorization";
import type { DocumentType, Prisma } from "@prisma/client";
import { fail, toActionResult, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  documentLocatorSchema,
  documentQuerySchema,
} from "@/lib/validations/document";
import {
  createDocumentDraftSchema,
  createDeliveryNoteSchema,
  convertQuotationSchema,
  documentReasonSchema,
  issueDocumentSchema,
  recordDeliverySchema,
  recordPaymentSchema,
  recordQuotationDecisionSchema,
  reversePaymentSchema,
  updateDocumentDraftSchema,
  voidDocumentSchema,
  type DocumentLineInputPayload,
} from "@/lib/validations/document-write";
import {
  DocumentServiceError,
  documentErrorActionCode,
} from "@/server/services/documents/errors";
import {
  cancelOrder,
  convertQuotationToInvoice,
  convertQuotationToOrder,
  createDeliveryNoteFromDocument,
  createDraft,
  createInvoiceFromOrder,
  createReplacementDraft,
  issueDocument,
  recordDelivery,
  recordPayment,
  recordQuotationDecision,
  reversePayment,
  updateDraft,
  voidInvoice,
} from "@/server/services/documents/service";
import type { DocumentLinePayload } from "@/server/services/documents/lines";

/* ------------------------------- read path -------------------------------- */

/**
 * Contact projection for a document row. Declared once and `satisfies` the
 * Prisma include type so the query and the action's return type can never
 * disagree (the earlier `include: { contact: true }` signature promised a full
 * contact row while the query only selected the identifying fields).
 *
 * Only the identifying fields are read: a document list and a document detail
 * need to show WHO the document is for, not the customer's whole record — and
 * the contact's `notes`, addresses and portal linkage have no business reaching
 * a browser bundle that only renders a table row.
 */
const documentInclude = {
  contact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      companyName: true,
      email: true,
      type: true,
    },
  },
} satisfies Prisma.DocumentInclude;

/** A row of `getDocumentsAction`: the header plus its customer identity. */
export type DocumentListItem = Prisma.DocumentGetPayload<{
  include: typeof documentInclude;
}>;

export async function getDocumentsAction(rawInput: unknown): Promise<
  ActionResult<{
    documents: DocumentListItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = documentQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const {
    tenantId,
    contactId,
    search,
    type,
    status,
    page,
    pageSize,
    sortBy,
    sortOrder,
  } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getDocumentsAction");
  }

  // Scoped with the authorized tenant id, never the value that arrived.
  const where: Prisma.DocumentWhereInput = {
    tenantId: context.tenantId,
    ...(contactId && { contactId }),
    ...(type && { type }),
    ...(status && { status }),
    ...(search && {
      OR: [
        { number: { contains: search, mode: "insensitive" } },
        { contact: { firstName: { contains: search, mode: "insensitive" } } },
        { contact: { lastName: { contains: search, mode: "insensitive" } } },
        { contact: { companyName: { contains: search, mode: "insensitive" } } },
        { contact: { email: { contains: search, mode: "insensitive" } } },
      ],
    }),
  };

  try {
    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        include: documentInclude,
        // sortBy comes from the validated enum, never from free text.
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.document.count({ where }),
    ]);

    return {
      success: true,
      data: {
        documents,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (err) {
    console.error("[getDocumentsAction]", err);
    return {
      success: false,
      error: "Failed to load documents.",
      code: "INTERNAL",
    };
  }
}

/**
 * The header plus its customer identity, without lines or payments. Kept as a
 * separate entry point for callers that only need to resolve one document.
 */
export async function getDocumentAction(
  documentId: string,
  tenantId: string,
): Promise<ActionResult<{ document: DocumentListItem | null }>> {
  const session = await requireAuth();

  const parsed = documentLocatorSchema.safeParse({ documentId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getDocumentAction");
  }

  try {
    const document = await prisma.document.findFirst({
      where: { id: parsed.data.documentId, tenantId: context.tenantId },
      include: documentInclude,
    });

    return { success: true, data: { document } };
  } catch (err) {
    console.error("[getDocumentAction]", err);
    return {
      success: false,
      error: "Failed to load document.",
      code: "INTERNAL",
    };
  }
}

/**
 * Full document detail: lines ordered by position, payments by occurred date
 * descending, and the status trail oldest-first. Used by the detail page, whose
 * lifecycle buttons are enabled from the status this returns.
 */
const documentDetailInclude = {
  // Same customer projection as the list — spread rather than restated so the
  // two can never drift into showing different facts about one customer.
  contact: documentInclude.contact,
  lines: {
    orderBy: { position: "asc" },
  },
  payments: {
    orderBy: { occurredOn: "desc" },
  },
  statusEvents: {
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.DocumentInclude;

/** What the detail page receives: header + customer + lines + payments + trail. */
export type DocumentDetail = Prisma.DocumentGetPayload<{
  include: typeof documentDetailInclude;
}>;

export async function getDocumentDetailAction(
  documentId: string,
  tenantId: string,
): Promise<ActionResult<{ document: DocumentDetail | null }>> {
  const session = await requireAuth();

  const parsed = documentLocatorSchema.safeParse({ documentId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getDocumentDetailAction");
  }

  try {
    const document = await prisma.document.findFirst({
      where: { id: parsed.data.documentId, tenantId: context.tenantId },
      include: documentDetailInclude,
    });

    return { success: true, data: { document } };
  } catch (err) {
    console.error("[getDocumentDetailAction]", err);
    return {
      success: false,
      error: "Failed to load document.",
      code: "INTERNAL",
    };
  }
}

/* ------------------------------- write path ------------------------------- */

/**
 * The permission each write operation requires, per document TYPE.
 *
 * This is why `authorizeByDocumentType` exists rather than a single
 * `documents.write`: the role matrix deliberately splits the lifecycle by who
 * owns it (SALES issues quotations, FINANCE issues and settles invoices,
 * OPERATIONS handles deliveries). Choosing the permission from the document's
 * *stored* type — never one the caller sent — is what stops a client from
 * claiming "INVOICE" to exercise an invoice permission on a quotation.
 *
 * The judgement calls, all documented in the role matrix's own comment:
 *  - recording a quotation decision (accept / reject / expire / cancel) is part
 *    of the quotation lifecycle, so it requires `QUOTATIONS_ISSUE`;
 *  - recording an invoice payment advances the invoice lifecycle, so it requires
 *    `INVOICES_ISSUE`;
 *  - recording a delivery acknowledgement advances the delivery note lifecycle,
 *    so it requires `DELIVERY_NOTES_ISSUE`.
 * Nothing here lets a caller pick the permission; the stored type does.
 */
const CREATE_PERMISSION: Record<DocumentType, Permission> = {
  QUOTATION: PERMISSIONS.QUOTATIONS_CREATE,
  INVOICE: PERMISSIONS.INVOICES_CREATE,
  DELIVERY_NOTE: PERMISSIONS.DELIVERY_NOTES_CREATE,
  ORDER: PERMISSIONS.ORDERS_CREATE,
};

const UPDATE_DRAFT_PERMISSION: Record<DocumentType, Permission> = {
  QUOTATION: PERMISSIONS.QUOTATIONS_UPDATE_DRAFT,
  INVOICE: PERMISSIONS.INVOICES_UPDATE_DRAFT,
  DELIVERY_NOTE: PERMISSIONS.DELIVERY_NOTES_UPDATE_DRAFT,
  ORDER: PERMISSIONS.ORDERS_UPDATE_DRAFT,
};

const ISSUE_PERMISSION: Record<DocumentType, Permission> = {
  QUOTATION: PERMISSIONS.QUOTATIONS_ISSUE,
  INVOICE: PERMISSIONS.INVOICES_ISSUE,
  DELIVERY_NOTE: PERMISSIONS.DELIVERY_NOTES_ISSUE,
  ORDER: PERMISSIONS.ORDERS_ISSUE,
};

/**
 * VOID applies to invoices and orders only (the renamed database CHECK). The
 * stored type picks the key: an invoice void stays `INVOICES_VOID`, an order
 * void requires `ORDERS_VOID`. Quotations and delivery notes have no void
 * permission to reach — the engine refuses them with its own VALIDATION error
 * before anything is written — and fall back to the invoice key so the
 * dispatch itself stays total.
 */
const VOID_PERMISSION: Record<DocumentType, Permission> = {
  QUOTATION: PERMISSIONS.INVOICES_VOID,
  INVOICE: PERMISSIONS.INVOICES_VOID,
  DELIVERY_NOTE: PERMISSIONS.INVOICES_VOID,
  ORDER: PERMISSIONS.ORDERS_VOID,
};

/**
 * Payments advance the money lifecycle of the document they settle, per type:
 * an invoice payment requires `INVOICES_ISSUE` (the existing rule), an ORDER
 * payment requires `ORDERS_ISSUE`. A click is never a payment: only this
 * action, authorized against the stored type, writes a `DocumentPayment`.
 */
const PAYMENT_PERMISSION: Record<DocumentType, Permission> = {
  QUOTATION: PERMISSIONS.INVOICES_ISSUE,
  INVOICE: PERMISSIONS.INVOICES_ISSUE,
  DELIVERY_NOTE: PERMISSIONS.INVOICES_ISSUE,
  ORDER: PERMISSIONS.ORDERS_ISSUE,
};

const tenantIdSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
});

function toLinePayload(line: DocumentLineInputPayload): DocumentLinePayload {
  return {
    itemId: line.itemId ?? null,
    description: line.description,
    itemCode: line.itemCode ?? null,
    unitOfMeasure: line.unitOfMeasure,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountType: line.discountType ?? null,
    discountPercent: line.discountPercent,
    discountAmount: line.discountAmount,
    taxRateId: line.taxRateId ?? null,
  };
}

/** Maps an engine error onto the action vocabulary; authorization → FORBIDDEN. */
function documentActionFailure(
  error: unknown,
  context: string,
): ActionResult<never> {
  if (error instanceof DocumentServiceError) {
    return fail(error.message, {
      code: documentErrorActionCode(error.code),
      ...(error.field
        ? { fieldErrors: { [error.field]: [error.message] } }
        : {}),
    });
  }
  if (error instanceof AuthorizationError) {
    return authorizationFailure(error, context);
  }
  return toActionResult(error, undefined, context);
}

/**
 * Authorizes a write against a document whose type is not in the request: a
 * cheap read first (which proves membership and opens the RLS scope), then the
 * stored type decides which write permission is required. The type is immutable
 * once set, so the two authorizations cannot disagree about it.
 */
async function authorizeByDocumentType(
  userId: string,
  tenantId: string,
  documentId: string,
  permissionFor: (type: DocumentType) => Permission,
): Promise<TenantAuthzContext> {
  await authorizeTenant(userId, tenantId, PERMISSIONS.DOCUMENTS_READ);

  const document = await prisma.document.findFirst({
    where: { id: documentId, tenantId },
    select: { type: true },
  });
  if (!document) {
    // The read authorization already guaranteed membership; a missing row is a
    // genuine not-found within the caller's own workspace.
    throw new DocumentServiceError("NOT_FOUND", "Document not found.");
  }

  return authorizeTenant(userId, tenantId, permissionFor(document.type));
}

/**
 * The payment-reversal twin of `authorizeByDocumentType`: a reversal names a
 * payment, not a document, so the payment's own document (read inside the
 * caller's authorized tenant scope — a foreign payment simply finds no row)
 * decides whether `INVOICES_ISSUE` or `ORDERS_ISSUE` is exercised.
 */
async function authorizeByPaymentDocumentType(
  userId: string,
  tenantId: string,
  paymentId: string,
): Promise<TenantAuthzContext> {
  await authorizeTenant(userId, tenantId, PERMISSIONS.DOCUMENTS_READ);

  const payment = await prisma.documentPayment.findFirst({
    where: { id: paymentId, tenantId },
    select: { document: { select: { type: true } } },
  });
  if (!payment) {
    throw new DocumentServiceError("NOT_FOUND", "Payment not found.");
  }

  return authorizeTenant(
    userId,
    tenantId,
    PAYMENT_PERMISSION[payment.document.type],
  );
}

const createDraftActionSchema = tenantIdSchema.merge(createDocumentDraftSchema);
const updateDraftActionSchema = tenantIdSchema.merge(updateDocumentDraftSchema);
const issueActionSchema = tenantIdSchema.merge(issueDocumentSchema);
const voidActionSchema = tenantIdSchema.merge(voidDocumentSchema);
const decisionActionSchema = tenantIdSchema.merge(
  recordQuotationDecisionSchema,
);
const convertActionSchema = tenantIdSchema.merge(convertQuotationSchema);
const deliveryNoteActionSchema = tenantIdSchema.merge(createDeliveryNoteSchema);
const deliveryActionSchema = tenantIdSchema.merge(recordDeliverySchema);
const paymentActionSchema = tenantIdSchema.merge(recordPaymentSchema);
const reverseActionSchema = tenantIdSchema.merge(reversePaymentSchema);
const replacementActionSchema = tenantIdSchema.merge(
  z.object({ documentId: z.string().uuid("Invalid document ID") }),
);

/**
 * Same idempotency-key shape the draft and delivery-note writes already accept
 * (declared in `document-write.ts`); the ORDER conversions reuse the rule, so
 * the literal is restated next to the schemas that use it.
 */
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid idempotency key")
  .nullish();

const convertToOrderActionSchema = tenantIdSchema.merge(
  z.object({
    quotationId: z.string().uuid("Invalid quotation ID"),
    issueDate: z.coerce.date().optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
);

const invoiceFromOrderActionSchema = tenantIdSchema.merge(
  z.object({
    orderId: z.string().uuid("Invalid order ID"),
    issueDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().nullish(),
    idempotencyKey: idempotencyKeySchema,
  }),
);

const cancelOrderActionSchema = tenantIdSchema.merge(
  z.object({
    documentId: z.string().uuid("Invalid document ID"),
    reason: documentReasonSchema,
  }),
);

/** Creates a quotation, invoice or delivery note draft. */
export async function createDocumentDraftAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAuth();

  const parsed = createDraftActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid document.");
  }
  const { tenantId, ...draft } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      CREATE_PERMISSION[draft.type],
    );
    const created = await createDraft(context, session.user.id, {
      type: draft.type,
      contactId: draft.contactId ?? null,
      currency: draft.currency,
      issueDate: draft.issueDate,
      dueDate: draft.dueDate ?? null,
      expiryDate: draft.expiryDate ?? null,
      deliveryDate: draft.deliveryDate ?? null,
      customerNote: draft.customerNote ?? null,
      terms: draft.terms ?? null,
      deliveryNote: draft.deliveryNote ?? null,
      sourceDocumentId: draft.sourceDocumentId ?? null,
      replacementOfId: draft.replacementOfId ?? null,
      idempotencyKey: draft.idempotencyKey ?? null,
      lines: draft.lines.map(toLinePayload),
    });
    return { success: true, data: created };
  } catch (error) {
    return documentActionFailure(error, "createDocumentDraftAction");
  }
}

/** Replaces a draft's header and lines; refuses anything already issued. */
export async function updateDocumentDraftAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAuth();

  const parsed = updateDraftActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid document.");
  }
  const { tenantId, ...draft } = parsed.data;

  try {
    const context = await authorizeByDocumentType(
      session.user.id,
      tenantId,
      draft.documentId,
      (type) => UPDATE_DRAFT_PERMISSION[type],
    );
    const updated = await updateDraft(context, session.user.id, {
      documentId: draft.documentId,
      contactId: draft.contactId ?? null,
      currency: draft.currency,
      issueDate: draft.issueDate,
      dueDate: draft.dueDate ?? null,
      expiryDate: draft.expiryDate ?? null,
      deliveryDate: draft.deliveryDate ?? null,
      customerNote: draft.customerNote ?? null,
      terms: draft.terms ?? null,
      deliveryNote: draft.deliveryNote ?? null,
      sourceDocumentId: draft.sourceDocumentId ?? null,
      replacementOfId: draft.replacementOfId ?? null,
      lines: draft.lines.map(toLinePayload),
    });
    return { success: true, data: updated };
  } catch (error) {
    return documentActionFailure(error, "updateDocumentDraftAction");
  }
}

/** Issues a draft: allocates the number and freezes the snapshot, atomically. */
export async function issueDocumentAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string; number: string }>> {
  const session = await requireAuth();

  const parsed = issueActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid issuance request.");
  }
  const { tenantId, documentId, ...rest } = parsed.data;

  try {
    const context = await authorizeByDocumentType(
      session.user.id,
      tenantId,
      documentId,
      (type) => ISSUE_PERMISSION[type],
    );
    const result = await issueDocument(context, session.user.id, {
      documentId,
      issueDate: rest.issueDate,
      dueDate: rest.dueDate ?? null,
      expiryDate: rest.expiryDate ?? null,
      deliveryDate: rest.deliveryDate ?? null,
      deliveryNote: rest.deliveryNote ?? null,
      customerNote: rest.customerNote ?? null,
      terms: rest.terms ?? null,
    });
    return { success: true, data: result };
  } catch (error) {
    return documentActionFailure(error, "issueDocumentAction");
  }
}

/**
 * Voids an issued invoice or order, keeping the row and number for the trail.
 * The stored type picks the key: `INVOICES_VOID` for an invoice,
 * `ORDERS_VOID` for an order — the SALES role holds neither void permission,
 * FINANCE holds both (the matrix, asserted in the phase tests).
 */
export async function voidInvoiceAction(
  rawInput: unknown,
): Promise<ActionResult<void>> {
  const session = await requireAuth();

  const parsed = voidActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid void request.");
  }
  const { tenantId, documentId, reason } = parsed.data;

  try {
    const context = await authorizeByDocumentType(
      session.user.id,
      tenantId,
      documentId,
      (type) => VOID_PERMISSION[type],
    );
    await voidInvoice(context, session.user.id, { documentId, reason });
    return { success: true };
  } catch (error) {
    return documentActionFailure(error, "voidInvoiceAction");
  }
}

/** Records a customer's answer to an issued quotation. */
export async function recordQuotationDecisionAction(
  rawInput: unknown,
): Promise<ActionResult<void>> {
  const session = await requireAuth();

  const parsed = decisionActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid quotation decision.");
  }
  const { tenantId, documentId, decision, reason } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.QUOTATIONS_ISSUE,
    );
    await recordQuotationDecision(context, session.user.id, {
      documentId,
      decision,
      reason: reason ?? null,
    });
    return { success: true };
  } catch (error) {
    return documentActionFailure(error, "recordQuotationDecisionAction");
  }
}

/** Converts an accepted quotation into a draft invoice. */
export async function convertQuotationAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAuth();

  const parsed = convertActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid conversion request.");
  }
  const { tenantId, quotationId, issueDate, dueDate } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INVOICES_CREATE,
    );
    const created = await convertQuotationToInvoice(context, session.user.id, {
      quotationId,
      issueDate: issueDate ?? null,
      dueDate: dueDate ?? null,
    });
    return { success: true, data: created };
  } catch (error) {
    return documentActionFailure(error, "convertQuotationAction");
  }
}

/** Raises a draft delivery note from an issued invoice. */
export async function createDeliveryNoteAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAuth();

  const parsed = deliveryNoteActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid delivery note request.");
  }
  const { tenantId, sourceDocumentId, deliveryDate, idempotencyKey } =
    parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DELIVERY_NOTES_CREATE,
    );
    const created = await createDeliveryNoteFromDocument(
      context,
      session.user.id,
      {
        sourceDocumentId,
        deliveryDate: deliveryDate ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
    return { success: true, data: created };
  } catch (error) {
    return documentActionFailure(error, "createDeliveryNoteAction");
  }
}

/** Records which quantities on a delivery note the customer acknowledged. */
export async function recordDeliveryAction(
  rawInput: unknown,
): Promise<ActionResult<{ status: string }>> {
  const session = await requireAuth();

  const parsed = deliveryActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid delivery acknowledgement.");
  }
  const { tenantId, documentId, acknowledgements } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DELIVERY_NOTES_ISSUE,
    );
    const result = await recordDelivery(context, session.user.id, {
      documentId,
      acknowledgements,
    });
    return { success: true, data: result };
  } catch (error) {
    return documentActionFailure(error, "recordDeliveryAction");
  }
}

/**
 * Records a payment against an invoice or an order; the status is then derived.
 * The stored document type — never the request — picks the permission:
 * INVOICE → `INVOICES_ISSUE`, ORDER → `ORDERS_ISSUE`.
 */
export async function recordPaymentAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  const session = await requireAuth();

  const parsed = paymentActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid payment.");
  }
  const { tenantId, documentId, ...payment } = parsed.data;

  try {
    const context = await authorizeByDocumentType(
      session.user.id,
      tenantId,
      documentId,
      (type) => PAYMENT_PERMISSION[type],
    );
    const result = await recordPayment(context, session.user.id, {
      documentId,
      amount: payment.amount,
      occurredOn: payment.occurredOn,
      method: payment.method,
      reference: payment.reference ?? null,
      note: payment.note ?? null,
    });
    return { success: true, data: result };
  } catch (error) {
    return documentActionFailure(error, "recordPaymentAction");
  }
}

/** Reverses a payment without deleting it, then re-derives the status. */
export async function reversePaymentAction(
  rawInput: unknown,
): Promise<ActionResult<void>> {
  const session = await requireAuth();

  const parsed = reverseActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid reversal request.");
  }
  const { tenantId, paymentId, reason } = parsed.data;

  try {
    const context = await authorizeByPaymentDocumentType(
      session.user.id,
      tenantId,
      paymentId,
    );
    await reversePayment(context, session.user.id, { paymentId, reason });
    return { success: true };
  } catch (error) {
    return documentActionFailure(error, "reversePaymentAction");
  }
}

/** Creates a replacement draft for a voided document. */
export async function createReplacementAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAuth();

  const parsed = replacementActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid replacement request.");
  }
  const { tenantId, documentId } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INVOICES_CREATE,
    );
    const created = await createReplacementDraft(context, session.user.id, {
      documentId,
    });
    return { success: true, data: created };
  } catch (error) {
    return documentActionFailure(error, "createReplacementAction");
  }
}

/* --------------------------------- orders ---------------------------------- */

/**
 * Converts an accepted quotation into a draft ORDER. Gated `ORDERS_CREATE`,
 * mirroring how `convertQuotationAction` is gated `INVOICES_CREATE`: the
 * conversion creates an order, so it needs the permission that creates one —
 * never the quotation key, and never a type the caller sent.
 */
export async function convertQuotationToOrderAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAuth();

  const parsed = convertToOrderActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid order conversion request.");
  }
  const { tenantId, quotationId, issueDate, idempotencyKey } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ORDERS_CREATE,
    );
    const created = await convertQuotationToOrder(context, session.user.id, {
      quotationId,
      issueDate: issueDate ?? null,
      idempotencyKey: idempotencyKey ?? null,
    });
    return { success: true, data: created };
  } catch (error) {
    return documentActionFailure(error, "convertQuotationToOrderAction");
  }
}

/** Raises a draft invoice from an issued order. Gated `INVOICES_CREATE`. */
export async function createInvoiceFromOrderAction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireAuth();

  const parsed = invoiceFromOrderActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid invoice-from-order request.");
  }
  const { tenantId, orderId, issueDate, dueDate, idempotencyKey } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INVOICES_CREATE,
    );
    const created = await createInvoiceFromOrder(context, session.user.id, {
      orderId,
      issueDate: issueDate ?? null,
      dueDate: dueDate ?? null,
      idempotencyKey: idempotencyKey ?? null,
    });
    return { success: true, data: created };
  } catch (error) {
    return documentActionFailure(error, "createInvoiceFromOrderAction");
  }
}

/**
 * Cancels an unfulfilled order with a mandatory reason. Cancel and void share
 * one gate — `ORDERS_VOID` — exactly as invoice voiding is the destructive
 * order/invoice correction permission; SALES, which lacks it, is refused here
 * even though it can create, draft-edit and issue orders.
 */
export async function cancelOrderAction(
  rawInput: unknown,
): Promise<ActionResult<void>> {
  const session = await requireAuth();

  const parsed = cancelOrderActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid cancellation request.");
  }
  const { tenantId, documentId, reason } = parsed.data;

  try {
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ORDERS_VOID,
    );
    await cancelOrder(context, session.user.id, { documentId, reason });
    return { success: true };
  } catch (error) {
    return documentActionFailure(error, "cancelOrderAction");
  }
}
