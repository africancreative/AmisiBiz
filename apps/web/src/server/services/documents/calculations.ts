import type { Prisma } from "@prisma/client";
import {
  DOCUMENT_ROUNDING_POLICY,
  MONEY_SCALE,
  calculateDocument,
  calculateLine,
  outstandingBalance,
  sumDecimalStrings,
  type ComputedLine,
  type DocumentCalculation,
  type DocumentDiscountType,
  type DocumentLineInput,
  type TaxBreakdownEntry,
} from "@amisibiz/documents";

/**
 * Server-side view of the document calculation engine.
 *
 * The rules themselves live in `@amisibiz/documents` — the SAME module the
 * offline client will run — because two implementations of "what an invoice
 * totals to" is two answers to a question a customer will ask. This file only
 * adds the pieces that need the server: adapting a `Prisma.Decimal` (which is
 * what a column comes back as) to the exact decimal STRING the engine operates
 * on, and re-exporting the engine under the path the schema comments name.
 *
 * The one rule to keep: a Decimal becomes a string via `toFixed(MONEY_SCALE)`,
 * never via `Number(...)`. Money never becomes a JS number on the way in or out.
 */

export {
  DOCUMENT_ROUNDING_POLICY,
  MONEY_SCALE,
  calculateDocument,
  calculateLine,
  outstandingBalance,
  sumDecimalStrings,
};

export type {
  ComputedLine,
  DocumentCalculation,
  DocumentDiscountType,
  DocumentLineInput,
  TaxBreakdownEntry,
};

/** A `Prisma.Decimal` (or a string/number literal) as an exact 4-dp string. */
export function decimalString(value: Prisma.Decimal | string | number): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  return value.toFixed(MONEY_SCALE);
}

/** A nullable decimal column as a string, defaulting to "0". */
export function decimalStringOrZero(
  value: Prisma.Decimal | string | number | null | undefined,
): string {
  return value === null || value === undefined ? "0" : decimalString(value);
}
