import type { ScopedTx } from "@amisibiz/database";
import {
  calculateDocument,
  type DocumentCalculation,
  type DocumentDiscountType,
  type SnapshotLineInput,
} from "@amisibiz/documents";
import { decimalString } from "./calculations";
import { DocumentServiceError } from "./errors";

/**
 * Validates and prices the lines a caller sent, against the tenant's own
 * catalogue and tax rates.
 *
 * Two integrity rules are enforced here, and they are why this is server code
 * and not a client calculation:
 *
 *  1. **Ownership.** Every `itemId` and `taxRateId` must resolve to a row in the
 *     SAME tenant. A forged id from another workspace is a validation error, not
 *     a foreign-key surprise — and the database trigger would refuse it anyway.
 *  2. **Tax comes from the rate, not the client.** The fraction and the label are
 *     copied from the tenant's `TaxRate`, so a browser cannot invoice at 0% VAT
 *     by sending a doctored rate. The line keeps `taxRateId` as provenance and
 *     the copied values as the frozen fact.
 *
 * A line's description, unit, quantity, price and discount are what the caller
 * sent (the form copies them from the catalogue when an item is chosen); the
 * service copies the tax facts and validates the discount mechanism. The totals
 * then come from `calculateDocument`, the same engine the stored columns and the
 * snapshot both read, so the three can never disagree.
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

export interface ResolvedLines {
  calculation: DocumentCalculation;
  /** Line inputs for the snapshot, in order, without a position yet. */
  snapshotLines: Array<Omit<SnapshotLineInput, "position">>;
  /** The stored discount mechanism per line, parallel to `calculation.lines`. */
  mechanisms: DiscountMechanism[];
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

export async function resolveLines(
  tx: ScopedTx,
  tenantId: string,
  payloads: DocumentLinePayload[],
): Promise<ResolvedLines> {
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
          select: { id: true },
        })
      : [];
  const taxRates =
    taxRateIds.length > 0
      ? await tx.taxRate.findMany({
          where: { tenantId, id: { in: taxRateIds } },
          select: { id: true, name: true, rate: true },
        })
      : [];

  const ownedItems = new Set(items.map((item) => item.id));
  const taxRatesById = new Map(
    taxRates.map((rate) => [
      rate.id,
      { name: rate.name, rate: decimalString(rate.rate) },
    ]),
  );

  const snapshotLines: Array<Omit<SnapshotLineInput, "position">> = [];
  const mechanisms: DiscountMechanism[] = [];

  for (const payload of payloads) {
    if (payload.itemId && !ownedItems.has(payload.itemId)) {
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

    const mechanism = normaliseDiscount(payload);
    mechanisms.push(mechanism);

    snapshotLines.push({
      itemId: payload.itemId,
      itemCode: payload.itemCode,
      description: payload.description,
      unitOfMeasure: payload.unitOfMeasure,
      quantity: payload.quantity,
      unitPrice: payload.unitPrice,
      discountType: mechanism.discountType,
      discountPercent: mechanism.discountPercent,
      discountAmount: mechanism.discountAmount,
      taxRateId: payload.taxRateId,
      taxName,
      taxRate,
    });
  }

  const calculation = calculateDocument({ lines: snapshotLines });

  return { calculation, snapshotLines, mechanisms };
}
