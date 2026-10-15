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
  convertQuotationToInvoice,
  createDeliveryNoteFromDocument,
  createDraft,
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
};

const UPDATE_DRAFT_PERMISSION: Record<DocumentType, Permission> = {
  QUOTATION: PERMISSIONS.QUOTATIONS_UPDATE_DRAFT,
  INVOICE: PERMISSIONS.INVOICES_UPDATE_DRAFT,
  DELIVERY_NOTE: PERMISSIONS.DELIVERY_NOTES_UPDATE_DRAFT,
};

const ISSUE_PERMISSION: Record<DocumentType, Permission> = {
  QUOTATION: PERMISSIONS.QUOTATIONS_ISSUE,
  INVOICE: PERMISSIONS.INVOICES_ISSUE,
  DELIVERY_NOTE: PERMISSIONS.DELIVERY_NOTES_ISSUE,
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

/** Voids an issued invoice, keeping the row and number for the trail. */
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
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INVOICES_VOID,
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

/** Records a payment against an invoice; the status is then derived. */
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
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INVOICES_ISSUE,
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
    const context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INVOICES_ISSUE,
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
