import { roundDecimalString } from "./money";
import { multiplyDecimalStrings, subtractDecimalStrings } from "./decimal";

/**
 * Catalogue → document-line snapshot.
 *
 * The constitution's rule for documents is that a line copies what it needs at
 * the moment it is written: the catalogue item's description, code, unit and
 * price are frozen into the line, and a later edit to the catalogue never
 * rewrites a document that already exists. `DocumentLine.itemId` (where present)
 * is provenance only — the printed line always comes from these copied columns.
 *
 * This module builds those copied columns as a pure function, so the same rule
 * can be exercised by a Server Action today and by a SQLite-backed offline client
 * later, without either one reaching for the live catalogue at render time.
 *
 * Amounts are decimal strings and the arithmetic is exact (see `./decimal`).
 */

/** The catalogue item facts copied onto a line. */
export interface CatalogueItemSource {
  itemId: string;
  name: string;
  description: string | null;
  sku: string | null;
  unitOfMeasure: string;
  /** Selling price, major units, decimal string. */
  unitPrice: string;
  currency: string;
  taxRateId: string | null;
  taxName: string | null;
  /** Tax fraction 0–1, decimal string (e.g. "0.16"). */
  taxRate: string;
}

/**
 * A customer-specific catalogue entry, when the customer has one. Every override
 * is optional; an absent field falls back to the catalogue item.
 */
export interface CustomerCatalogueOverride {
  customCode: string | null;
  customName: string | null;
  /** Customer-specific unit of measure; falls back to the catalogue unit. */
  customUnitOfMeasure?: string | null;
  /** Agreed price for this customer, decimal string. */
  agreedPrice: string;
  /** Discount percentage 0–100, decimal string (e.g. "10.00"). */
  discountPercent: string;
  /** When false the override is not applied. */
  isAvailable: boolean;
  /** ISO date the agreement starts (inclusive); absent/null means "open". */
  validFrom?: string | null;
  /** ISO date the agreement ends (inclusive); absent/null means "open". */
  validUntil?: string | null;
}

export interface DocumentLineSnapshot {
  /** Provenance only; never read back to price the line. */
  itemId: string;
  description: string;
  itemCode: string | null;
  unitOfMeasure: string;
  quantity: string;
  unitPrice: string;
  currency: string;
  discountType: "PERCENT" | null;
  discountPercent: string;
  discountAmount: string;
  /** quantity × unitPrice, rounded to 4 dp. */
  lineTotal: string;
  /** lineTotal × discountPercent / 100, rounded to 4 dp. */
  lineDiscount: string;
  /** lineTotal − lineDiscount. */
  lineNet: string;
  taxRateId: string | null;
  taxName: string | null;
  taxRate: string;
  /** Which price was used, recorded so the choice is auditable. */
  priceSource: "customer" | "catalogue";
}

/** The scale every monetary column in the schema stores. */
const MONEY_SCALE = 4;

function round4(value: string | null): string {
  return roundDecimalString(value ?? "0", MONEY_SCALE) ?? "0";
}

/**
 * Whether a customer agreement is in force on a given day.
 *
 * A window with no bounds never expires. A window *with* bounds but no date to
 * test against is treated as not in force: an unverifiable agreement is never
 * silently charged. Both bounds are inclusive.
 */
function isOverrideInForce(
  override: CustomerCatalogueOverride,
  asOf: string | null | undefined,
): boolean {
  const from = override.validFrom ?? null;
  const until = override.validUntil ?? null;
  if (!from && !until) return true;
  if (!asOf) return false;

  const at = Date.parse(asOf);
  if (Number.isNaN(at)) return false;
  if (from && at < Date.parse(from)) return false;
  if (until && at > Date.parse(until)) return false;
  return true;
}

/**
 * Builds the frozen line for a quantity of a catalogue item.
 *
 * A customer override is applied only when it exists, is available AND is in
 * force on `asOf`; an unavailable or out-of-window entry deliberately falls back
 * to the catalogue price so a suspended or expired agreement can never be
 * silently charged. The chosen source is reported back in `priceSource`.
 */
export function buildDocumentLineSnapshot(input: {
  item: CatalogueItemSource;
  override?: CustomerCatalogueOverride | null;
  quantity: string;
  /** The date the line is written, ISO string. Used to test the validity window. */
  asOf?: string | null;
}): DocumentLineSnapshot {
  const { item } = input;
  const override =
    input.override &&
    input.override.isAvailable &&
    isOverrideInForce(input.override, input.asOf)
      ? input.override
      : null;

  const quantity = round4(input.quantity);
  const unitPrice = round4(override?.agreedPrice ?? item.unitPrice);
  const discountPercent = override
    ? round4(override.discountPercent)
    : "0.0000";

  const lineTotal = round4(multiplyDecimalStrings(quantity, unitPrice));

  // discount = lineTotal × (discountPercent / 100). The division by 100 is a
  // decimal-point shift, done exactly by multiplying by "0.01".
  const discountFraction = round4(
    multiplyDecimalStrings(discountPercent, "0.01"),
  );
  const lineDiscount = round4(
    multiplyDecimalStrings(lineTotal, discountFraction),
  );

  const lineNet = round4(subtractDecimalStrings(lineTotal, lineDiscount));

  return {
    itemId: item.itemId,
    description: override?.customName || item.name,
    itemCode: override?.customCode ?? item.sku,
    unitOfMeasure: override?.customUnitOfMeasure || item.unitOfMeasure,
    quantity,
    unitPrice,
    currency: item.currency,
    discountType: override && discountPercent !== "0.0000" ? "PERCENT" : null,
    discountPercent,
    discountAmount: lineDiscount,
    lineTotal,
    lineDiscount,
    lineNet,
    taxRateId: item.taxRateId,
    taxName: item.taxName,
    taxRate: item.taxRate,
    priceSource: override ? "customer" : "catalogue",
  };
}
