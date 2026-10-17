import { roundDecimalString } from "./money";
import { calculateLine, type DocumentDiscountType } from "./calculations";

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
 * later, without either one reaching for the live catalogue at render time. The
 * web server's line resolver calls `resolveCatalogueLineFacts` with rows it read
 * inside the write transaction; the offline client will call
 * `buildDocumentLineSnapshot` with rows it synced down. Both paths therefore
 * agree because they are the same code, not two implementations kept in sync.
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
  discountType: DocumentDiscountType | null;
  /** The mechanism value: 0–100 when `discountType` is "PERCENT", else 0. */
  discountPercent: string;
  /** Money actually taken off, which is what the stored column holds. */
  discountAmount: string;
  /** quantity × unitPrice, rounded to 4 dp. */
  lineTotal: string;
  /** The discount actually applied, clamped to the line, rounded to 4 dp. */
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
 * The discount a document line carries in its own right.
 *
 * A customer agreement that names a discount percentage is the commercial term of
 * record, so while that agreement is in force the line's own discount is NOT
 * applied as well — taking two discounts off an agreed price is not a term the
 * customer agreed to, and adding one silently would be a pricing decision made by
 * a form field rather than by the business. With no agreed discount (or no
 * agreement at all) the document's own discount is used exactly as chosen.
 */
export interface DocumentLineDiscount {
  discountType: DocumentDiscountType | null;
  /** 0–100 when `discountType` is "PERCENT"; otherwise 0. */
  discountPercent: string;
  /** Major units when `discountType` is "AMOUNT"; otherwise 0. */
  discountAmount: string;
}

/** One line's commercial facts, copied and precedence-resolved, sans totals. */
export interface ResolvedCatalogueLine {
  /** Provenance only; never read back to price the line. */
  itemId: string;
  description: string;
  itemCode: string | null;
  unitOfMeasure: string;
  /** The price actually used — the agreed one when an agreement is in force. */
  unitPrice: string;
  currency: string;
  discountType: DocumentDiscountType | null;
  discountPercent: string;
  discountAmount: string;
  /**
   * The item's own tax classification, which is what the catalogue says the
   * customer should be charged. Null when the item carries no rate, in which case
   * the caller decides (a free-text line has no classification to copy).
   */
  taxRateId: string | null;
  taxName: string | null;
  taxRate: string;
  /** Which price was used, recorded so the choice is auditable. */
  priceSource: "customer" | "catalogue";
}

/** Applies the discount precedence rule: an agreed discount beats the line's own. */
function chooseDiscount(
  override: CustomerCatalogueOverride | null,
  documentDiscount: DocumentLineDiscount | null | undefined,
): DocumentLineDiscount {
  const agreed = override ? round4(override.discountPercent) : "0.0000";

  if (override && agreed !== "0.0000") {
    return {
      discountType: "PERCENT",
      discountPercent: agreed,
      discountAmount: "0.0000",
    };
  }

  const chosen = documentDiscount ?? {
    discountType: null,
    discountPercent: "0",
    discountAmount: "0",
  };

  if (chosen.discountType === "PERCENT") {
    return {
      discountType: "PERCENT",
      discountPercent: round4(chosen.discountPercent),
      discountAmount: "0.0000",
    };
  }
  if (chosen.discountType === "AMOUNT") {
    return {
      discountType: "AMOUNT",
      discountPercent: "0.0000",
      discountAmount: round4(chosen.discountAmount),
    };
  }
  return {
    discountType: null,
    discountPercent: "0.0000",
    discountAmount: "0.0000",
  };
}

/**
 * Decides what one catalogue line is worth, for one customer, on one date.
 *
 * This is the single precedence implementation in the product. A customer
 * override is applied only when it exists, is available AND is in force on
 * `asOf`; an unavailable or out-of-window entry deliberately falls back to the
 * catalogue price, so a suspended or expired agreement can never be silently
 * charged. Every override field is per-field: an agreement that renames the item
 * but sets no unit still sells in the catalogue's unit. The chosen source is
 * reported in `priceSource` rather than inferred from the numbers.
 */
export function resolveCatalogueLineFacts(input: {
  item: CatalogueItemSource;
  override?: CustomerCatalogueOverride | null;
  /** The discount on the document line, used only if no agreement dictates one. */
  documentDiscount?: DocumentLineDiscount | null;
  /** The date the line is written, ISO string. Used to test the validity window. */
  asOf?: string | null;
}): ResolvedCatalogueLine {
  const { item } = input;
  const override =
    input.override &&
    input.override.isAvailable &&
    isOverrideInForce(input.override, input.asOf)
      ? input.override
      : null;

  return {
    itemId: item.itemId,
    description: override?.customName?.trim() || item.name,
    itemCode: override?.customCode ?? item.sku,
    unitOfMeasure: override?.customUnitOfMeasure || item.unitOfMeasure,
    unitPrice: round4(override?.agreedPrice ?? item.unitPrice),
    currency: item.currency,
    ...chooseDiscount(override, input.documentDiscount),
    taxRateId: item.taxRateId,
    taxName: item.taxName,
    taxRate: item.taxRate,
    priceSource: override ? "customer" : "catalogue",
  };
}

/**
 * Builds the frozen line for a quantity of a catalogue item.
 *
 * The facts come from `resolveCatalogueLineFacts` and the totals from
 * `calculateLine`, so a line priced offline is arithmetically identical to the
 * same line priced by the server.
 */
export function buildDocumentLineSnapshot(input: {
  item: CatalogueItemSource;
  override?: CustomerCatalogueOverride | null;
  quantity: string;
  documentDiscount?: DocumentLineDiscount | null;
  asOf?: string | null;
}): DocumentLineSnapshot {
  const facts = resolveCatalogueLineFacts(input);
  const quantity = round4(input.quantity);

  const computed = calculateLine({
    quantity,
    unitPrice: facts.unitPrice,
    discountType: facts.discountType,
    discountPercent: facts.discountPercent,
    discountAmount: facts.discountAmount,
    taxRate: facts.taxRate,
    taxName: facts.taxName,
  });

  return {
    itemId: facts.itemId,
    description: facts.description,
    itemCode: facts.itemCode,
    unitOfMeasure: facts.unitOfMeasure,
    quantity,
    unitPrice: facts.unitPrice,
    currency: facts.currency,
    discountType: facts.discountType,
    discountPercent: facts.discountPercent,
    discountAmount: computed.lineDiscount,
    lineTotal: computed.lineTotal,
    lineDiscount: computed.lineDiscount,
    lineNet: computed.lineNet,
    taxRateId: facts.taxRateId,
    taxName: facts.taxName,
    taxRate: facts.taxRate,
    priceSource: facts.priceSource,
  };
}
