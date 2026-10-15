import {
  calculateDocument,
  calculateLine,
  DOCUMENT_ROUNDING_POLICY,
  type DocumentDiscountType,
  type TaxBreakdownEntry,
} from "./calculations";
import type { DocumentType } from "./series";

/**
 * The issued-document snapshot.
 *
 * A quotation, invoice or delivery note is rendered — to PDF, to the screen, to
 * a mobile share sheet — from THIS structure and nothing else. It is captured
 * once, at issuance, inside the issuance transaction, and the database trigger
 * then refuses any later write to it. That is the whole mechanism by which
 * "editing a contact changes the phone number on last year's invoice" cannot
 * happen: the invoice does not read the contact, it reads its snapshot.
 *
 * The snapshot is self-contained by construction. It copies the issuer's
 * branding and address, the customer's details, and every line's description,
 * code, unit, prices, discount and tax — and it recomputes the totals from those
 * copied lines with the same pure engine the stored columns came from, so the
 * two can never disagree.
 */

export const DOCUMENT_SNAPSHOT_VERSION = 1;

export interface SnapshotIssuer {
  tenantId: string;
  displayName: string;
  registeredName: string | null;
  taxPin: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  postalAddress: string | null;
  physicalAddress: string | null;
  website: string | null;
}

export interface SnapshotCustomer {
  contactId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  taxPin: string | null;
  /** A single formatted address line, or null. */
  address: string | null;
}

/** The descriptive, frozen facts of one line (no totals yet). */
export interface SnapshotLineInput {
  position: number;
  itemId: string | null;
  itemCode: string | null;
  description: string;
  unitOfMeasure: string;
  quantity: string;
  unitPrice: string;
  discountType: DocumentDiscountType | null;
  /** Input mechanism value (0 unless PERCENT). */
  discountPercent: string;
  /** Input mechanism value (0 unless AMOUNT). */
  discountAmount: string;
  taxRateId: string | null;
  taxName: string | null;
  /** Tax fraction 0–1. */
  taxRate: string;
}

/** A stored line plus its computed totals. */
export interface SnapshotLine extends SnapshotLineInput {
  lineTotal: string;
  lineDiscount: string;
  lineNet: string;
  lineTax: string;
}

export interface SnapshotBranding {
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  primaryForeground: string;
  logoUrl: string | null;
}

export interface DocumentSnapshot {
  /** Bumped only if the shape changes in a way a renderer must understand. */
  version: number;
  type: DocumentType;
  number: string;
  currency: string;
  /** ISO-8601 date (issue/due/expiry/delivery are calendar dates). */
  issueDate: string;
  dueDate: string | null;
  expiryDate: string | null;
  deliveryDate: string | null;
  terms: string | null;
  customerNote: string | null;
  paymentInstructions: string | null;
  footer: string | null;
  issuer: SnapshotIssuer;
  customer: SnapshotCustomer;
  lines: SnapshotLine[];
  subtotal: string;
  totalDiscount: string;
  taxableBase: string;
  taxTotal: string;
  total: string;
  taxBreakdown: TaxBreakdownEntry[];
  roundingPolicy: string;
  branding: SnapshotBranding;
  /** ISO-8601 timestamp of when the snapshot was taken. */
  generatedAt: string;
}

export interface BuildDocumentSnapshotInput {
  type: DocumentType;
  number: string;
  currency: string;
  issueDate: Date;
  dueDate: Date | null;
  expiryDate: Date | null;
  deliveryDate: Date | null;
  terms: string | null;
  customerNote: string | null;
  paymentInstructions: string | null;
  footer: string | null;
  issuer: SnapshotIssuer;
  customer: SnapshotCustomer;
  lines: SnapshotLineInput[];
  branding: SnapshotBranding;
  /** Defaults to `DOCUMENT_ROUNDING_POLICY`; recorded so the policy is frozen. */
  roundingPolicy?: string;
  generatedAt: Date;
}

/** A calendar date as `YYYY-MM-DD`, taken in UTC. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoDateOrNull(date: Date | null): string | null {
  return date ? isoDate(date) : null;
}

/**
 * Builds the frozen snapshot and, in doing so, computes the line and document
 * totals that the same call writes to the stored columns. There is deliberately
 * no way to pass totals in: they are always derived from the copied lines, so an
 * issued document cannot carry a total that disagrees with its own lines.
 */
export function buildDocumentSnapshot(
  input: BuildDocumentSnapshotInput,
): DocumentSnapshot {
  const lines: SnapshotLine[] = input.lines.map((line) => {
    const computed = calculateLine({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discountPercent: line.discountPercent,
      discountAmount: line.discountAmount,
      taxRate: line.taxRate,
      taxName: line.taxName,
    });
    return { ...line, ...computed };
  });

  const totals = calculateDocument({
    lines: input.lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discountPercent: line.discountPercent,
      discountAmount: line.discountAmount,
      taxRate: line.taxRate,
      taxName: line.taxName,
    })),
  });

  return {
    version: DOCUMENT_SNAPSHOT_VERSION,
    type: input.type,
    number: input.number,
    currency: input.currency,
    issueDate: isoDate(input.issueDate),
    dueDate: isoDateOrNull(input.dueDate),
    expiryDate: isoDateOrNull(input.expiryDate),
    deliveryDate: isoDateOrNull(input.deliveryDate),
    terms: input.terms,
    customerNote: input.customerNote,
    paymentInstructions: input.paymentInstructions,
    footer: input.footer,
    issuer: input.issuer,
    customer: input.customer,
    lines,
    subtotal: totals.subtotal,
    totalDiscount: totals.totalDiscount,
    taxableBase: totals.taxableBase,
    taxTotal: totals.taxTotal,
    total: totals.total,
    taxBreakdown: totals.taxBreakdown,
    roundingPolicy: input.roundingPolicy ?? DOCUMENT_ROUNDING_POLICY,
    branding: input.branding,
    generatedAt: input.generatedAt.toISOString(),
  };
}

/**
 * Narrows an unknown `Document.snapshot` JSON value to the model. Returns null
 * for a draft (no snapshot) or anything that is not a v1 snapshot, so a renderer
 * can refuse to print rather than print a half-built document.
 */
export function readDocumentSnapshot(value: unknown): DocumentSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DocumentSnapshot>;
  if (
    candidate.version !== DOCUMENT_SNAPSHOT_VERSION ||
    typeof candidate.number !== "string" ||
    !Array.isArray(candidate.lines)
  ) {
    return null;
  }
  return candidate as DocumentSnapshot;
}

/** Renders a customer's display name from a CRM contact's identifying fields. */
export function contactDisplayName(contact: {
  type: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (contact.type === "BUSINESS") {
    return (
      contact.companyName?.trim() ||
      [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
      "Customer"
    );
  }
  return (
    [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
    contact.companyName?.trim() ||
    "Customer"
  );
}
