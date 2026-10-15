import type { Prisma } from "@prisma/client";
import type { DocumentType } from "@prisma/client";
import {
  buildDocumentSnapshot,
  contactDisplayName,
  type DocumentSnapshot,
  type SnapshotBranding,
  type SnapshotCustomer,
  type SnapshotIssuer,
  type SnapshotLineInput,
} from "@amisibiz/documents";
import { decimalStringOrZero } from "./calculations";

/**
 * Assembles the frozen snapshot from the rows that exist at issuance.
 *
 * This is the ONLY place that reaches into live tenant/contact/catalogue rows to
 * build a document's printed content, and it runs exactly once per document —
 * inside the issuance transaction, before the snapshot is written. Everything it
 * reads is copied, never referenced: the renderer later sees the snapshot, not
 * the rows, so a contact renamed tomorrow leaves yesterday's invoice alone.
 *
 * The mappers take structural inputs (only the fields used) so they can be
 * exercised directly in a test without constructing a Prisma row.
 */

export interface IssuerSource {
  tenantId: string;
  /** Fallback when the tenant has not set a branding display name. */
  tenantName: string;
  displayName: string | null;
  registeredName: string | null;
  taxPin: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  postalAddress: string | null;
  physicalAddress: string | null;
  website: string | null;
}

export interface BrandingSource {
  displayName: string | null;
  tenantName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  primaryForeground: string;
  logoUrl: string | null;
}

export interface CustomerSource {
  id: string;
  type: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  taxPin: string | null;
  addresses?: Array<{
    type: string;
    line1: string;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    isDefault: boolean;
  }>;
}

export interface LineSource {
  itemId: string | null;
  description: string;
  itemCode: string | null;
  unitOfMeasure: string;
  quantity: Prisma.Decimal | string;
  unitPrice: Prisma.Decimal | string;
  discountType: "PERCENT" | "AMOUNT" | null;
  discountPercent: Prisma.Decimal | string;
  discountAmount: Prisma.Decimal | string;
  taxRateId: string | null;
  taxName: string | null;
  taxRate: Prisma.Decimal | string;
}

export function issuerFrom(source: IssuerSource): SnapshotIssuer {
  return {
    tenantId: source.tenantId,
    displayName: source.displayName?.trim() || source.tenantName,
    registeredName: source.registeredName,
    taxPin: source.taxPin,
    contactEmail: source.contactEmail,
    contactPhone: source.contactPhone,
    postalAddress: source.postalAddress,
    physicalAddress: source.physicalAddress,
    website: source.website,
  };
}

export function brandingFrom(source: BrandingSource): SnapshotBranding {
  return {
    displayName: source.displayName?.trim() || source.tenantName,
    primaryColor: source.primaryColor,
    secondaryColor: source.secondaryColor,
    accentColor: source.accentColor,
    primaryForeground: source.primaryForeground,
    logoUrl: source.logoUrl,
  };
}

/** Joins a contact address into the single printed line the template shows. */
function formatAddress(
  address: NonNullable<CustomerSource["addresses"]>[number],
): string {
  return [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postalCode,
    address.country,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ");
}

export function customerFrom(source: CustomerSource): SnapshotCustomer {
  const addresses = source.addresses ?? [];
  const chosen =
    addresses.find((address) => address.isDefault) ?? addresses[0] ?? null;

  return {
    contactId: source.id,
    name: contactDisplayName(source),
    email: source.email,
    phone: source.phone ?? source.mobile,
    taxPin: source.taxPin,
    address: chosen ? formatAddress(chosen) : null,
  };
}

export function lineSourceFrom(row: LineSource): SnapshotLineInput {
  return {
    position: 0, // set by the caller from the stored order
    itemId: row.itemId,
    itemCode: row.itemCode,
    description: row.description,
    unitOfMeasure: row.unitOfMeasure,
    quantity: decimalStringOrZero(row.quantity),
    unitPrice: decimalStringOrZero(row.unitPrice),
    discountType: row.discountType,
    discountPercent: decimalStringOrZero(row.discountPercent),
    discountAmount: decimalStringOrZero(row.discountAmount),
    taxRateId: row.taxRateId,
    taxName: row.taxName,
    taxRate: decimalStringOrZero(row.taxRate),
  };
}

export interface ComposeSnapshotInput {
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
  lines: Array<Omit<SnapshotLineInput, "position">>;
  branding: SnapshotBranding;
  generatedAt: Date;
}

/**
 * Builds the snapshot, numbering the lines in stored order. Totals are derived
 * by `buildDocumentSnapshot` from the copied lines, so the snapshot can never
 * disagree with the columns written in the same transaction.
 */
export function composeDocumentSnapshot(
  input: ComposeSnapshotInput,
): DocumentSnapshot {
  return buildDocumentSnapshot({
    ...input,
    lines: input.lines.map((line, index) => ({
      ...line,
      position: index + 1,
    })),
  });
}
