import { roundDecimalString } from "./money";
import {
  addDecimalStrings,
  multiplyDecimalStrings,
  subtractDecimalStrings,
} from "./decimal";

/**
 * The document calculation engine.
 *
 * Every money and quantity value that reaches this module is a decimal STRING,
 * and every value it returns is one: the arithmetic never touches a JS `number`.
 * That is not stylistic — an invoice total silently shifted in the last binary
 * place is a figure a customer can dispute, and the offline client (SQLite, no
 * `Prisma.Decimal`) has to run the identical rules.
 *
 * Rounding policy `half-up-per-line-v1` (the name recorded on every document):
 * each line is rounded to four decimal places at the points below, and the
 * document totals are then the exact sums of those already-rounded components.
 * Because of that ordering the database invariants hold as exact equalities and
 * can be — and are — enforced by CHECK constraints:
 *
 *     lineNet     = lineTotal  - lineDiscount
 *     taxableBase = subtotal   - totalDiscount
 *     total       = taxableBase + taxTotal
 *
 * The whole point of naming and freezing the policy is that changing it later
 * cannot retroactively rewrite an issued document.
 */

/** The scale every monetary column in the schema stores. */
export const MONEY_SCALE = 4;

/** The name written to `Document.roundingPolicy` and into the snapshot. */
export const DOCUMENT_ROUNDING_POLICY = "half-up-per-line-v1";

export type DocumentDiscountType = "PERCENT" | "AMOUNT";

/** The line as it arrives from the browser or the catalogue: no totals yet. */
export interface DocumentLineInput {
  quantity: string;
  unitPrice: string;
  /** Exactly one mechanism, or none. */
  discountType?: DocumentDiscountType | null;
  /** 0–100, used when `discountType` is "PERCENT". */
  discountPercent?: string | null;
  /** Major units, used when `discountType` is "AMOUNT". */
  discountAmount?: string | null;
  /** Tax fraction 0–1 (e.g. "0.16"). */
  taxRate?: string | null;
  /** Copied onto the document's tax breakdown, e.g. "VAT 16%". */
  taxName?: string | null;
}

/** The four stored totals of one line. */
export interface ComputedLine {
  lineTotal: string;
  lineDiscount: string;
  lineNet: string;
  lineTax: string;
}

/** One row of `Document.taxBreakdown`. */
export interface TaxBreakdownEntry {
  name: string;
  /** Tax fraction, e.g. "0.1600". */
  rate: string;
  /** Sum of the net amounts taxed at this rate. */
  base: string;
  /** Sum of the tax charged at this rate. */
  amount: string;
}

export interface DocumentCalculation {
  lines: ComputedLine[];
  subtotal: string;
  totalDiscount: string;
  taxableBase: string;
  taxTotal: string;
  total: string;
  taxBreakdown: TaxBreakdownEntry[];
}

/**
 * Thrown when a value that must be a plain decimal is not one. This is never a
 * user-facing message: the validation layer rejects malformed input long before
 * the engine sees it. It exists so a programming error fails loudly instead of
 * being read as a zero — which is exactly how a malformed field would silently
 * become a free line.
 */
export class DocumentCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentCalculationError";
  }
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

function must(value: string, field: string): string {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new DocumentCalculationError(`"${field}" is not a decimal: ${value}`);
  }
  return trimmed;
}

/** Rounds to four places, half-up, and fails loudly on a non-decimal. */
function round4(value: string, field: string): string {
  const rounded = roundDecimalString(must(value, field), MONEY_SCALE);
  if (rounded === null) {
    throw new DocumentCalculationError(`Could not round "${field}": ${value}`);
  }
  return rounded;
}

function add(a: string, b: string, field: string): string {
  const sum = addDecimalStrings(a, b);
  if (sum === null) {
    throw new DocumentCalculationError(`Could not add "${field}": ${a} + ${b}`);
  }
  return sum;
}

function subtract(a: string, b: string, field: string): string {
  const difference = subtractDecimalStrings(a, b);
  if (difference === null) {
    throw new DocumentCalculationError(
      `Could not subtract "${field}": ${a} - ${b}`,
    );
  }
  return difference;
}

function multiply(a: string, b: string, field: string): string {
  const product = multiplyDecimalStrings(a, b);
  if (product === null) {
    throw new DocumentCalculationError(
      `Could not multiply "${field}": ${a} * ${b}`,
    );
  }
  return product;
}

/** True when `value` is negative (a leading "-" with a non-zero magnitude). */
function isNegative(value: string): boolean {
  return value.trim().startsWith("-") && /[1-9]/.test(value);
}

/** Returns the smaller of two non-negative decimal strings. */
function minDecimal(a: string, b: string): string {
  const sum = subtractDecimalStrings(a, b); // a - b
  if (sum === null) return a;
  return isNegative(sum) ? a : b;
}

/**
 * Computes the four stored totals of one line.
 *
 * The discount is clamped to the line, never rejected, because the engine's job
 * is to produce a row the database will accept: an "AMOUNT" discount larger than
 * the line is a validation error the service reports as a field error, but if
 * one ever slipped through, the alternative — writing `lineDiscount > lineTotal`
 * — would be refused by a CHECK and surface as an opaque 500.
 */
export function calculateLine(input: DocumentLineInput): ComputedLine {
  const quantity = round4(input.quantity, "quantity");
  const unitPrice = round4(input.unitPrice, "unitPrice");

  const lineTotal = round4(
    multiply(quantity, unitPrice, "lineTotal"),
    "lineTotal",
  );

  const discountType = input.discountType ?? null;
  let lineDiscount = "0";

  if (discountType === "PERCENT") {
    const percent = round4(input.discountPercent ?? "0", "discountPercent");
    // Dividing by 100 is a two-place decimal-point shift, done exactly.
    const fraction = multiply(percent, "0.01", "discountPercent");
    lineDiscount = round4(
      multiply(lineTotal, fraction, "lineDiscount"),
      "lineDiscount",
    );
  } else if (discountType === "AMOUNT") {
    const amount = round4(input.discountAmount ?? "0", "discountAmount");
    lineDiscount = minDecimal(amount, lineTotal);
  }

  if (isNegative(lineDiscount)) lineDiscount = "0";
  lineDiscount = minDecimal(lineDiscount, lineTotal);

  const lineNet = round4(
    subtract(lineTotal, lineDiscount, "lineNet"),
    "lineNet",
  );

  const taxRate = round4(input.taxRate ?? "0", "taxRate");
  const lineTax = isNegative(taxRate)
    ? "0"
    : round4(multiply(lineNet, taxRate, "lineTax"), "lineTax");

  return { lineTotal, lineDiscount, lineNet, lineTax };
}

/**
 * Computes every line and the document totals.
 *
 * The per-rate tax breakdown is grouped by `(taxName, rate)` so two lines that
 * carry the same VAT rate are reported as one row, as a printed Ugandan/Kenyan
 * tax summary expects.
 */
export function calculateDocument(input: {
  lines: DocumentLineInput[];
}): DocumentCalculation {
  const lines: ComputedLine[] = [];
  let subtotal = "0";
  let totalDiscount = "0";
  let taxTotal = "0";

  const buckets = new Map<
    string,
    { name: string; rate: string; base: string; amount: string }
  >();

  for (const line of input.lines) {
    const computed = calculateLine(line);
    lines.push(computed);

    subtotal = round4(
      add(subtotal, computed.lineTotal, "subtotal"),
      "subtotal",
    );
    totalDiscount = round4(
      add(totalDiscount, computed.lineDiscount, "totalDiscount"),
      "totalDiscount",
    );
    taxTotal = round4(add(taxTotal, computed.lineTax, "taxTotal"), "taxTotal");

    const rate = round4(line.taxRate ?? "0", "taxRate");
    const name = (line.taxName ?? "").trim() || "Tax";
    const key = `${name}\u0000${rate}`;
    const bucket = buckets.get(key) ?? { name, rate, base: "0", amount: "0" };
    bucket.base = round4(
      add(bucket.base, computed.lineNet, "taxBase"),
      "taxBase",
    );
    bucket.amount = round4(
      add(bucket.amount, computed.lineTax, "taxAmount"),
      "taxAmount",
    );
    buckets.set(key, bucket);
  }

  const taxableBase = round4(
    subtract(subtotal, totalDiscount, "taxableBase"),
    "taxableBase",
  );
  const total = round4(add(taxableBase, taxTotal, "total"), "total");

  return {
    lines,
    subtotal,
    totalDiscount,
    taxableBase,
    taxTotal,
    total,
    taxBreakdown: [...buckets.values()],
  };
}

/**
 * Sums recorded, already-rounded payment amounts. Used for an invoice's paid
 * total and balance; kept here so the invoice read path uses the same exact
 * arithmetic as issuance rather than `reduce((a, b) => a + b)`.
 */
export function sumDecimalStrings(values: readonly string[]): string {
  let total = "0";
  for (const value of values) {
    total = round4(add(total, value, "sum"), "sum");
  }
  return total;
}

/** The outstanding balance of an invoice: total − paid, floored at zero. */
export function outstandingBalance(total: string, paid: string): string {
  const balance = subtract(total, paid, "balance");
  return isNegative(balance) ? "0.0000" : round4(balance, "balance");
}
