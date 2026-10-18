import type { DocumentType } from "./series";

/**
 * Document number composition — the pure half of the numbering system.
 *
 * The AUTHORITATIVE allocation happens in the database
 * (`allocate_document_number()`, which locks the counter row), because only the
 * database can serialise two simultaneous issuances. This module exists for the
 * two things that must agree with that function exactly:
 *
 *   1. the numbering-settings screen, which previews the next number
 *      (`peek_document_number()` mirrors it in SQL); and
 *   2. the test suite, which asserts the application and the database compose
 *      the same string — a preview that lied about the next number would be
 *      worse than no preview.
 *
 * The rule it reproduces, verbatim from the migration, is
 * `array_to_string(ARRAY[prefix, period, lpad(value, padding, '0')], separator)`
 * with empty parts dropped.
 */

export type DocumentPeriodStyle = "NONE" | "CALENDAR_YEAR" | "FINANCIAL_YEAR";

export const DOCUMENT_PERIOD_STYLES: readonly DocumentPeriodStyle[] = [
  "NONE",
  "CALENDAR_YEAR",
  "FINANCIAL_YEAR",
];

export interface DocumentNumberingConfig {
  prefix: string;
  padding: number;
  separator: string;
  periodStyle: DocumentPeriodStyle;
  /** Only read for FINANCIAL_YEAR: the month the books start in (1–12). */
  fiscalStartMonth: number;
}

/** The defaults the database applies on first use, per type. */
export const DEFAULT_DOCUMENT_NUMBERING: Readonly<
  Record<DocumentType, DocumentNumberingConfig>
> = {
  QUOTATION: {
    prefix: "QUO",
    padding: 4,
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: 1,
  },
  INVOICE: {
    prefix: "INV",
    padding: 4,
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: 1,
  },
  DELIVERY_NOTE: {
    prefix: "DN",
    padding: 4,
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: 1,
  },
  ORDER: {
    prefix: "ORD",
    padding: 4,
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: 1,
  },
};

const SAFE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$/;

export class DocumentNumberingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentNumberingError";
  }
}

/**
 * The period a number belongs to. It is derived from the document's own issue
 * date (a calendar date, not "now"), so a back-dated invoice lands in the series
 * its date names. The month is taken in UTC to match the SQL `date` argument,
 * which carries no time zone.
 */
export function resolveDocumentNumberPeriod(
  style: DocumentPeriodStyle,
  fiscalStartMonth: number,
  date: Date,
): string {
  if (Number.isNaN(date.getTime())) {
    throw new DocumentNumberingError(
      "A valid date is required to resolve a numbering period.",
    );
  }
  if (style === "NONE") return "";

  const year = date.getUTCFullYear();
  if (style === "CALENDAR_YEAR") return String(year);

  const month = date.getUTCMonth() + 1;
  const start = Math.min(Math.max(Math.trunc(fiscalStartMonth) || 1, 1), 12);
  const fiscalYear = month < start ? year - 1 : year;
  const next = String((fiscalYear + 1) % 100).padStart(2, "0");
  return `${fiscalYear}/${next}`;
}

/** Pads a positive integer with leading zeros to `width` digits. */
function pad(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, "0");
}

/**
 * Composes a number from its parts. Empty prefix/period parts are dropped so a
 * `NONE` period yields `ACME-0001` and an empty prefix never leaves a dangling
 * separator.
 */
export function composeDocumentNumber(input: {
  prefix: string;
  padding: number;
  separator: string;
  period: string;
  value: number;
}): string {
  const separator = input.separator || "-";
  const parts = [
    input.prefix.trim(),
    input.period.trim(),
    pad(input.value, input.padding),
  ].filter((part) => part.length > 0);

  const number = parts.join(separator);
  if (!SAFE_NUMBER.test(number)) {
    throw new DocumentNumberingError(
      `Composed document number is not a safe identifier: ${number}`,
    );
  }
  return number;
}

/** The number a series will produce next, without consuming it. */
export function previewDocumentNumber(input: {
  config: DocumentNumberingConfig;
  nextValue: number;
  date: Date;
}): string {
  return composeDocumentNumber({
    prefix: input.config.prefix,
    padding: input.config.padding,
    separator: input.config.separator,
    period: resolveDocumentNumberPeriod(
      input.config.periodStyle,
      input.config.fiscalStartMonth,
      input.date,
    ),
    value: input.nextValue,
  });
}
