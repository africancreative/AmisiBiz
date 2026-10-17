import type { ScopedTx } from "@amisibiz/database";
import type { Prisma } from "@prisma/client";
import {
  calculateDocument,
  resolveCatalogueLineFacts,
  type CatalogueItemSource,
  type CustomerCatalogueOverride,
  type DocumentCalculation,
  type DocumentDiscountType,
  type SnapshotLineInput,
} from "@amisibiz/documents";
import { decimalString, decimalStringOrZero } from "./calculations";
import { DocumentServiceError } from "./errors";

/**
 * Validates and prices the lines a caller sent, against the tenant's own
 * catalogue, its customer agreements and its tax rates.
 *
 * Three integrity rules are enforced here, and they are why this is server code
 * and not a client calculation:
 *
 *  1. **Ownership.** Every `itemId` and `taxRateId` must resolve to a row in the
 *     SAME tenant. A forged id from another workspace is a validation error, not
 *     a foreign-key surprise — and the database trigger would refuse it anyway.
 *  2. **Tax comes from the rate, not the client.** The fraction and the label are
 *     copied from the tenant's `TaxRate`, so a browser cannot invoice at 0% VAT
 *     by sending a doctored rate. The line keeps `taxRateId` as provenance and
 *     the copied values as the frozen fact. For a line that names a catalogue
 *     item, the item's own classification is what applies: an item is taxable
 *     because the business said so in the catalogue, not because a form left a
 *     dropdown empty.
 *  3. **Price comes from the catalogue or the agreement, never from the request.**
 *     The constitution says a client is never trusted with prices. For a line
 *     that names an item, the unit price, description, code, unit and discount
 *     are read from the tenant's rows, and a customer-specific agreement takes
 *     precedence for exactly one customer and one item. The precedence rule is
 *     `resolveCatalogueLineFacts` — the same pure function the future offline
 *     client runs — so the two cannot drift.
 *
 * Whether rule 3 runs at all is the `source` option:
 *
 *  - `"catalogue"` (the default, used whenever a HUMAN is asking) re-prices every
 *    item line from the rows as they are now. A browser that sends a stale or a
 *    doctored price gets the tenant's price, and the result reports which source
 *    was used.
 *  - `"stored"` (used when the lines already came out of this tenant's own
 *    `DocumentLine` rows) keeps the figures already on the draft. Issuance,
 *    quotation→invoice conversion, delivery notes and replacements all run in
 *    this mode: the operator reviewed those numbers on the draft, and a catalogue
 *    or agreement edit made afterwards must not silently reprice a document on
 *    its way out. Ownership and tax are still re-checked, because a retired rate
 *    or a moved item is a fact worth refusing over.
 *
 * The totals then come from `calculateDocument`, the same engine the stored
 * columns and the snapshot both read, so the three can never disagree.
 */

export interface DocumentLinePayload {
  itemId: string | null;
  description: string;
  itemCode: string | null;
  unitOfMeasure: string;
  quantity: string;
  unitPrice: string;
  discountType: DocumentDiscountType | null;
  discountPercent: string;
  discountAmount: string;
  taxRateId: string | null;
}

export interface DiscountMechanism {
  discountType: DocumentDiscountType | null;
  discountPercent: string;
  discountAmount: string;
}

/**
 * Where a resolved line's price came from.
 *
 * `"manual"` is a free-text line (no catalogue item to copy from), `"customer"`
 * and `"catalogue"` are an agreement and a standard price, and `"stored"` says
 * "this line arrived on a row that was priced earlier" — the resolver will not
 * claim a provenance it no longer has.
 */
export type LinePriceSource = "customer" | "catalogue" | "manual" | "stored";

export interface ResolveLinesOptions {
  /**
   * The customer whose agreements may apply. The caller has already proved the id
   * belongs to `tenantId`; the override lookup is predicated on both, so a foreign
   * id can only ever match no agreements rather than someone else's.
   */
  contactId?: string | null;
  /**
   * The calendar date the agreement window is tested against — the document's own
   * issue date, so a back-dated quotation is priced under the agreement that was
   * in force on the date printed on it. An agreement with a window but no date to
   * test against is treated as not in force.
   */
  asOf?: string | null;
  /** The document currency, checked against each catalogue item's own currency. */
  currency?: string | null;
  /** `"catalogue"` (default) or `"stored"`; see the header note. */
  source?: "catalogue" | "stored";
}

export interface ResolvedLines {
  calculation: DocumentCalculation;
  /** Line inputs for the snapshot, in order, without a position yet. */
  snapshotLines: Array<Omit<SnapshotLineInput, "position">>;
  /** The stored discount mechanism per line, parallel to `calculation.lines`. */
  mechanisms: DiscountMechanism[];
  /** Where each line's price came from, parallel to `snapshotLines`. */
  priceSources: LinePriceSource[];
}

function isZero(value: string): boolean {
  // A cheap gate only. The authoritative arithmetic is decimal-string based; a
  // float comparison of a value the schema already validated as a plain decimal
  // cannot change a stored figure.
  return Number(value) === 0;
}

function normaliseDiscount(payload: DocumentLinePayload): DiscountMechanism {
  const type = payload.discountType;

  if (!type) {
    if (!isZero(payload.discountPercent) || !isZero(payload.discountAmount)) {
      throw new DocumentServiceError(
        "VALIDATION",
        "A line discount needs a type; send PERCENT or AMOUNT, or leave both values at zero.",
        "lines",
      );
    }
    return { discountType: null, discountPercent: "0", discountAmount: "0" };
  }

  if (type === "PERCENT") {
    if (!isZero(payload.discountAmount)) {
      throw new DocumentServiceError(
        "VALIDATION",
        "A percentage discount cannot also carry a fixed amount.",
        "lines",
      );
    }
    if (
      isZero(payload.discountPercent) ||
      Number(payload.discountPercent) > 100
    ) {
      throw new DocumentServiceError(
        "VALIDATION",
        "A percentage discount must be greater than 0 and no more than 100.",
        "lines",
      );
    }
    return {
      discountType: "PERCENT",
      discountPercent: payload.discountPercent,
      discountAmount: "0",
    };
  }

  if (!isZero(payload.discountPercent)) {
    throw new DocumentServiceError(
      "VALIDATION",
      "A fixed-amount discount cannot also carry a percentage.",
      "lines",
    );
  }
  if (isZero(payload.discountAmount)) {
    throw new DocumentServiceError(
      "VALIDATION",
      "A fixed-amount discount must be greater than 0.",
      "lines",
    );
  }
  return {
    discountType: "AMOUNT",
    discountPercent: "0",
    discountAmount: payload.discountAmount,
  };
}

/** Compact, PII-free provenance summary for an audit row: lines per source. */
export function summarisePriceSources(
  sources: LinePriceSource[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const source of sources) {
    summary[source] = (summary[source] ?? 0) + 1;
  }
  return summary;
}

/* ─────────────────────────── the rows it reads ─────────────────────────── */

const ITEM_SELECT = {
  id: true,
  name: true,
  sku: true,
  description: true,
  unitOfMeasure: true,
  unitPrice: true,
  currency: true,
  status: true,
  taxRateId: true,
  taxRate: { select: { id: true, name: true, rate: true } },
} satisfies Prisma.ItemSelect;

const OVERRIDE_SELECT = {
  itemId: true,
  customCode: true,
  customName: true,
  customUnitOfMeasure: true,
  agreedPrice: true,
  discountPercent: true,
  isAvailable: true,
  validFrom: true,
  validUntil: true,
} satisfies Prisma.ContactItemSelect;

type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_SELECT }>;
type OverrideRow = Prisma.ContactItemGetPayload<{
  select: typeof OVERRIDE_SELECT;
}>;

/**
 * The catalogue row as the shared precedence function wants it.
 *
 * `taxRateId` comes from the resolved relation, not the bare column: a rate id
 * whose row this session cannot read would price the line at an unverified 0%,
 * and an unverified tax is exactly what this module exists to refuse.
 */
function catalogueSource(row: ItemRow): CatalogueItemSource {
  return {
    itemId: row.id,
    name: row.name,
    description: row.description,
    sku: row.sku,
    unitOfMeasure: row.unitOfMeasure,
    unitPrice: decimalString(row.unitPrice),
    currency: row.currency,
    taxRateId: row.taxRate?.id ?? null,
    taxName: row.taxRate?.name ?? null,
    taxRate: decimalStringOrZero(row.taxRate?.rate),
  };
}

/** The agreement row as the shared precedence function wants it. */
function agreementSource(row: OverrideRow): CustomerCatalogueOverride {
  return {
    customCode: row.customCode,
    customName: row.customName,
    customUnitOfMeasure: row.customUnitOfMeasure,
    agreedPrice: decimalString(row.agreedPrice),
    discountPercent: decimalStringOrZero(row.discountPercent),
    isAvailable: row.isAvailable,
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
  };
}

/* ───────────────────────────── the resolver ─────────────────────────────── */

export async function resolveLines(
  tx: ScopedTx,
  tenantId: string,
  payloads: DocumentLinePayload[],
  options: ResolveLinesOptions = {},
): Promise<ResolvedLines> {
  const source = options.source ?? "catalogue";

  if (payloads.length === 0) {
    throw new DocumentServiceError(
      "VALIDATION",
      "A document needs at least one line.",
      "lines",
    );
  }
  if (payloads.length > 1000) {
    throw new DocumentServiceError(
      "VALIDATION",
      "A document cannot have more than 1000 lines.",
      "lines",
    );
  }

  const itemIds = [
    ...new Set(
      payloads
        .map((payload) => payload.itemId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const taxRateIds = [
    ...new Set(
      payloads
        .map((payload) => payload.taxRateId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const items =
    itemIds.length > 0
      ? await tx.item.findMany({
          where: { tenantId, id: { in: itemIds } },
          select: ITEM_SELECT,
        })
      : [];

  // Only a request from a human can be re-priced, and only a document that names
  // a customer has agreements to look up. The tenant id is part of the predicate
  // as well as the contact id, so a contact from another workspace simply matches
  // nothing — the line falls back to the standard price instead of leaking one.
  const overrides =
    source === "catalogue" && options.contactId && itemIds.length > 0
      ? await tx.contactItem.findMany({
          where: {
            tenantId,
            contactId: options.contactId,
            itemId: { in: itemIds },
          },
          select: OVERRIDE_SELECT,
        })
      : [];

  const taxRates =
    taxRateIds.length > 0
      ? await tx.taxRate.findMany({
          where: { tenantId, id: { in: taxRateIds } },
          select: { id: true, name: true, rate: true },
        })
      : [];

  const itemsById = new Map(items.map((item) => [item.id, item]));
  // `(tenantId, contactId, itemId)` is unique, so one agreement per item at most.
  const overridesByItem = new Map(
    overrides.map((override) => [override.itemId, override]),
  );
  const taxRatesById = new Map(
    taxRates.map((rate) => [
      rate.id,
      { name: rate.name, rate: decimalString(rate.rate) },
    ]),
  );

  const snapshotLines: Array<Omit<SnapshotLineInput, "position">> = [];
  const mechanisms: DiscountMechanism[] = [];
  const priceSources: LinePriceSource[] = [];

  for (const payload of payloads) {
    const item = payload.itemId ? itemsById.get(payload.itemId) : undefined;
    if (payload.itemId && !item) {
      throw new DocumentServiceError(
        "VALIDATION",
        "A line references an item that is not part of this business.",
        "lines",
      );
    }

    let taxName: string | null = null;
    let taxRate = "0";
    if (payload.taxRateId) {
      const rate = taxRatesById.get(payload.taxRateId);
      if (!rate) {
        throw new DocumentServiceError(
          "VALIDATION",
          "A line references a tax rate that is not part of this business.",
          "lines",
        );
      }
      taxName = rate.name;
      taxRate = rate.rate;
    }

    // Always validated, even when an agreement later replaces it: a malformed
    // discount is a caller error worth reporting rather than swallowing.
    const chosen = normaliseDiscount(payload);

    // A free-text line is exactly what the caller wrote — that is the whole point
    // of allowing one, and it is how a business sells something not in the
    // catalogue. Nothing here invents a description or a price for it.
    if (!item) {
      mechanisms.push(chosen);
      priceSources.push("manual");
      snapshotLines.push({
        itemId: null,
        itemCode: payload.itemCode,
        description: payload.description,
        unitOfMeasure: payload.unitOfMeasure,
        quantity: payload.quantity,
        unitPrice: payload.unitPrice,
        discountType: chosen.discountType,
        discountPercent: chosen.discountPercent,
        discountAmount: chosen.discountAmount,
        taxRateId: payload.taxRateId,
        taxName,
        taxRate,
      });
      continue;
    }

    // A row that is already stored keeps its figures (see the header note). An
    // archived item is still allowed here: history must stay issuable and
    // printable, which is why "archive" never means "erase".
    if (source === "stored") {
      mechanisms.push(chosen);
      priceSources.push("stored");
      snapshotLines.push({
        itemId: item.id,
        itemCode: payload.itemCode,
        description: payload.description,
        unitOfMeasure: payload.unitOfMeasure,
        quantity: payload.quantity,
        unitPrice: payload.unitPrice,
        discountType: chosen.discountType,
        discountPercent: chosen.discountPercent,
        discountAmount: chosen.discountAmount,
        taxRateId: payload.taxRateId,
        taxName,
        taxRate,
      });
      continue;
    }

    if (item.status !== "ACTIVE") {
      throw new DocumentServiceError(
        "VALIDATION",
        `"${item.name}" is ${item.status.toLowerCase()} in the catalogue, so it cannot be sold on a new document. Use a free-text line for an item you no longer stock.`,
        "lines",
      );
    }

    if (item.taxRateId && !item.taxRate) {
      throw new DocumentServiceError(
        "VALIDATION",
        `"${item.name}" is classified for a tax rate that could not be read, so its tax cannot be verified. Refresh the page and try again.`,
        "lines",
      );
    }

    const facts = resolveCatalogueLineFacts({
      item: catalogueSource(item),
      override: (() => {
        const agreement = overridesByItem.get(item.id);
        return agreement ? agreementSource(agreement) : null;
      })(),
      documentDiscount: chosen,
      asOf: options.asOf ?? null,
    });

    if (options.currency && facts.currency !== options.currency) {
      throw new DocumentServiceError(
        "VALIDATION",
        `"${item.name}" is priced in ${facts.currency}, but this document is in ${options.currency}. A price is copied from the catalogue, not converted, so the two cannot be mixed — set the document currency or use an item priced in it.`,
        "lines",
      );
    }

    // The item's classification wins whenever the catalogue carries one; the
    // line's own `taxRateId` (validated above) applies only where the catalogue
    // is silent.
    const taxed =
      facts.taxRateId !== null
        ? {
            taxRateId: facts.taxRateId,
            taxName: facts.taxName,
            taxRate: facts.taxRate,
          }
        : { taxRateId: payload.taxRateId, taxName, taxRate };

    const mechanism: DiscountMechanism = {
      discountType: facts.discountType,
      discountPercent: facts.discountPercent,
      discountAmount: facts.discountAmount,
    };

    mechanisms.push(mechanism);
    priceSources.push(facts.priceSource);
    snapshotLines.push({
      itemId: item.id,
      itemCode: facts.itemCode,
      description: facts.description,
      unitOfMeasure: facts.unitOfMeasure,
      quantity: payload.quantity,
      unitPrice: facts.unitPrice,
      discountType: mechanism.discountType,
      discountPercent: mechanism.discountPercent,
      discountAmount: mechanism.discountAmount,
      ...taxed,
    });
  }

  const calculation = calculateDocument({ lines: snapshotLines });

  return { calculation, snapshotLines, mechanisms, priceSources };
}
