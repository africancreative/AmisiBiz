import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AGENT 4 §E — customer-specific catalogue pricing, enforced by the server.
 *
 * The rule under test is the directive's own sentence: *a valid customer-specific
 * override must take precedence over the standard value only for the intended
 * customer and item*. Two properties make that a security requirement rather than
 * a convenience feature:
 *
 *  - The constitution forbids trusting a client-supplied price. So for a line that
 *    names a catalogue item the server reads the item, and the number the browser
 *    sent is discarded — a request cannot set a price at all.
 *  - An agreement is a term between ONE customer and ONE item. So the agreement
 *    lookup is predicated on the tenant and the customer as well as the item, and
 *    a suspended, expired or unverifiable agreement never silently charges the
 *    agreed price.
 *
 * Issuance deliberately does NOT re-price (`source: "stored"`): the figures the
 * operator reviewed on the draft are the ones frozen into the snapshot, so a later
 * catalogue edit cannot rewrite a document on its way out.
 *
 * The pure half — the same precedence function a future offline client will run —
 * is asserted against the server half at the end, because two implementations of
 * "which price applies" is two answers to a question a customer will ask.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));

import type { ScopedTx } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import {
  buildDocumentLineSnapshot,
  type CatalogueItemSource,
} from "@amisibiz/documents";
import {
  resolveLines,
  summarisePriceSources,
  type DocumentLinePayload,
} from "@/server/services/documents/lines";
import { DocumentServiceError } from "@/server/services/documents/errors";
import { createDraft } from "@/server/services/documents/service";
import { prismaMock, auditsFor } from "./prisma-mock";
import { AUDIT_ACTIONS } from "@/lib/audit";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555550001";
const ACME = "77777777-7777-4777-8777-777777770001";
const GLOBEX = "88888888-8888-4888-8888-888888880002";
const VAT = "66666666-6666-4666-8666-666666660001";
const ZERO_RATE = "66666666-6666-4666-8666-666666660002";
const DOC_ID = "33333333-3333-4333-8333-333333333333";

/* ───────────────────────────── the fixtures ─────────────────────────────── */

/** What `tx.item.findMany` returns for the select `lines.ts` asks for. */
function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    id: ITEM,
    name: "Cargo service",
    description: "Per shipment, door to door",
    sku: "SRV-1",
    unitOfMeasure: "each",
    unitPrice: "1000.0000",
    currency: "KES",
    status: "ACTIVE",
    taxRateId: VAT,
    taxRate: { id: VAT, name: "VAT 16%", rate: "0.1600" },
    ...overrides,
  };
}

/** What `tx.contactItem.findMany` returns for one customer's agreement. */
function agreementRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    contactId: ACME,
    itemId: ITEM,
    customCode: "ACME-SRV",
    customName: "Cargo service (Acme rate)",
    customUnitOfMeasure: null,
    agreedPrice: "900.0000",
    discountPercent: "0.0000",
    isAvailable: true,
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
}

function rateRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    id: VAT,
    name: "VAT 16%",
    rate: "0.1600",
    ...overrides,
  };
}

/**
 * A stand-in for the transaction client that answers the SAME predicates the
 * database would: rows come back only when they belong to the tenant named in
 * the `where`, and agreements only for the contact named in it. A fake that
 * ignored the predicates would test nothing about isolation, so it filters.
 */
function fakeTx(input: {
  items?: Array<Record<string, unknown>>;
  agreements?: Array<Record<string, unknown>>;
  rates?: Array<Record<string, unknown>>;
}) {
  const items = input.items ?? [];
  const agreements = input.agreements ?? [];
  const rates = input.rates ?? [];
  const queries: Array<Record<string, unknown>> = [];

  /** The only parts of a `where` clause this fake is allowed to depend on. */
  type Filter = {
    tenantId?: unknown;
    contactId?: unknown;
    id?: { in?: unknown[] };
    itemId?: { in?: unknown[] };
  };

  const belongs = (row: Record<string, unknown>, where: Filter) => {
    const ids = where.id?.in;
    return (
      row.tenantId === where.tenantId &&
      Array.isArray(ids) &&
      ids.includes(row.id)
    );
  };

  const matches = (row: Record<string, unknown>, where: Filter) => {
    const ids = where.itemId?.in;
    return (
      row.tenantId === where.tenantId &&
      row.contactId === where.contactId &&
      Array.isArray(ids) &&
      ids.includes(row.itemId)
    );
  };

  const tx = {
    item: {
      findMany: async (args: { where: Filter }) => {
        queries.push({ model: "item", where: args.where });
        return items.filter((row) => belongs(row, args.where));
      },
    },
    contactItem: {
      findMany: async (args: { where: Filter }) => {
        queries.push({ model: "contactItem", where: args.where });
        return agreements.filter((row) => matches(row, args.where));
      },
    },
    taxRate: {
      findMany: async (args: { where: Filter }) => {
        queries.push({ model: "taxRate", where: args.where });
        return rates.filter((row) => belongs(row, args.where));
      },
    },
  } as unknown as ScopedTx;

  return { tx, queries };
}

function payload(overrides: Partial<DocumentLinePayload> = {}) {
  return {
    itemId: ITEM,
    // Deliberately wrong: the server must never read these back as the price.
    description: "whatever the browser typed",
    itemCode: "FORGED",
    unitOfMeasure: "kg",
    quantity: "2",
    unitPrice: "0.0100",
    discountType: null,
    discountPercent: "0",
    discountAmount: "0",
    taxRateId: null,
    ...overrides,
  } satisfies DocumentLinePayload;
}

async function resolve(
  input: Parameters<typeof fakeTx>[0],
  payloads: DocumentLinePayload[],
  options?: Parameters<typeof resolveLines>[3],
) {
  const { tx, queries } = fakeTx(input);
  const resolved = await resolveLines(tx, TENANT, payloads, options);
  return { resolved, queries, line: resolved.snapshotLines[0] };
}

function context(): TenantAuthzContext {
  return {
    userId: USER_ID,
    tenantId: TENANT,
    role: "TENANT_OWNER",
    tenantStatus: "ACTIVE",
    via: "membership",
    readonly: false,
    supportGrantId: null,
  } as unknown as TenantAuthzContext;
}

/* ───────────────────── a request never sets a price ─────────────────────── */

describe("catalogue lines are priced by the server, not the caller", () => {
  it("copies the item's description, code, unit and price over the caller's", async () => {
    const { resolved, line } = await resolve({ items: [itemRow()] }, [
      payload(),
    ]);

    expect(line?.description).toBe("Cargo service");
    expect(line?.itemCode).toBe("SRV-1");
    expect(line?.unitOfMeasure).toBe("each");
    expect(line?.unitPrice).toBe("1000.0000");
    expect(resolved.priceSources).toEqual(["catalogue"]);
    expect(resolved.calculation.lines[0]?.lineTotal).toBe("2000.0000");
  });

  it("refuses an item that is not part of this business", async () => {
    await expect(
      resolve({ items: [itemRow({ tenantId: OTHER_TENANT })] }, [payload()]),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      resolve({ items: [] }, [payload()], { currency: "KES" }),
    ).rejects.toBeInstanceOf(DocumentServiceError);
  });

  it("refuses an inactive item on a new document", async () => {
    const error = await resolve({ items: [itemRow({ status: "INACTIVE" })] }, [
      payload(),
    ]).catch((cause) => cause);

    expect(error).toBeInstanceOf(DocumentServiceError);
    // The message quotes the enum member, because `ItemStatus` has ACTIVE and
    // INACTIVE only — archiving is a `Contact` concept, not an item one.
    expect((error as DocumentServiceError).message).toMatch(/inactive/i);
  });

  it("still prints an inactive item on a stored document", async () => {
    const { line } = await resolve(
      { items: [itemRow({ status: "INACTIVE" })] },
      [payload({ unitPrice: "1000.0000", description: "Cargo service" })],
      { source: "stored" },
    );

    // History survives a catalogue change: the figures are the row's own.
    expect(line?.unitPrice).toBe("1000.0000");
    expect(line?.description).toBe("Cargo service");
  });

  it("refuses to sell an item priced in another currency", async () => {
    const error = await resolve(
      { items: [itemRow({ currency: "UGX" })] },
      [payload()],
      { currency: "KES" },
    ).catch((cause) => cause);

    expect((error as DocumentServiceError).message).toMatch(/priced in UGX/);
  });

  it("keeps a free-text line exactly as the caller wrote it", async () => {
    const { resolved, line } = await resolve({}, [
      payload({
        itemId: null,
        description: "Emergency after-hours callout",
        unitPrice: "250.0000",
        unitOfMeasure: "hour",
      }),
    ]);

    expect(line?.description).toBe("Emergency after-hours callout");
    expect(line?.unitPrice).toBe("250.0000");
    expect(line?.itemCode).toBe("FORGED");
    expect(resolved.priceSources).toEqual(["manual"]);
  });
});

/* ─────────────── the agreement applies to its customer and item ─────────── */

describe("customer-specific pricing precedence", () => {
  it("sells at the agreed price for the intended customer", async () => {
    const { resolved, line, queries } = await resolve(
      { items: [itemRow()], agreements: [agreementRow()] },
      [payload()],
      { contactId: ACME, asOf: "2026-05-01" },
    );

    expect(line?.unitPrice).toBe("900.0000");
    expect(line?.description).toBe("Cargo service (Acme rate)");
    expect(line?.itemCode).toBe("ACME-SRV");
    expect(resolved.priceSources).toEqual(["customer"]);

    // The lookup itself is tenant-and-customer scoped, not global.
    const agreementQuery = queries.find((q) => q.model === "contactItem");
    expect(agreementQuery?.where).toMatchObject({
      tenantId: TENANT,
      contactId: ACME,
    });
  });

  it("gives another customer the standard price for the same item", async () => {
    const { line } = await resolve(
      { items: [itemRow()], agreements: [agreementRow()] },
      [payload()],
      { contactId: GLOBEX, asOf: "2026-05-01" },
    );

    expect(line?.unitPrice).toBe("1000.0000");
    expect(line?.description).toBe("Cargo service");
  });

  it("gives a document with no customer the standard price", async () => {
    const { line } = await resolve(
      { items: [itemRow()], agreements: [agreementRow()] },
      [payload()],
      { asOf: "2026-05-01" },
    );

    expect(line?.unitPrice).toBe("1000.0000");
  });

  it("falls back to the catalogue when the agreement is suspended", async () => {
    const { resolved, line } = await resolve(
      {
        items: [itemRow()],
        agreements: [
          agreementRow({ isAvailable: false, agreedPrice: "1.0000" }),
        ],
      },
      [payload()],
      { contactId: ACME, asOf: "2026-05-01" },
    );

    expect(line?.unitPrice).toBe("1000.0000");
    expect(resolved.priceSources).toEqual(["catalogue"]);
  });

  it("honours an agreement inside its window, bounds inclusive", async () => {
    const agreements = [
      agreementRow({
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-12-31T00:00:00.000Z"),
      }),
    ];

    for (const asOf of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
      const { line } = await resolve(
        { items: [itemRow()], agreements },
        [payload()],
        { contactId: ACME, asOf },
      );
      expect(line?.unitPrice).toBe("900.0000");
    }
  });

  it("ignores an expired or not-yet-started agreement", async () => {
    const agreements = [
      agreementRow({
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-12-31T00:00:00.000Z"),
      }),
    ];

    for (const asOf of ["2025-12-31", "2027-01-01"]) {
      const { line } = await resolve(
        { items: [itemRow()], agreements },
        [payload()],
        { contactId: ACME, asOf },
      );
      expect(line?.unitPrice).toBe("1000.0000");
    }
  });

  it("never charges a bounded agreement it cannot verify a date against", async () => {
    const { line } = await resolve(
      {
        items: [itemRow()],
        agreements: [
          agreementRow({
            validUntil: new Date("2026-12-31T00:00:00.000Z"),
          }),
        ],
      },
      [payload()],
      { contactId: ACME },
    );

    expect(line?.unitPrice).toBe("1000.0000");
  });

  it("uses the agreed discount instead of the line's own", async () => {
    const { resolved, line } = await resolve(
      {
        items: [itemRow()],
        agreements: [agreementRow({ discountPercent: "10.0000" })],
      },
      [payload({ discountType: "AMOUNT", discountAmount: "500.0000" })],
      { contactId: ACME, asOf: "2026-05-01" },
    );

    // 2 × 900 = 1800, less the agreed 10% = 180, net 1620, VAT 16% = 259.20.
    expect(line?.discountType).toBe("PERCENT");
    expect(line?.discountPercent).toBe("10.0000");
    expect(resolved.calculation.lines[0]?.lineDiscount).toBe("180.0000");
    expect(resolved.calculation.lines[0]?.lineNet).toBe("1620.0000");
    expect(resolved.calculation.total).toBe("1879.2000");
  });

  it("keeps the line's own discount when the agreement sets none", async () => {
    const { line } = await resolve(
      { items: [itemRow()] },
      [payload({ discountType: "PERCENT", discountPercent: "5" })],
      { contactId: ACME, asOf: "2026-05-01" },
    );

    expect(line?.discountType).toBe("PERCENT");
    expect(line?.discountPercent).toBe("5.0000");
  });

  it("still reports a malformed discount as a caller error", async () => {
    await expect(
      resolve(
        {
          items: [itemRow()],
          agreements: [agreementRow({ discountPercent: "10" })],
        },
        [
          payload({
            discountType: "PERCENT",
            discountPercent: "10",
            discountAmount: "5",
          }),
        ],
        { contactId: ACME },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

/* ────────────────────────── tax and provenance ──────────────────────────── */

describe("the catalogue decides the tax classification", () => {
  it("copies the item's rate rather than trusting the line", async () => {
    const { line } = await resolve(
      {
        items: [itemRow()],
        rates: [
          rateRow(),
          rateRow({ id: ZERO_RATE, name: "Exempt", rate: "0.0000" }),
        ],
      },
      [payload({ taxRateId: ZERO_RATE })],
    );

    expect(line?.taxRateId).toBe(VAT);
    expect(line?.taxName).toBe("VAT 16%");
    expect(line?.taxRate).toBe("0.1600");
  });

  it("lets the line choose when the item has no classification", async () => {
    const { line } = await resolve(
      {
        items: [itemRow({ taxRateId: null, taxRate: null })],
        rates: [rateRow({ id: ZERO_RATE, name: "Exempt", rate: "0.0000" })],
      },
      [payload({ taxRateId: ZERO_RATE })],
    );

    expect(line?.taxRateId).toBe(ZERO_RATE);
    expect(line?.taxName).toBe("Exempt");
  });

  it("refuses to tax at zero when the item's rate cannot be read", async () => {
    const error = await resolve({ items: [itemRow({ taxRate: null })] }, [
      payload(),
    ]).catch((cause) => cause);

    expect((error as DocumentServiceError).message).toMatch(
      /could not be read/,
    );
  });

  it("rejects a tax rate that belongs to another business", async () => {
    await expect(
      resolve({}, [payload({ itemId: null, taxRateId: VAT })], {}),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("summarises provenance without touching money or names", () => {
    expect(
      summarisePriceSources(["customer", "customer", "catalogue", "manual"]),
    ).toEqual({ customer: 2, catalogue: 1, manual: 1 });
  });
});

/* ───────────────── issuance does not re-price the reviewed draft ─────────── */

describe("a stored line keeps the figures the draft was reviewed with", () => {
  it("ignores a catalogue price change between draft and issue", async () => {
    const { line, resolved } = await resolve(
      // The catalogue has moved on since the draft was written.
      { items: [itemRow({ unitPrice: "1500.0000" })], agreements: [] },
      [payload({ unitPrice: "1000.0000", description: "Cargo service" })],
      { source: "stored", contactId: ACME, asOf: "2026-05-01" },
    );

    expect(line?.unitPrice).toBe("1000.0000");
    expect(resolved.priceSources).toEqual(["stored"]);
  });

  it("does not even look for agreements when nothing may re-price the line", async () => {
    const { queries } = await resolve(
      { items: [itemRow()] },
      [payload({ unitPrice: "1000.0000" })],
      { source: "stored", contactId: ACME },
    );

    expect(queries.some((query) => query.model === "contactItem")).toBe(false);
  });
});

/* ───────────── the server and the offline rule cannot drift ─────────────── */

describe("the shared precedence rule", () => {
  const source: CatalogueItemSource = {
    itemId: ITEM,
    name: "Cargo service",
    description: "Per shipment, door to door",
    sku: "SRV-1",
    unitOfMeasure: "each",
    unitPrice: "1000.0000",
    currency: "KES",
    taxRateId: VAT,
    taxName: "VAT 16%",
    taxRate: "0.1600",
  };

  it("produces the same line whether the server or the pure builder resolves it", async () => {
    const cases: Array<{
      override: Record<string, unknown> | null;
      discount: DocumentLinePayload;
      asOf: string | null;
    }> = [
      { override: null, discount: payload(), asOf: "2026-05-01" },
      {
        override: agreementRow({ discountPercent: "10.0000" }),
        discount: payload(),
        asOf: "2026-05-01",
      },
      {
        override: agreementRow({ isAvailable: false }),
        discount: payload({ discountType: "AMOUNT", discountAmount: "100" }),
        asOf: "2026-05-01",
      },
      {
        override: agreementRow({
          validUntil: new Date("2026-01-01T00:00:00.000Z"),
        }),
        discount: payload(),
        asOf: "2026-05-01",
      },
    ];

    for (const testCase of cases) {
      const agreements = testCase.override ? [testCase.override] : [];
      const { resolved, line } = await resolve(
        { items: [itemRow()], agreements },
        [testCase.discount],
        { contactId: ACME, asOf: testCase.asOf },
      );

      const offline = buildDocumentLineSnapshot({
        item: source,
        override: testCase.override
          ? {
              customCode:
                (testCase.override.customCode as string | null) ?? null,
              customName:
                (testCase.override.customName as string | null) ?? null,
              customUnitOfMeasure:
                (testCase.override.customUnitOfMeasure as string | null) ??
                null,
              agreedPrice: testCase.override.agreedPrice as string,
              discountPercent: testCase.override.discountPercent as string,
              isAvailable: testCase.override.isAvailable as boolean,
              validFrom:
                (testCase.override.validFrom as Date | null)?.toISOString() ??
                null,
              validUntil:
                (testCase.override.validUntil as Date | null)?.toISOString() ??
                null,
            }
          : null,
        quantity: testCase.discount.quantity,
        documentDiscount: {
          discountType: testCase.discount.discountType,
          discountPercent: testCase.discount.discountPercent,
          discountAmount: testCase.discount.discountAmount,
        },
        asOf: testCase.asOf,
      });

      expect(line?.description).toBe(offline.description);
      expect(line?.itemCode).toBe(offline.itemCode);
      expect(line?.unitOfMeasure).toBe(offline.unitOfMeasure);
      expect(line?.unitPrice).toBe(offline.unitPrice);
      expect(line?.discountType).toBe(offline.discountType);
      expect(line?.discountPercent).toBe(offline.discountPercent);
      expect(resolved.calculation.lines[0]?.lineNet).toBe(offline.lineNet);
    }
  });

  it("applies an amount discount through the pure builder too", () => {
    const line = buildDocumentLineSnapshot({
      item: source,
      quantity: "2",
      documentDiscount: {
        discountType: "AMOUNT",
        discountPercent: "0",
        discountAmount: "150.00",
      },
    });

    expect(line.discountType).toBe("AMOUNT");
    expect(line.lineTotal).toBe("2000.0000");
    expect(line.lineDiscount).toBe("150.0000");
    expect(line.lineNet).toBe("1850.0000");
  });
});

/* ─────────────── the seam is wired into the write path ──────────────────── */

describe("createDraft passes the customer and the document date to the resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the agreed price, not the price the browser sent", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: ACME });
    prismaMock.item.findMany.mockResolvedValue([itemRow()]);
    prismaMock.contactItem.findMany.mockResolvedValue([
      agreementRow({ discountPercent: "10.0000" }),
    ]);
    prismaMock.document.create.mockResolvedValue({ id: DOC_ID });
    prismaMock.documentLine.createMany.mockResolvedValue({ count: 1 });
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    await createDraft(context(), USER_ID, {
      type: "QUOTATION",
      contactId: ACME,
      currency: "KES",
      issueDate: new Date("2026-05-01T00:00:00.000Z"),
      dueDate: null,
      expiryDate: null,
      deliveryDate: null,
      customerNote: null,
      terms: null,
      deliveryNote: null,
      sourceDocumentId: null,
      replacementOfId: null,
      idempotencyKey: null,
      lines: [payload({ unitPrice: "0.0100" })],
    });

    const agreementWhere = prismaMock.contactItem.findMany.mock
      .calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(agreementWhere.where).toMatchObject({
      tenantId: TENANT,
      contactId: ACME,
    });

    const written = prismaMock.documentLine.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(written.data[0]?.unitPrice).toBe("900.0000");
    expect(written.data[0]?.discountPercent).toBe("10.0000");
    expect(written.data[0]?.description).toBe("Cargo service (Acme rate)");

    // Provenance is audited as counts — no prices, no names, no customer id.
    const audit = auditsFor(AUDIT_ACTIONS.DOCUMENT_CREATED)[0];
    expect(audit?.metadata).toMatchObject({
      type: "QUOTATION",
      pricing: { customer: 1 },
    });
  });
});
