import { prisma, type ScopedTx } from "@amisibiz/database";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import {
  addDecimalStrings,
  outstandingBalance,
  sumDecimalStrings,
} from "@amisibiz/documents";
import type { DocumentStatus, DocumentType, Prisma } from "@prisma/client";
import { DocumentServiceError } from "./errors";
import {
  assertDocumentTransition,
  deriveDeliveryStatus,
  deriveInvoiceStatus,
} from "./lifecycle";
import { allocateDocumentNumber } from "./numbering";
import {
  composeDocumentSnapshot,
  brandingFrom,
  customerFrom,
  issuerFrom,
  lineSourceFrom,
  type BrandingSource,
} from "./snapshot";
import {
  resolveLines,
  summarisePriceSources,
  type DocumentLinePayload,
  type ResolvedLines,
} from "./lines";
import { decimalString, decimalStringOrZero } from "./calculations";

/**
 * The document engine: every operation that writes a quotation, invoice or
 * delivery note.
 *
 * The rules it exists to keep, in one place:
 *
 *  - **Drafts are editable and unnumbered.** Nothing is allocated until issue,
 *    so an abandoned draft never burns a number.
 *  - **Issuance is atomic and trusted.** Ownership, RBAC, totals, the number and
 *    the frozen snapshot are all resolved and written inside ONE transaction.
 *    A failure leaves no half-issued document.
 *  - **Issued documents are immutable.** Corrections are a void and a
 *    replacement, never an edit; the database trigger enforces this a second
 *    time.
 *  - **Payment is a fact, status is derived.** Recording a payment writes a row;
 *    `PAID`/`PARTIALLY_PAID`/`OVERDUE` are computed from the rows and the due
 *    date. A browser redirect can never mark an invoice paid.
 *  - **A request never sets a price.** A draft written by a person is priced from
 *    the tenant's catalogue and that customer's agreements (`lines.ts`); a draft
 *    copied from stored rows — issuance, conversion, delivery, replacement — keeps
 *    the figures it already had.
 *
 * The authorization check happens in the Server Action before any of this runs,
 * but it is repeated here as a guard: every function takes the context and treats
 * its `tenantId` as authoritative, never a value from the request body.
 */

const BRANDING_DEFAULTS: BrandingSource = {
  displayName: null,
  tenantName: "",
  primaryColor: "#1d4ed8",
  secondaryColor: "#1e3a5f",
  accentColor: "#f59e0b",
  primaryForeground: "#f8fafc",
  logoUrl: null,
};

export interface CreateDraftInput {
  type: DocumentType;
  contactId: string | null;
  currency: string;
  issueDate: Date;
  dueDate: Date | null;
  expiryDate: Date | null;
  deliveryDate: Date | null;
  customerNote: string | null;
  terms: string | null;
  deliveryNote: string | null;
  sourceDocumentId: string | null;
  replacementOfId: string | null;
  idempotencyKey: string | null;
  lines: DocumentLinePayload[];
}

export interface IssueDocumentInput {
  documentId: string;
  issueDate?: Date | undefined;
  dueDate?: Date | null | undefined;
  expiryDate?: Date | null | undefined;
  deliveryDate?: Date | null | undefined;
  customerNote?: string | null | undefined;
  terms?: string | null | undefined;
  deliveryNote?: string | null | undefined;
}

export interface PaymentInput {
  documentId: string;
  amount: string;
  occurredOn: Date;
  method:
    "CASH" | "BANK_TRANSFER" | "MOBILE_MONEY" | "CARD" | "CHEQUE" | "OTHER";
  reference: string | null;
  note: string | null;
}

export interface DeliveryAcknowledgement {
  lineId: string;
  deliveredQuantity: string;
}

/* ------------------------------- helpers ---------------------------------- */

function totalsData(calculation: ResolvedLines["calculation"]) {
  return {
    subtotal: calculation.subtotal,
    totalDiscount: calculation.totalDiscount,
    taxableBase: calculation.taxableBase,
    taxTotal: calculation.taxTotal,
    total: calculation.total,
    taxBreakdown: calculation.taxBreakdown as unknown as Prisma.InputJsonValue,
  };
}

interface LineRow {
  tenantId: string;
  documentId: string;
  position: number;
  itemId: string | null;
  sourceLineId: string | null;
  description: string;
  itemCode: string | null;
  unitOfMeasure: string;
  quantity: string;
  unitPrice: string;
  discountType: ResolvedLines["mechanisms"][number]["discountType"];
  discountPercent: string;
  discountAmount: string;
  lineTotal: string;
  lineDiscount: string;
  lineNet: string;
  lineTax: string;
  taxRateId: string | null;
  taxName: string | null;
  taxRate: string;
}

function lineRows(
  tenantId: string,
  documentId: string,
  resolved: ResolvedLines,
  sourceLineIds: Array<string | null> = [],
): LineRow[] {
  return resolved.snapshotLines.map((line, index) => {
    const computed = resolved.calculation.lines[index];
    const mechanism = resolved.mechanisms[index];
    if (!computed || !mechanism) {
      throw new DocumentServiceError(
        "VALIDATION",
        "Line totals could not be computed.",
      );
    }
    return {
      tenantId,
      documentId,
      position: index + 1,
      itemId: line.itemId,
      sourceLineId: sourceLineIds[index] ?? null,
      description: line.description,
      itemCode: line.itemCode,
      unitOfMeasure: line.unitOfMeasure,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountType: mechanism.discountType,
      discountPercent: mechanism.discountPercent,
      discountAmount: mechanism.discountAmount,
      lineTotal: computed.lineTotal,
      lineDiscount: computed.lineDiscount,
      lineNet: computed.lineNet,
      lineTax: computed.lineTax,
      taxRateId: line.taxRateId,
      taxName: line.taxName,
      taxRate: line.taxRate,
    };
  });
}

/**
 * A document's printed date as the `YYYY-MM-DD` the agreement-window test wants.
 *
 * The same UTC reading the snapshot uses (`snapshot.ts`), so a document and the
 * agreements applied to it agree on which calendar day it was written on.
 */
function calendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function assertContactInTenant(
  tx: ScopedTx,
  tenantId: string,
  contactId: string | null,
): Promise<void> {
  if (!contactId) return;
  const contact = await tx.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { id: true },
  });
  if (!contact) {
    throw new DocumentServiceError(
      "VALIDATION",
      "The selected customer does not exist in this business.",
      "contactId",
    );
  }
}

async function loadDocumentOrThrow(
  tx: ScopedTx,
  tenantId: string,
  documentId: string,
): Promise<Prisma.DocumentGetPayload<{ include: { lines: true } }>> {
  const document = await tx.document.findFirst({
    where: { id: documentId, tenantId },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!document) {
    // Never disclose whether the id exists in another tenant.
    throw new DocumentServiceError("NOT_FOUND", "Document not found.");
  }
  return document;
}

function assertDraft(document: { status: DocumentStatus }): void {
  if (document.status !== "DRAFT") {
    throw new DocumentServiceError(
      "IMMUTABLE",
      "This document has been issued and cannot be edited. Void and replace it to make a correction.",
    );
  }
}

async function writeStatusEvent(
  tx: ScopedTx,
  input: {
    tenantId: string;
    documentId: string;
    fromStatus: DocumentStatus | null;
    toStatus: DocumentStatus;
    reason?: string | null;
    actorId: string;
  },
): Promise<void> {
  await tx.documentStatusEvent.create({
    data: {
      tenantId: input.tenantId,
      documentId: input.documentId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason ?? null,
      actorId: input.actorId,
    },
  });
}

/* ------------------------------- operations ------------------------------- */

/** Creates a draft. Drafts carry no number and can be edited or deleted. */
export async function createDraft(
  context: TenantAuthzContext,
  actorId: string,
  input: CreateDraftInput,
): Promise<{ id: string }> {
  const tenantId = context.tenantId;

  const created = await prisma.$transaction(async (tx) => {
    await assertContactInTenant(tx, tenantId, input.contactId);

    if (input.idempotencyKey) {
      const existing = await tx.document.findFirst({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      if (existing) return { ...existing, priceSources: null };
    }

    // A request from a browser: every line that names a catalogue item is priced
    // from the tenant's rows, with the customer's agreement taking precedence for
    // the item it was written against. See `lines.ts`.
    const resolved = await resolveLines(tx, tenantId, input.lines, {
      contactId: input.contactId,
      asOf: calendarDate(input.issueDate),
      currency: input.currency,
    });

    const document = await tx.document.create({
      data: {
        tenantId,
        type: input.type,
        status: "DRAFT",
        number: null,
        currency: input.currency,
        contactId: input.contactId,
        sourceDocumentId: input.sourceDocumentId,
        replacementOfId: input.replacementOfId,
        idempotencyKey: input.idempotencyKey,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        expiryDate: input.expiryDate,
        deliveryDate: input.deliveryDate,
        customerNote: input.customerNote,
        terms: input.terms,
        deliveryNote: input.deliveryNote,
        ...totalsData(resolved.calculation),
      },
      select: { id: true },
    });

    await tx.documentLine.createMany({
      data: lineRows(tenantId, document.id, resolved),
    });
    await writeStatusEvent(tx, {
      tenantId,
      documentId: document.id,
      fromStatus: null,
      toStatus: "DRAFT",
      actorId,
    });
    return { id: document.id, priceSources: resolved.priceSources };
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_CREATED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: created.id,
    // Counts only — no prices, no customer, no item names. Enough for an auditor
    // to see that agreed prices were used, small enough to keep the log clean.
    metadata: {
      type: input.type,
      ...(created.priceSources
        ? { pricing: summarisePriceSources(created.priceSources) }
        : {}),
    },
  });

  return { id: created.id };
}

export interface UpdateDraftInput extends Omit<
  CreateDraftInput,
  "type" | "idempotencyKey"
> {
  documentId: string;
}

/** Replaces a draft's header and lines. Refuses anything already issued. */
export async function updateDraft(
  context: TenantAuthzContext,
  actorId: string,
  input: UpdateDraftInput,
): Promise<{ id: string }> {
  const tenantId = context.tenantId;

  const priceSources = await prisma.$transaction(async (tx) => {
    const document = await loadDocumentOrThrow(tx, tenantId, input.documentId);
    assertDraft(document);
    await assertContactInTenant(tx, tenantId, input.contactId);

    // Re-priced from the catalogue on every save, exactly like a create: the form
    // is a request, and a request never sets a price.
    const resolved = await resolveLines(tx, tenantId, input.lines, {
      contactId: input.contactId,
      asOf: calendarDate(input.issueDate),
      currency: input.currency,
    });

    await tx.document.update({
      where: { id: document.id },
      data: {
        contactId: input.contactId,
        currency: input.currency,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        expiryDate: input.expiryDate,
        deliveryDate: input.deliveryDate,
        customerNote: input.customerNote,
        terms: input.terms,
        deliveryNote: input.deliveryNote,
        sourceDocumentId: input.sourceDocumentId,
        replacementOfId: input.replacementOfId,
        ...totalsData(resolved.calculation),
      },
    });

    // A draft's lines are fully replaceable; there is no history to preserve
    // because nothing has been issued.
    await tx.documentLine.deleteMany({
      where: { tenantId, documentId: document.id },
    });
    await tx.documentLine.createMany({
      data: lineRows(tenantId, document.id, resolved),
    });

    return resolved.priceSources;
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_UPDATED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: input.documentId,
    metadata: { pricing: summarisePriceSources(priceSources) },
  });

  return { id: input.documentId };
}

/** Required date per type, so an issued document satisfies the DB CHECKs too. */
function requiredDateProblem(
  type: DocumentType,
  input: {
    dueDate: Date | null;
    expiryDate: Date | null;
    deliveryDate: Date | null;
  },
): string | null {
  if (type === "INVOICE" && !input.dueDate) {
    return "An issued invoice needs a due date.";
  }
  if (type === "QUOTATION" && !input.expiryDate) {
    return "An issued quotation needs an expiry (valid-until) date.";
  }
  if (type === "DELIVERY_NOTE" && !input.deliveryDate) {
    return "An issued delivery note needs a delivery date.";
  }
  return null;
}

async function loadBrandingAndIssuer(
  tx: ScopedTx,
  tenantId: string,
): Promise<{
  issuer: ReturnType<typeof issuerFrom>;
  branding: ReturnType<typeof brandingFrom>;
  /** Default footer and payment instructions, frozen into the snapshot. */
  defaultFooter: string | null;
  paymentInstructions: string | null;
}> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, currency: true },
  });
  if (!tenant) {
    throw new DocumentServiceError("NOT_FOUND", "Business not found.");
  }
  const brandingRow = await tx.tenantBranding.findUnique({
    where: { tenantId },
  });

  const source: BrandingSource = brandingRow
    ? {
        displayName: brandingRow.displayName,
        tenantName: tenant.name,
        primaryColor: brandingRow.primaryColor,
        secondaryColor: brandingRow.secondaryColor,
        accentColor: brandingRow.accentColor,
        primaryForeground: brandingRow.primaryForeground,
        logoUrl: brandingRow.logoUrl,
      }
    : { ...BRANDING_DEFAULTS, tenantName: tenant.name };

  return {
    issuer: issuerFrom({
      tenantId,
      tenantName: tenant.name,
      displayName: source.displayName,
      registeredName: brandingRow?.registeredName ?? null,
      taxPin: brandingRow?.taxPin ?? null,
      contactEmail: brandingRow?.contactEmail ?? null,
      contactPhone: brandingRow?.contactPhone ?? null,
      postalAddress: brandingRow?.postalAddress ?? null,
      physicalAddress: brandingRow?.physicalAddress ?? null,
      website: brandingRow?.website ?? null,
    }),
    branding: brandingFrom(source),
    defaultFooter: brandingRow?.defaultFooter ?? null,
    paymentInstructions: brandingRow?.paymentInstructions ?? null,
  };
}

/**
 * Issues a draft: allocates the number and freezes the snapshot, atomically.
 *
 * The order matters. Ownership and the required dates are checked first, then
 * the number is allocated while the counter row is locked, then the snapshot is
 * built from the rows as they are NOW, then everything is written in the one
 * transaction. If any step fails the transaction rolls back and the number is
 * returned to the series — an allocated-then-abandoned number would be a real
 * gap an auditor would have to explain.
 */
export async function issueDocument(
  context: TenantAuthzContext,
  actorId: string,
  input: IssueDocumentInput,
): Promise<{ id: string; number: string }> {
  const tenantId = context.tenantId;

  const result = await prisma.$transaction(async (tx) => {
    const document = await loadDocumentOrThrow(tx, tenantId, input.documentId);
    assertDraft(document);

    if (!document.contactId) {
      throw new DocumentServiceError(
        "VALIDATION",
        "An issued document needs a customer.",
        "contactId",
      );
    }

    const issueDate = input.issueDate ?? document.issueDate;
    const dueDate = input.dueDate ?? document.dueDate;
    const expiryDate = input.expiryDate ?? document.expiryDate;
    const deliveryDate = input.deliveryDate ?? document.deliveryDate;

    const dateProblem = requiredDateProblem(document.type, {
      dueDate,
      expiryDate,
      deliveryDate,
    });
    if (dateProblem) {
      throw new DocumentServiceError("VALIDATION", dateProblem);
    }

    if (document.lines.length === 0) {
      throw new DocumentServiceError(
        "VALIDATION",
        "An issued document needs at least one line.",
        "lines",
      );
    }

    // Recalculate totals from the stored lines. The stored values were computed
    // the same way when the draft was written; recomputing proves they still hold
    // (a decimal policy change, a hand-edited row) before they are frozen.
    //
    // `source: "stored"` on purpose: issuance does NOT re-price. What gets frozen
    // is what the operator reviewed on the draft, so a catalogue edit or an
    // agreement expiring between the draft and the issue cannot change a document
    // on its way out — that would be the re-pricing an auditor would call a
    // rewrite. Re-pricing is a human decision, made by editing the draft.
    const resolved = await resolveLines(
      tx,
      tenantId,
      document.lines.map<DocumentLinePayload>((line) => ({
        itemId: line.itemId,
        description: line.description,
        itemCode: line.itemCode,
        unitOfMeasure: line.unitOfMeasure,
        quantity: decimalString(line.quantity),
        unitPrice: decimalString(line.unitPrice),
        discountType: line.discountType,
        discountPercent: decimalStringOrZero(line.discountPercent),
        discountAmount: decimalStringOrZero(line.discountAmount),
        taxRateId: line.taxRateId,
      })),
      { source: "stored" },
    );

    const contact = await tx.contact.findUnique({
      where: { id: document.contactId },
      include: { addresses: true },
    });
    if (!contact) {
      throw new DocumentServiceError(
        "VALIDATION",
        "The customer no longer exists.",
        "contactId",
      );
    }

    const { issuer, branding, defaultFooter, paymentInstructions } =
      await loadBrandingAndIssuer(tx, tenantId);
    const number = await allocateDocumentNumber(tx, {
      tenantId,
      type: document.type,
      date: issueDate.toISOString().slice(0, 10),
    });

    const snapshot = composeDocumentSnapshot({
      type: document.type,
      number,
      currency: document.currency,
      issueDate,
      dueDate,
      expiryDate,
      deliveryDate,
      terms: input.terms ?? document.terms,
      customerNote: input.customerNote ?? document.customerNote,
      // Payment instructions and the footer are branding defaults captured at
      // issuance. They are copied, never referenced, so a later branding edit
      // cannot rewrite the instructions printed on an issued invoice.
      paymentInstructions,
      footer: defaultFooter,
      issuer,
      customer: customerFrom(contact),
      lines: document.lines.map((line) => {
        const source = lineSourceFrom(line);
        return source;
      }),
      branding,
      generatedAt: new Date(),
    });

    const issuedAt = new Date();
    await tx.document.update({
      where: { id: document.id },
      data: {
        status: "ISSUED",
        number,
        issueDate,
        dueDate,
        expiryDate,
        deliveryDate,
        customerNote: input.customerNote ?? document.customerNote,
        terms: input.terms ?? document.terms,
        deliveryNote: input.deliveryNote ?? document.deliveryNote,
        issuedAt,
        issuedById: actorId,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotAt: issuedAt,
        ...totalsData(resolved.calculation),
      },
    });

    // A delivery note moves the delivered counters on its source lines. That is
    // a delivery fact, not an edit of the sales document, which is exactly why
    // the database permits it after issue.
    if (document.type === "DELIVERY_NOTE") {
      for (const line of document.lines) {
        if (!line.sourceLineId) continue;
        const sourceLine = await tx.documentLine.findFirst({
          where: { id: line.sourceLineId, tenantId },
          select: { id: true, quantity: true, deliveredQuantity: true },
        });
        if (!sourceLine) {
          throw new DocumentServiceError(
            "VALIDATION",
            "A delivery line points at a source line that no longer exists.",
          );
        }
        const delivered = addDecimalStrings(
          decimalStringOrZero(sourceLine.deliveredQuantity),
          decimalString(line.quantity),
        );
        if (
          delivered === null ||
          Number(delivered) > Number(sourceLine.quantity)
        ) {
          throw new DocumentServiceError(
            "VALIDATION",
            "This delivery would exceed the quantity ordered on the source document.",
          );
        }
        await tx.documentLine.update({
          where: { id: sourceLine.id },
          // The CUMULATIVE delivered quantity. A source line may be delivered
          // across several notes, so writing just this note's quantity would
          // rewrite the history and let the same goods be delivered twice.
          data: { deliveredQuantity: delivered },
        });
      }
    }

    await writeStatusEvent(tx, {
      tenantId,
      documentId: document.id,
      fromStatus: document.status,
      toStatus: "ISSUED",
      actorId,
    });

    // A zero-total invoice is paid the moment it is issued: nothing is owed.
    if (
      document.type === "INVOICE" &&
      Number(resolved.calculation.total) <= 0
    ) {
      await tx.document.update({
        where: { id: document.id },
        data: { status: "PAID" },
      });
      await writeStatusEvent(tx, {
        tenantId,
        documentId: document.id,
        fromStatus: "ISSUED",
        toStatus: "PAID",
        reason: "Zero-total invoice",
        actorId,
      });
    }

    return { id: document.id, number };
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_ISSUED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: result.id,
    metadata: { number: result.number },
  });

  return result;
}

/** Voids an issued invoice, keeping the row and its number for the trail. */
export async function voidInvoice(
  context: TenantAuthzContext,
  actorId: string,
  input: { documentId: string; reason: string },
): Promise<void> {
  const tenantId = context.tenantId;

  await prisma.$transaction(async (tx) => {
    const document = await loadDocumentOrThrow(tx, tenantId, input.documentId);
    if (document.type !== "INVOICE") {
      throw new DocumentServiceError(
        "VALIDATION",
        "Only invoices can be voided.",
      );
    }
    assertDocumentTransition(document.type, document.status, "VOID");

    const voidedAt = new Date();
    await tx.document.update({
      where: { id: document.id },
      data: {
        status: "VOID",
        voidedAt,
        voidedById: actorId,
        voidReason: input.reason,
      },
    });
    await writeStatusEvent(tx, {
      tenantId,
      documentId: document.id,
      fromStatus: document.status,
      toStatus: "VOID",
      reason: input.reason,
      actorId,
    });
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_VOIDED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: input.documentId,
  });
}

const QUOTATION_DECISIONS = {
  ACCEPTED: AUDIT_ACTIONS.DOCUMENT_QUOTATION_ACCEPTED,
  REJECTED: AUDIT_ACTIONS.DOCUMENT_QUOTATION_REJECTED,
  EXPIRED: AUDIT_ACTIONS.DOCUMENT_QUOTATION_EXPIRED,
  CANCELLED: AUDIT_ACTIONS.DOCUMENT_QUOTATION_CANCELLED,
} as const;

export type QuotationDecision = keyof typeof QUOTATION_DECISIONS;

/** Records a customer's answer to an issued quotation. */
export async function recordQuotationDecision(
  context: TenantAuthzContext,
  actorId: string,
  input: {
    documentId: string;
    decision: QuotationDecision;
    reason?: string | null;
  },
): Promise<void> {
  const tenantId = context.tenantId;

  await prisma.$transaction(async (tx) => {
    const document = await loadDocumentOrThrow(tx, tenantId, input.documentId);
    if (document.type !== "QUOTATION") {
      throw new DocumentServiceError("VALIDATION", "This is not a quotation.");
    }
    assertDocumentTransition(document.type, document.status, input.decision);

    await tx.document.update({
      where: { id: document.id },
      data: { status: input.decision },
    });
    await writeStatusEvent(tx, {
      tenantId,
      documentId: document.id,
      fromStatus: document.status,
      toStatus: input.decision,
      reason: input.reason ?? null,
      actorId,
    });
  });

  await recordAudit({
    action: QUOTATION_DECISIONS[input.decision],
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: input.documentId,
    metadata: { decision: input.decision },
  });
}

async function invoiceBalance(
  tx: ScopedTx,
  tenantId: string,
  documentId: string,
): Promise<{ paid: string; total: string }> {
  const [payments, document] = await Promise.all([
    tx.documentPayment.findMany({
      where: { tenantId, documentId, reversedAt: null },
      select: { amount: true },
    }),
    tx.document.findFirst({
      where: { id: documentId, tenantId },
      select: { total: true },
    }),
  ]);

  return {
    paid: sumDecimalStrings(
      payments.map((payment) => decimalString(payment.amount)),
    ),
    total: document ? decimalString(document.total) : "0",
  };
}

/** Records a payment against an invoice; the invoice status is then derived. */
export async function recordPayment(
  context: TenantAuthzContext,
  actorId: string,
  input: PaymentInput,
): Promise<{ id: string; status: DocumentStatus }> {
  const tenantId = context.tenantId;

  const outcome = await prisma.$transaction(async (tx) => {
    const document = await loadDocumentOrThrow(tx, tenantId, input.documentId);
    if (document.type !== "INVOICE") {
      throw new DocumentServiceError(
        "VALIDATION",
        "Payments can only be recorded against an invoice.",
      );
    }
    if (document.status === "DRAFT") {
      throw new DocumentServiceError(
        "IMMUTABLE",
        "Issue the invoice before recording a payment.",
      );
    }
    if (document.status === "VOID") {
      throw new DocumentServiceError(
        "CONFLICT",
        "A void invoice cannot receive payments.",
      );
    }
    if (Number(input.amount) <= 0) {
      throw new DocumentServiceError(
        "VALIDATION",
        "A payment must be greater than zero.",
        "amount",
      );
    }

    const payment = await tx.documentPayment.create({
      data: {
        tenantId,
        documentId: document.id,
        amount: input.amount,
        occurredOn: input.occurredOn,
        method: input.method,
        reference: input.reference,
        note: input.note,
      },
      select: { id: true },
    });

    const { paid, total } = await invoiceBalance(tx, tenantId, document.id);
    const derived = deriveInvoiceStatus({
      total,
      paid,
      dueDate: document.dueDate,
      now: new Date(),
    });

    if (derived !== document.status) {
      await tx.document.update({
        where: { id: document.id },
        data: { status: derived },
      });
      await writeStatusEvent(tx, {
        tenantId,
        documentId: document.id,
        fromStatus: document.status,
        toStatus: derived,
        reason: "Payment recorded",
        actorId,
      });
    }

    return { id: payment.id, status: derived };
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_PAYMENT_RECORDED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: input.documentId,
    metadata: {
      paymentId: outcome.id,
      amount: input.amount,
      method: input.method,
    },
  });

  return outcome;
}

/** Reverses a payment without deleting it, then re-derives the status. */
export async function reversePayment(
  context: TenantAuthzContext,
  actorId: string,
  input: { paymentId: string; reason: string },
): Promise<void> {
  const tenantId = context.tenantId;

  await prisma.$transaction(async (tx) => {
    const payment = await tx.documentPayment.findFirst({
      where: { id: input.paymentId, tenantId },
      include: {
        document: {
          select: { id: true, type: true, status: true, dueDate: true },
        },
      },
    });
    if (!payment) {
      throw new DocumentServiceError("NOT_FOUND", "Payment not found.");
    }
    if (payment.reversedAt) {
      throw new DocumentServiceError(
        "CONFLICT",
        "This payment has already been reversed.",
      );
    }

    // Only the reversal pair may move: the append-only trigger refuses a change
    // to `note` (or any other business column), so the operator's reason is
    // recorded on the status event and the audit row instead of overwriting the
    // payment's original note. That keeps the payment row a faithful record of
    // what was entered and still makes the reversal auditable with its reason.
    const reversedAt = new Date();
    await tx.documentPayment.update({
      where: { id: payment.id },
      data: { reversedAt, reversedBy: actorId },
    });

    const { paid, total } = await invoiceBalance(
      tx,
      tenantId,
      payment.documentId,
    );
    const derived = deriveInvoiceStatus({
      total,
      paid,
      dueDate: payment.document.dueDate,
      now: new Date(),
    });

    if (derived !== payment.document.status) {
      await tx.document.update({
        where: { id: payment.documentId },
        data: { status: derived },
      });
      await writeStatusEvent(tx, {
        tenantId,
        documentId: payment.documentId,
        fromStatus: payment.document.status,
        toStatus: derived,
        reason: input.reason,
        actorId,
      });
    }
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_PAYMENT_REVERSED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: input.paymentId,
    // The reason is a required field of the reversal and lives here (and on the
    // status event when the reversal moved the status). It is deliberately not
    // written onto the payment row: the append-only trigger forbids that, and
    // overwriting the original note would destroy what was entered.
    metadata: { reason: input.reason },
  });
}

function linePayloadFromStoredLine(
  line: Prisma.DocumentLineGetPayload<Record<string, never>>,
): DocumentLinePayload {
  return {
    itemId: line.itemId,
    description: line.description,
    itemCode: line.itemCode,
    unitOfMeasure: line.unitOfMeasure,
    quantity: decimalString(line.quantity),
    unitPrice: decimalString(line.unitPrice),
    discountType: line.discountType,
    discountPercent: decimalStringOrZero(line.discountPercent),
    discountAmount: decimalStringOrZero(line.discountAmount),
    taxRateId: line.taxRateId,
  };
}

/**
 * Converts an ACCEPTED quotation into a draft invoice, copying the customer,
 * currency, descriptions, prices, discounts and tax exactly.
 *
 * It is deliberately a DRAFT: the conversion preserves what the customer agreed
 * to, and any adjustment is then an explicit, authorized, audited edit before
 * the invoice is issued. The uniqueness index on `sourceDocumentId` (for
 * invoices) makes a retried conversion return the first invoice rather than
 * create a second; `idempotencyKey` does the same for a genuinely concurrent
 * retry.
 */
export async function convertQuotationToInvoice(
  context: TenantAuthzContext,
  actorId: string,
  input: {
    quotationId: string;
    dueDate?: Date | null;
    issueDate?: Date | null;
  },
): Promise<{ id: string }> {
  const tenantId = context.tenantId;

  const created = await prisma.$transaction(async (tx) => {
    const quotation = await loadDocumentOrThrow(
      tx,
      tenantId,
      input.quotationId,
    );
    if (quotation.type !== "QUOTATION") {
      throw new DocumentServiceError(
        "VALIDATION",
        "Only a quotation can be converted to an invoice.",
      );
    }
    if (quotation.status !== "ACCEPTED") {
      throw new DocumentServiceError(
        "CONFLICT",
        "Only an accepted quotation can be converted to an invoice.",
      );
    }

    const existing = await tx.document.findFirst({
      where: { tenantId, sourceDocumentId: quotation.id, type: "INVOICE" },
      select: { id: true },
    });
    if (existing) return existing;

    const issueDate = input.issueDate ?? new Date();
    const dueDate =
      input.dueDate ?? new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);

    const resolved = await resolveLines(
      tx,
      tenantId,
      quotation.lines.map((line) => linePayloadFromStoredLine(line)),
      // The prices the customer ACCEPTED are the ones the invoice must carry, so
      // a catalogue edit since the quotation was written changes nothing here.
      { source: "stored" },
    );

    const invoice = await tx.document.create({
      data: {
        tenantId,
        type: "INVOICE",
        status: "DRAFT",
        number: null,
        currency: quotation.currency,
        contactId: quotation.contactId,
        sourceDocumentId: quotation.id,
        issueDate,
        dueDate,
        customerNote: quotation.customerNote,
        terms: quotation.terms,
        ...totalsData(resolved.calculation),
      },
      select: { id: true },
    });

    await tx.documentLine.createMany({
      data: lineRows(tenantId, invoice.id, resolved),
    });
    await writeStatusEvent(tx, {
      tenantId,
      documentId: invoice.id,
      fromStatus: null,
      toStatus: "DRAFT",
      reason: "Converted from quotation",
      actorId,
    });

    return invoice;
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_CONVERTED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: created.id,
    metadata: { from: input.quotationId, to: "INVOICE" },
  });

  return created;
}

/**
 * Creates a draft delivery note from an issued invoice, defaulting each line to
 * the quantity still outstanding. Partial deliveries are the norm, so several
 * notes may reference one source; uniqueness there comes from `idempotencyKey`,
 * not from the source id.
 */
export async function createDeliveryNoteFromDocument(
  context: TenantAuthzContext,
  actorId: string,
  input: {
    sourceDocumentId: string;
    deliveryDate?: Date | null;
    idempotencyKey?: string | null;
  },
): Promise<{ id: string }> {
  const tenantId = context.tenantId;

  const created = await prisma.$transaction(async (tx) => {
    const source = await loadDocumentOrThrow(
      tx,
      tenantId,
      input.sourceDocumentId,
    );
    if (source.type !== "INVOICE" && source.type !== "DELIVERY_NOTE") {
      throw new DocumentServiceError(
        "VALIDATION",
        "A delivery note can only be raised against an invoice.",
      );
    }
    if (source.status === "DRAFT") {
      throw new DocumentServiceError(
        "CONFLICT",
        "Issue the source document before delivering against it.",
      );
    }

    if (input.idempotencyKey) {
      const existing = await tx.document.findFirst({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      if (existing) return existing;
    }

    const sourceLineIds: string[] = [];
    const payloads: DocumentLinePayload[] = [];
    for (const line of source.lines) {
      const remaining = outstandingBalance(
        decimalString(line.quantity),
        decimalStringOrZero(line.deliveredQuantity),
      );
      if (Number(remaining) <= 0) continue;
      payloads.push({
        ...linePayloadFromStoredLine(line),
        quantity: remaining,
      });
      sourceLineIds.push(line.id);
    }

    if (payloads.length === 0) {
      throw new DocumentServiceError(
        "CONFLICT",
        "Everything on this document has already been delivered.",
      );
    }

    const resolved = await resolveLines(tx, tenantId, payloads, {
      // A delivery note delivers what was already sold, at the figures on the
      // source document — never at today's catalogue price.
      source: "stored",
    });

    const note = await tx.document.create({
      data: {
        tenantId,
        type: "DELIVERY_NOTE",
        status: "DRAFT",
        number: null,
        currency: source.currency,
        contactId: source.contactId,
        sourceDocumentId: source.id,
        idempotencyKey: input.idempotencyKey ?? null,
        issueDate: input.deliveryDate ?? new Date(),
        deliveryDate: input.deliveryDate ?? new Date(),
        ...totalsData(resolved.calculation),
      },
      select: { id: true },
    });

    await tx.documentLine.createMany({
      data: lineRows(tenantId, note.id, resolved, sourceLineIds),
    });
    await writeStatusEvent(tx, {
      tenantId,
      documentId: note.id,
      fromStatus: null,
      toStatus: "DRAFT",
      reason: "Raised from source document",
      actorId,
    });

    return note;
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_CREATED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: created.id,
    metadata: { type: "DELIVERY_NOTE", from: input.sourceDocumentId },
  });

  return created;
}

/**
 * Records which quantities on a delivery note the customer has acknowledged.
 *
 * Kept separate from issuance and from payments on purpose: what was delivered
 * and what was paid are two different questions, and conflating them is how a
 * system ends up marking an unpaid invoice paid because the goods arrived.
 */
export async function recordDelivery(
  context: TenantAuthzContext,
  actorId: string,
  input: { documentId: string; acknowledgements: DeliveryAcknowledgement[] },
): Promise<{ status: DocumentStatus }> {
  const tenantId = context.tenantId;

  const outcome = await prisma.$transaction(async (tx) => {
    const document = await loadDocumentOrThrow(tx, tenantId, input.documentId);
    if (document.type !== "DELIVERY_NOTE") {
      throw new DocumentServiceError(
        "VALIDATION",
        "Deliveries are recorded against a delivery note.",
      );
    }
    if (document.status === "DRAFT") {
      throw new DocumentServiceError(
        "CONFLICT",
        "Issue the delivery note before acknowledging delivery.",
      );
    }

    const byId = new Map(document.lines.map((line) => [line.id, line]));
    for (const acknowledgement of input.acknowledgements) {
      const line = byId.get(acknowledgement.lineId);
      if (!line) {
        throw new DocumentServiceError(
          "VALIDATION",
          "A line does not belong to this delivery note.",
        );
      }
      const quantity = decimalStringOrZero(line.quantity);
      const current = decimalStringOrZero(line.deliveredQuantity);
      if (Number(acknowledgement.deliveredQuantity) < Number(current)) {
        throw new DocumentServiceError(
          "VALIDATION",
          "A recorded delivery cannot be reduced; record a correction instead.",
        );
      }
      if (Number(acknowledgement.deliveredQuantity) > Number(quantity)) {
        throw new DocumentServiceError(
          "VALIDATION",
          "Delivered quantity cannot exceed the quantity on the line.",
        );
      }
      await tx.documentLine.update({
        where: { id: line.id },
        data: { deliveredQuantity: acknowledgement.deliveredQuantity },
      });
      line.deliveredQuantity =
        acknowledgement.deliveredQuantity as unknown as typeof line.deliveredQuantity;
    }

    const orderedLines = document.lines.length;
    const deliveredLines = document.lines.filter(
      (line) =>
        Number(decimalStringOrZero(line.deliveredQuantity)) >=
        Number(decimalString(line.quantity)),
    ).length;
    const derived = deriveDeliveryStatus({ orderedLines, deliveredLines });

    if (derived !== document.status) {
      if (derived !== "ISSUED") {
        assertDocumentTransition(document.type, document.status, derived);
      }
      await tx.document.update({
        where: { id: document.id },
        data: { status: derived },
      });
      await writeStatusEvent(tx, {
        tenantId,
        documentId: document.id,
        fromStatus: document.status,
        toStatus: derived,
        reason: "Delivery acknowledged",
        actorId,
      });
    }

    return { status: derived };
  });

  await recordAudit({
    action:
      outcome.status === "DELIVERED"
        ? AUDIT_ACTIONS.DOCUMENT_DELIVERED
        : AUDIT_ACTIONS.DOCUMENT_DELIVERY_RECORDED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: input.documentId,
    metadata: { status: outcome.status },
  });

  return outcome;
}

/**
 * Creates a replacement draft for a voided invoice, copying its content and
 * linking `replacementOfId`. This is the only sanctioned way to "correct" an
 * issued document: the wrong one stays on the record, voided, and a new number
 * is issued for the right one.
 */
export async function createReplacementDraft(
  context: TenantAuthzContext,
  actorId: string,
  input: { documentId: string },
): Promise<{ id: string }> {
  const tenantId = context.tenantId;

  const created = await prisma.$transaction(async (tx) => {
    const original = await loadDocumentOrThrow(tx, tenantId, input.documentId);
    if (original.status !== "VOID") {
      throw new DocumentServiceError(
        "CONFLICT",
        "Only a voided document can be replaced.",
      );
    }

    const resolved = await resolveLines(
      tx,
      tenantId,
      original.lines.map((line) => linePayloadFromStoredLine(line)),
      // A replacement CORRECTS a document; it is not a re-pricing of one. The
      // copied lines keep their figures, and any price change is an explicit,
      // authorized edit of the new draft before it is issued.
      { source: "stored" },
    );

    const replacement = await tx.document.create({
      data: {
        tenantId,
        type: original.type,
        status: "DRAFT",
        number: null,
        currency: original.currency,
        contactId: original.contactId,
        replacementOfId: original.id,
        issueDate: new Date(),
        dueDate: original.dueDate,
        expiryDate: original.expiryDate,
        deliveryDate: original.deliveryDate,
        customerNote: original.customerNote,
        terms: original.terms,
        ...totalsData(resolved.calculation),
      },
      select: { id: true },
    });

    await tx.documentLine.createMany({
      data: lineRows(tenantId, replacement.id, resolved),
    });
    await writeStatusEvent(tx, {
      tenantId,
      documentId: replacement.id,
      fromStatus: null,
      toStatus: "DRAFT",
      reason: "Replacement for voided document",
      actorId,
    });

    return replacement;
  });

  await recordAudit({
    action: AUDIT_ACTIONS.DOCUMENT_CREATED,
    userId: actorId,
    tenantId,
    resource: "Document",
    resourceId: created.id,
    metadata: { replacementOf: input.documentId },
  });

  return created;
}

/** Loads one document with its lines, scoped to the context's tenant. */
export async function getDocumentWithLines(
  context: TenantAuthzContext,
  documentId: string,
): Promise<
  Prisma.DocumentGetPayload<{ include: { lines: true; payments: true } }>
> {
  const document = await prisma.document.findFirst({
    where: { id: documentId, tenantId: context.tenantId },
    include: {
      lines: { orderBy: { position: "asc" } },
      payments: { orderBy: { occurredOn: "desc" } },
    },
  });
  if (!document) {
    throw new DocumentServiceError("NOT_FOUND", "Document not found.");
  }
  return document;
}
