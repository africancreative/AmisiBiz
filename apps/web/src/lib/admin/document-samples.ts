import type { DocumentPeriodStyle, DocumentType } from "@prisma/client";

/**
 * Placeholder document numbers for the provider console's branding preview.
 *
 * The shape comes from the workspace's own `DocumentNumbering` series and follows
 * exactly the assembly rule `allocate_document_number()` uses in the database:
 * `prefix · period · zero-padded sequence`, joined by the configured separator,
 * with empty parts skipped. Only the sequence is invented here — it is always
 * `1`, because a preview must not consume or imply a real allocation. Nothing in
 * this module writes, reads or reserves anything; the next genuine number still
 * comes from the counter row at issuance time.
 */

export type NumberingSeriesLike = {
  type: DocumentType;
  prefix: string;
  padding: number;
  separator: string;
  periodStyle: DocumentPeriodStyle;
  fiscalStartMonth: number;
};

/**
 * The series a workspace gets before it has ever opened the numbering screen —
 * the same documented defaults the database inserts on first issuance
 * (INV / QUO / DN, 4 digits, `-`, calendar year).
 */
const DEFAULT_SERIES: Record<
  DocumentType,
  Omit<NumberingSeriesLike, "type">
> = {
  INVOICE: {
    prefix: "INV",
    padding: 4,
    separator: "-",
    periodStyle: "CALENDAR_YEAR",
    fiscalStartMonth: 1,
  },
  QUOTATION: {
    prefix: "QUO",
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

const DOCUMENT_TYPES: readonly DocumentType[] = [
  "QUOTATION",
  "INVOICE",
  "DELIVERY_NOTE",
];

function periodPart(
  style: DocumentPeriodStyle,
  fiscalStartMonth: number,
  date: Date,
): string {
  const year = date.getFullYear();

  if (style === "CALENDAR_YEAR") return String(year);

  if (style === "FINANCIAL_YEAR") {
    const month = date.getMonth() + 1;
    const start = month >= fiscalStartMonth ? year : year - 1;
    const end = String((start + 1) % 100).padStart(2, "0");
    return `${start}/${end}`;
  }

  return "";
}

function buildNumber(series: NumberingSeriesLike, date: Date): string {
  const sequence = "1".padStart(Math.min(Math.max(series.padding, 1), 10), "0");

  return [
    series.prefix,
    periodPart(series.periodStyle, series.fiscalStartMonth, date),
    sequence,
  ]
    .filter((part) => part.length > 0)
    .join(series.separator);
}

/**
 * One sample number per document type, preferring the stored series and falling
 * back to the documented default for any type the workspace has not configured.
 */
export function sampleDocumentNumbers(
  numbering: readonly NumberingSeriesLike[],
  date: Date = new Date(),
): Partial<Record<DocumentType, string>> {
  const stored = new Map(numbering.map((series) => [series.type, series]));

  const result: Partial<Record<DocumentType, string>> = {};

  for (const type of DOCUMENT_TYPES) {
    const series = stored.get(type);
    result[type] = buildNumber(
      series ? { ...series, type } : { ...DEFAULT_SERIES[type], type },
      date,
    );
  }

  return result;
}
