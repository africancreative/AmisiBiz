import { compareDecimalStrings } from "./decimal";
import type { DocumentType } from "./series";

/**
 * The document lifecycle state machine.
 *
 * The status that a document may move to is decided here, from the document's
 * TYPE and its current status — never from a status string that arrived from the
 * browser. The same rule is enforced a second time by the
 * `document_status_matches_type` CHECK and by the immutability trigger, so a
 * code path that forgot this module cannot write a state the database forbids.
 *
 * Two things this file is deliberately explicit about:
 *
 *  - Payments do not "set" an invoice to PAID. `PAID`, `PARTIALLY_PAID` and
 *    `OVERDUE` are DERIVED from recorded payment rows (and the due date), so the
 *    function that computes them lives beside the payment operations; this
 *    machine only says which moves are structurally possible.
 *  - A quotation that has been superseded by an invoice is not edited. An
 *    accepted quotation is frozen; converting it produces a NEW invoice.
 */

export type DocumentStatus =
  | "DRAFT"
  | "ISSUED"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "VOID"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED";

type Transitions = Readonly<Record<string, readonly DocumentStatus[]>>;

/**
 * Allowed next statuses per type. A missing key means "terminal for this type":
 * nothing may follow, which is the right default for a state nobody enumerated.
 */
const TRANSITIONS: Readonly<Record<DocumentType, Transitions>> = {
  QUOTATION: {
    DRAFT: ["ISSUED"],
    ISSUED: ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  },
  INVOICE: {
    DRAFT: ["ISSUED"],
    ISSUED: ["PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"],
    // A reversed payment moves a paid invoice back to partially paid; a
    // corrected due date can move it from overdue back to issued.
    PARTIALLY_PAID: ["PAID", "OVERDUE", "ISSUED", "VOID"],
    PAID: ["PARTIALLY_PAID", "VOID"],
    OVERDUE: ["PARTIALLY_PAID", "PAID", "VOID"],
  },
  DELIVERY_NOTE: {
    DRAFT: ["ISSUED"],
    ISSUED: ["PARTIALLY_DELIVERED", "DELIVERED", "CANCELLED"],
    PARTIALLY_DELIVERED: ["DELIVERED"],
  },
  // An order behaves like an invoice for payment (DRAFT→ISSUED→paid/overdue,
  // all derived from recorded payments — never clicked) and adds CANCELLED for
  // the unfulfilled-order exit. VOID stays the issued-order correction path.
  ORDER: {
    DRAFT: ["ISSUED"],
    ISSUED: ["PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED", "VOID"],
    PARTIALLY_PAID: ["PAID", "OVERDUE", "ISSUED", "CANCELLED", "VOID"],
    PAID: ["PARTIALLY_PAID", "VOID"],
    OVERDUE: ["PARTIALLY_PAID", "PAID", "VOID"],
  },
};

export class DocumentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentLifecycleError";
  }
}

/** The statuses defined for a type, in lifecycle order. */
export function documentStatusesForType(
  type: DocumentType,
): readonly DocumentStatus[] {
  return Object.keys(TRANSITIONS[type]) as DocumentStatus[];
}

/** The statuses a document of `type` currently in `from` may move to. */
export function allowedTransitions(
  type: DocumentType,
  from: DocumentStatus,
): readonly DocumentStatus[] {
  return TRANSITIONS[type][from] ?? [];
}

export function canTransition(
  type: DocumentType,
  from: DocumentStatus,
  to: DocumentStatus,
): boolean {
  return allowedTransitions(type, from).includes(to);
}

/** Fails loudly on an illegal move; the caller turns it into a field error. */
export function assertTransition(
  type: DocumentType,
  from: DocumentStatus,
  to: DocumentStatus,
): void {
  if (!canTransition(type, from, to)) {
    throw new DocumentLifecycleError(
      `A ${type} in status ${from} cannot move to ${to}.`,
    );
  }
}

/** A draft is the only editable state: its number is null until issuance. */
export function isEditable(status: DocumentStatus): boolean {
  return status === "DRAFT";
}

/** Anything that is not a draft has been issued and is immutable. */
export function isIssued(status: DocumentStatus): boolean {
  return status !== "DRAFT";
}

/**
 * Only an ACCEPTED quotation may be converted. Converting a merely-issued quote
 * would invoice terms the customer has not agreed to.
 */
export function isConvertibleQuotation(status: DocumentStatus): boolean {
  return status === "ACCEPTED";
}

/**
 * The status an invoice moves to once its recorded payments and due date are
 * taken into account. `paid` and `total` are exact decimal strings.
 *
 * A zero-total invoice is PAID the moment it is issued (nothing is owed); a void
 * invoice keeps its status; otherwise the balance decides.
 */
export function deriveInvoiceStatus(input: {
  total: string;
  paid: string;
  dueDate: Date | null;
  now: Date;
}): DocumentStatus {
  // Comparison is done on the decimal STRINGS, never through `Number(...)`: the
  // amounts here are invoices, not scratch values, and a float comparison can
  // disagree with the stored totals at the last place.
  const paidVersusTotal = compareDecimalStrings(input.paid, input.total) ?? 0;
  const totalVersusZero = compareDecimalStrings(input.total, "0") ?? 0;
  const paidVersusZero = compareDecimalStrings(input.paid, "0") ?? 0;

  if (totalVersusZero <= 0 || paidVersusTotal >= 0) return "PAID";
  if (paidVersusZero > 0) return "PARTIALLY_PAID";
  if (input.dueDate && input.dueDate.getTime() < input.now.getTime()) {
    return "OVERDUE";
  }
  return "ISSUED";
}

/**
 * The status a delivery note moves to once its delivered quantities are known.
 * `delivered` and `ordered` are counts of fully-delivered lines, kept as plain
 * numbers because they are counts, not money.
 */
export function deriveDeliveryStatus(input: {
  orderedLines: number;
  deliveredLines: number;
}): DocumentStatus {
  if (input.orderedLines > 0 && input.deliveredLines >= input.orderedLines) {
    return "DELIVERED";
  }
  if (input.deliveredLines > 0) return "PARTIALLY_DELIVERED";
  return "ISSUED";
}
