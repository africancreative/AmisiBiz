import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import type { TenantRole } from "@prisma/client";

/**
 * Phase 03 — business dashboard, catalogue snapshot and repository ports.
 *
 * This suite covers the parts of the business workspace that Phase 04's
 * security tests do not: the dashboard read model (tenant scoping and the
 * status arithmetic), the rule that a document line copies item details and
 * price instead of reading the live catalogue, exact decimal arithmetic, and a
 * non-Prisma implementation of the repository ports that proves the offline
 * seam is real rather than a naming exercise.
 *
 * Cross-tenant reads, required fields, invalid prices, search, pagination and
 * archiving for the contact and item Server Actions are already asserted in
 * `phase04-security.test.ts`; those are not duplicated here.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));

import { prismaMock } from "./prisma-mock";
import { authMock } from "./auth-mock";
import { PERMISSIONS, tenantRoleHasPermission } from "@amisibiz/auth";
import { getDashboardOverviewAction } from "@/server/actions/dashboard";
import {
  addDecimalStrings,
  buildDocumentLineSnapshot,
  multiplyDecimalStrings,
  subtractDecimalStrings,
  type CatalogueItemSource,
} from "@amisibiz/documents";
import {
  CONTACT_TYPES,
  ITEM_STATUSES,
  ITEM_TYPES,
  type ContactItemRecord,
  type ContactItemRepository,
  type ContactRecord,
  type ContactRepository,
  type ItemRecord,
  type ItemRepository,
  type Page,
} from "@amisibiz/domain";
import {
  contactItemFormSchema,
  createContactItemSchema,
} from "@/lib/validations/contact-item";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

type TenantStatus = "ACTIVE" | "SUSPENDED" | "PENDING";

/** Membership is keyed by (tenantId, userId): only `memberOf` resolves. */
function asRole(
  role: TenantRole,
  status: TenantStatus = "ACTIVE",
  memberOf: string = TENANT_ID,
) {
  prismaMock.tenantMember.findUnique.mockImplementation(
    async (args: unknown) => {
      const key =
        (
          args as
            | {
                where?: {
                  tenantId_userId?: { tenantId?: string; userId?: string };
                };
              }
            | undefined
        )?.where?.tenantId_userId ?? {};
      if (key.tenantId !== memberOf || key.userId !== USER_ID) return null;
      return { role, tenant: { status } };
    },
  );
}

type Loose = {
  success: boolean;
  data?: Record<string, unknown>;
  code?: string;
  error?: string;
};

function loose(result: unknown): Loose {
  return result as Loose;
}

/** The dashboard read model, typed locally so assertions read naturally. */
type DashboardData = {
  contacts: { total: number; active: number; archived: number };
  items: {
    total: number;
    active: number;
    inactive: number;
    products: number;
    services: number;
  };
  documents: {
    quotations: { total: number; draft: number; open: number };
    invoices: {
      total: number;
      draft: number;
      outstanding: number;
      paid: number;
    };
    deliveryNotes: { total: number; draft: number; delivered: number };
  };
  outstanding: { total: string; currency: string; count: number };
  overdue: { total: string; currency: string; count: number };
  recentDocuments: unknown[];
  outstandingInvoices: unknown[];
};

function dashData(result: unknown): DashboardData {
  return loose(result).data as unknown as DashboardData;
}

/** Rows returned by the grouped-count queries. */
const CONTACT_GROUPS = [
  { status: "ACTIVE", _count: { _all: 5 } },
  { status: "ARCHIVED", _count: { _all: 2 } },
];

const ITEM_GROUPS = [
  { type: "PRODUCT", status: "ACTIVE", _count: { _all: 3 } },
  { type: "SERVICE", status: "ACTIVE", _count: { _all: 2 } },
  { type: "PRODUCT", status: "INACTIVE", _count: { _all: 1 } },
];

const DOCUMENT_GROUPS = [
  { type: "QUOTATION", status: "DRAFT", _count: { _all: 2 } },
  { type: "QUOTATION", status: "ISSUED", _count: { _all: 1 } },
  { type: "QUOTATION", status: "ACCEPTED", _count: { _all: 1 } },
  { type: "INVOICE", status: "DRAFT", _count: { _all: 1 } },
  { type: "INVOICE", status: "ISSUED", _count: { _all: 2 } },
  { type: "INVOICE", status: "OVERDUE", _count: { _all: 1 } },
  { type: "INVOICE", status: "PAID", _count: { _all: 3 } },
  { type: "INVOICE", status: "PARTIALLY_PAID", _count: { _all: 1 } },
  { type: "DELIVERY_NOTE", status: "DRAFT", _count: { _all: 1 } },
  { type: "DELIVERY_NOTE", status: "DELIVERED", _count: { _all: 2 } },
];

function primeDashboard() {
  prismaMock.contact.groupBy.mockResolvedValue(CONTACT_GROUPS);
  prismaMock.item.groupBy.mockResolvedValue(ITEM_GROUPS);
  prismaMock.document.groupBy.mockResolvedValue(DOCUMENT_GROUPS);
  prismaMock.document.aggregate.mockResolvedValue({
    _sum: { total: new Prisma.Decimal("1234.5600") },
  });
  prismaMock.document.findMany.mockResolvedValue([]);
  prismaMock.tenant.findUnique.mockResolvedValue({
    name: "Amisi Co. Ltd",
    currency: "KES",
  });
  prismaMock.tenantBranding.findUnique.mockResolvedValue({
    displayName: "Amisi",
    logoUrl: null,
    primaryColor: "#1d4ed8",
    secondaryColor: "#1e3a5f",
    accentColor: "#f59e0b",
    currency: "KES",
  });
}

/** First argument of a Prisma delegate call, as a plain object. */
function callArg(mock: unknown, index = 0): Record<string, unknown> {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[index]?.[0] ?? {}) as Record<string, unknown>;
}

function neutralValue(name: string): unknown {
  switch (name) {
    case "findMany":
      return [];
    case "groupBy":
      return [];
    case "count":
      return 0;
    case "aggregate":
      return { _sum: { total: null } };
    default:
      return null;
  }
}

function resetDelegate(delegate: object) {
  for (const name of Object.keys(delegate)) {
    const fn = (delegate as Record<string, unknown>)[name];
    const resolve = (
      fn as { mockResolvedValue?: (value: unknown) => void } | null
    )?.mockResolvedValue;
    if (typeof resolve === "function") resolve.call(fn, neutralValue(name));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  authMock.mockResolvedValue({
    id: USER_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: null,
    status: "ACTIVE",
  });

  for (const delegate of [
    prismaMock.contact,
    prismaMock.item,
    prismaMock.document,
    prismaMock.tenant,
    prismaMock.tenantBranding,
    prismaMock.tenantMember,
    prismaMock.user,
  ]) {
    resetDelegate(delegate);
  }

  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Dashboard: authorization ─────────────────────────────────────────────────

describe("dashboard authorization", () => {
  it("refuses a tenant the caller is not a member of, before reading anything", async () => {
    asRole("TENANT_OWNER", "ACTIVE", OTHER_TENANT_ID); // member of the OTHER tenant

    const result = loose(await getDashboardOverviewAction(TENANT_ID));

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    // No statistic may be assembled for a tenant the caller cannot read.
    expect(prismaMock.document.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.contact.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.document.aggregate).not.toHaveBeenCalled();
  });

  it("refuses the customer-portal role, which holds no documents.read", async () => {
    asRole("CUSTOMER_PORTAL_USER");

    const result = loose(await getDashboardOverviewAction(TENANT_ID));

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.document.groupBy).not.toHaveBeenCalled();
  });

  it("does not expose internal contact notes to the customer-portal role", () => {
    // The dashboard and contacts module both gate on a permission the portal role
    // does not hold; the portal can never reach a contact's internal `notes`.
    expect(
      tenantRoleHasPermission(
        "CUSTOMER_PORTAL_USER",
        PERMISSIONS.CONTACTS_READ,
      ),
    ).toBe(false);
    expect(
      tenantRoleHasPermission(
        "CUSTOMER_PORTAL_USER",
        PERMISSIONS.DOCUMENTS_READ,
      ),
    ).toBe(false);
  });
});

// ─── Dashboard: tenant-scoped aggregation ─────────────────────────────────────

describe("dashboard aggregation", () => {
  it("scopes every statistic to the authorized tenant", async () => {
    asRole("TENANT_OWNER");
    primeDashboard();

    const result = loose(await getDashboardOverviewAction(TENANT_ID));

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.contact.groupBy).where).toMatchObject({
      tenantId: TENANT_ID,
    });
    expect(callArg(prismaMock.item.groupBy).where).toMatchObject({
      tenantId: TENANT_ID,
    });
    expect(callArg(prismaMock.document.groupBy).where).toMatchObject({
      tenantId: TENANT_ID,
    });
    expect(callArg(prismaMock.document.aggregate).where).toMatchObject({
      tenantId: TENANT_ID,
      type: "INVOICE",
    });
    for (const call of prismaMock.document.findMany.mock.calls) {
      const where = (call[0] as { where?: Record<string, unknown> }).where;
      expect(where).toMatchObject({ tenantId: TENANT_ID });
    }
  });

  it("derives status counts from the grouped rows", async () => {
    asRole("TENANT_OWNER");
    primeDashboard();

    const data = dashData(await getDashboardOverviewAction(TENANT_ID));

    expect(data.contacts).toEqual({ total: 7, active: 5, archived: 2 });
    expect(data.items).toEqual({
      total: 6,
      active: 5,
      inactive: 1,
      products: 4,
      services: 2,
    });
    expect(data.documents.quotations).toEqual({ total: 4, draft: 2, open: 2 });
    expect(data.documents.invoices).toEqual({
      total: 8,
      draft: 1,
      outstanding: 4, // ISSUED 2 + OVERDUE 1 + PARTIALLY_PAID 1
      paid: 3,
    });
    expect(data.documents.deliveryNotes).toEqual({
      total: 3,
      draft: 1,
      delivered: 2,
    });
    expect(data.overdue).toMatchObject({ count: 1, currency: "KES" });
  });

  it("returns the outstanding total as an exact decimal string", async () => {
    asRole("TENANT_OWNER");
    primeDashboard();

    const data = dashData(await getDashboardOverviewAction(TENANT_ID));

    expect(data.outstanding.total).toBe("1234.56");
    expect(data.outstanding.currency).toBe("KES");
    expect(data.outstanding.count).toBe(4);
    expect(typeof data.outstanding.total).toBe("string");
  });

  it("returns zeroed totals and empty lists for a workspace with no records", async () => {
    asRole("TENANT_OWNER");
    primeDashboard();
    prismaMock.contact.groupBy.mockResolvedValue([]);
    prismaMock.item.groupBy.mockResolvedValue([]);
    prismaMock.document.groupBy.mockResolvedValue([]);
    prismaMock.document.aggregate.mockResolvedValue({ _sum: { total: null } });
    prismaMock.tenantBranding.findUnique.mockResolvedValue(null);

    const data = dashData(await getDashboardOverviewAction(TENANT_ID));

    expect(data.contacts.total).toBe(0);
    expect(data.items.total).toBe(0);
    expect(data.documents.invoices.total).toBe(0);
    expect(data.outstanding).toEqual({ total: "0", currency: "KES", count: 0 });
    expect(data.recentDocuments).toEqual([]);
    expect(data.outstandingInvoices).toEqual([]);
  });

  it("reports an internal failure without leaking the cause", async () => {
    asRole("TENANT_OWNER");
    primeDashboard();
    prismaMock.contact.groupBy.mockRejectedValue(new Error("db exploded"));

    const result = loose(await getDashboardOverviewAction(TENANT_ID));

    expect(result.success).toBe(false);
    expect(result.code).toBe("INTERNAL");
    expect(result.error).not.toContain("db exploded");
  });
});

// ─── Document-line snapshot: copy, don't recompute ────────────────────────────

const catalogueItem: CatalogueItemSource = {
  itemId: "55555555-5555-4555-8555-555555550001",
  name: "Cargo service",
  description: "Per shipment",
  sku: "SRV-1",
  unitOfMeasure: "each",
  unitPrice: "1000.00",
  currency: "KES",
  taxRateId: "66666666-6666-4666-8666-666666660001",
  taxName: "VAT 16%",
  taxRate: "0.16",
};

describe("document line snapshot", () => {
  it("copies the item's description, code, unit, price and tax", () => {
    const line = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "2",
    });

    expect(line.description).toBe("Cargo service");
    expect(line.itemCode).toBe("SRV-1");
    expect(line.unitOfMeasure).toBe("each");
    expect(line.unitPrice).toBe("1000.0000");
    expect(line.taxName).toBe("VAT 16%");
    expect(line.taxRate).toBe("0.16");
    expect(line.priceSource).toBe("catalogue");
    expect(line.lineTotal).toBe("2000.0000");
    expect(line.lineNet).toBe("2000.0000");
  });

  it("does not change a built line when the catalogue item is edited afterwards", () => {
    const mutable: CatalogueItemSource = { ...catalogueItem };
    const line = buildDocumentLineSnapshot({ item: mutable, quantity: "1" });

    // A later catalogue edit mutates the source object...
    mutable.unitPrice = "1500.00";
    mutable.name = "Cargo service (new price)";

    // ...but the line already froze the values it copied.
    expect(line.unitPrice).toBe("1000.0000");
    expect(line.description).toBe("Cargo service");
  });

  it("applies an available customer-specific price and code", () => {
    const line = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "2",
      override: {
        customCode: "ACME-SRV",
        customName: "Cargo service (Acme rate)",
        agreedPrice: "900.00",
        discountPercent: "10.00",
        isAvailable: true,
      },
    });

    expect(line.priceSource).toBe("customer");
    expect(line.description).toBe("Cargo service (Acme rate)");
    expect(line.itemCode).toBe("ACME-SRV");
    expect(line.unitPrice).toBe("900.0000");
    expect(line.lineTotal).toBe("1800.0000");
    expect(line.lineDiscount).toBe("180.0000");
    expect(line.lineNet).toBe("1620.0000");
    expect(line.discountType).toBe("PERCENT");
  });

  it("ignores an unavailable customer override and falls back to the catalogue", () => {
    const line = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "1",
      override: {
        customCode: "ACME-SRV",
        customName: "Withdrawn rate",
        agreedPrice: "1.00",
        discountPercent: "50.00",
        isAvailable: false,
      },
    });

    expect(line.priceSource).toBe("catalogue");
    expect(line.unitPrice).toBe("1000.0000");
    expect(line.lineNet).toBe("1000.0000");
    expect(line.discountPercent).toBe("0.0000");
  });

  it("multiplies fractional quantities exactly", () => {
    const line = buildDocumentLineSnapshot({
      item: { ...catalogueItem, unitPrice: "19.9999" },
      quantity: "3",
    });

    // 3 × 19.9999 = 59.9997 exactly — a float would round differently.
    expect(line.lineTotal).toBe("59.9997");
  });

  it("copies a customer-specific unit when the agreement provides one", () => {
    const line = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "1",
      override: {
        customCode: null,
        customName: null,
        customUnitOfMeasure: "carton",
        agreedPrice: "900.00",
        discountPercent: "0",
        isAvailable: true,
      },
    });

    expect(line.priceSource).toBe("customer");
    expect(line.unitOfMeasure).toBe("carton");
  });

  it("keeps the catalogue unit when the customer agreement has none", () => {
    const line = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "1",
      override: {
        customCode: null,
        customName: null,
        agreedPrice: "900.00",
        discountPercent: "0",
        isAvailable: true,
      },
    });

    expect(line.unitOfMeasure).toBe("each");
  });

  it("applies an agreement inside its validity window (bounds inclusive)", () => {
    const override = {
      customCode: null,
      customName: null,
      agreedPrice: "900.00",
      discountPercent: "0",
      isAvailable: true,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    };

    for (const asOf of ["2026-06-15", "2026-01-01", "2026-12-31"]) {
      const line = buildDocumentLineSnapshot({
        item: catalogueItem,
        quantity: "1",
        override,
        asOf,
      });
      expect(line.priceSource).toBe("customer");
      expect(line.unitPrice).toBe("900.0000");
    }
  });

  it("falls back to the catalogue before and after the validity window", () => {
    const override = {
      customCode: null,
      customName: null,
      agreedPrice: "900.00",
      discountPercent: "0",
      isAvailable: true,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    };

    const before = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "1",
      override,
      asOf: "2025-12-31",
    });
    const after = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "1",
      override,
      asOf: "2027-01-01",
    });

    expect(before.priceSource).toBe("catalogue");
    expect(before.unitPrice).toBe("1000.0000");
    expect(after.priceSource).toBe("catalogue");
    expect(after.unitPrice).toBe("1000.0000");
  });

  it("never applies a bounded agreement when no date is given to verify it", () => {
    const line = buildDocumentLineSnapshot({
      item: catalogueItem,
      quantity: "1",
      override: {
        customCode: null,
        customName: null,
        agreedPrice: "900.00",
        discountPercent: "0",
        isAvailable: true,
        validUntil: "2026-12-31",
      },
    });

    expect(line.priceSource).toBe("catalogue");
    expect(line.unitPrice).toBe("1000.0000");
  });

  it("applies an open-ended agreement regardless of date", () => {
    const override = {
      customCode: null,
      customName: null,
      agreedPrice: "900.00",
      discountPercent: "0",
      isAvailable: true,
      validFrom: null,
      validUntil: null,
    };

    expect(
      buildDocumentLineSnapshot({
        item: catalogueItem,
        quantity: "1",
        override,
      }).priceSource,
    ).toBe("customer");
    expect(
      buildDocumentLineSnapshot({
        item: catalogueItem,
        quantity: "1",
        override,
        asOf: "2099-01-01",
      }).priceSource,
    ).toBe("customer");
  });
});

// ─── Customer catalogue terms: unit and validity window ───────────────────────

describe("customer catalogue assignment terms", () => {
  const valid = {
    tenantId: TENANT_ID,
    contactId: "77777777-7777-4777-8777-777777770001",
    itemId: "55555555-5555-4555-8555-555555550001",
    agreedPrice: "90.00",
  };

  it("accepts a custom unit and a well-formed validity window", () => {
    const parsed = createContactItemSchema.safeParse({
      ...valid,
      customUnitOfMeasure: "carton",
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.customUnitOfMeasure).toBe("carton");
    expect(parsed.data.validFrom).toBeInstanceOf(Date);
    expect(parsed.data.validUntil).toBeInstanceOf(Date);
  });

  it("accepts an open-ended window (either bound absent)", () => {
    const parsed = createContactItemSchema.safeParse({
      ...valid,
      validFrom: "2026-01-01",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.validFrom).toBeInstanceOf(Date);
    expect(parsed.data.validUntil).toBeNull();
  });

  it("rejects a validity window that runs backwards", () => {
    const parsed = createContactItemSchema.safeParse({
      ...valid,
      validFrom: "2026-12-31",
      validUntil: "2026-01-01",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["validUntil"]);
  });

  it("rejects an over-long customer unit", () => {
    const parsed = createContactItemSchema.safeParse({
      ...valid,
      customUnitOfMeasure: "x".repeat(21),
    });

    expect(parsed.success).toBe(false);
  });

  it("mirrors the window rule in the form schema", () => {
    const inverted = contactItemFormSchema.safeParse({
      itemId: "",
      customCode: "",
      customName: "",
      customUnitOfMeasure: "",
      agreedPrice: "1.00",
      discountPercent: "0",
      isAvailable: true,
      validFrom: "2026-12-31",
      validUntil: "2026-01-01",
    });
    expect(inverted.success).toBe(false);

    const validWindow = contactItemFormSchema.safeParse({
      itemId: "",
      customCode: "",
      customName: "",
      customUnitOfMeasure: "carton",
      agreedPrice: "1.00",
      discountPercent: "0",
      isAvailable: true,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    });
    expect(validWindow.success).toBe(true);
  });

  it("carries the new terms through the repository port", async () => {
    const contacts = new InMemoryContactRepository([
      makeContact("c1", TENANT_ID),
    ]);
    const items = new InMemoryItemRepository([makeItem("i1", TENANT_ID)]);
    const link = new InMemoryContactItemRepository(contacts, items);

    const record = await link.upsert(TENANT_ID, {
      contactId: "c1",
      itemId: "i1",
      customUnitOfMeasure: "carton",
      agreedPrice: "90.00",
      discountPercent: "0",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-12-31T00:00:00.000Z",
    });

    expect(record.customUnitOfMeasure).toBe("carton");
    expect(record.validFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(record.validUntil).toBe("2026-12-31T00:00:00.000Z");
    expect(record.isAvailable).toBe(true);
  });
});

// ─── Exact decimal arithmetic ─────────────────────────────────────────────────

describe("exact decimal arithmetic", () => {
  it("adds, subtracts and multiplies without binary floating point", () => {
    // 0.1 + 0.2 is famously 0.30000000000000004 as a JS number.
    expect(addDecimalStrings("0.1", "0.2")).toBe("0.3");
    expect(subtractDecimalStrings("0.3", "0.1")).toBe("0.2");
    expect(multiplyDecimalStrings("1.1", "1.1")).toBe("1.21");
  });

  it("handles magnitudes larger than Number.MAX_SAFE_INTEGER", () => {
    expect(multiplyDecimalStrings("99999999999999999999", "2")).toBe(
      "199999999999999999998",
    );
  });

  it("returns null for malformed input rather than a silent zero", () => {
    expect(addDecimalStrings("1,000", "1")).toBeNull();
    expect(multiplyDecimalStrings("abc", "2")).toBeNull();
  });

  it("crosses zero correctly when subtracting", () => {
    // Scale is preserved: subtracting two 2-dp values stays at 2 dp.
    expect(subtractDecimalStrings("5.00", "12.50")).toBe("-7.50");
    expect(subtractDecimalStrings("12.50", "5.00")).toBe("7.50");
  });
});

// ─── Repository ports: implementable without Prisma ───────────────────────────

/**
 * A tiny in-memory implementation of the three repository ports.
 *
 * It exists to prove the seam is real: the same interfaces a future SQLite
 * adapter will implement can be satisfied by a plain Map, with no Prisma, no
 * PostgreSQL and no RLS. Every read is tenant-scoped, honouring the contract in
 * `@amisibiz/domain`.
 */
class InMemoryContactRepository implements ContactRepository {
  private readonly rows = new Map<string, ContactRecord>();

  constructor(seed: ContactRecord[] = []) {
    for (const row of seed) this.rows.set(row.id, { ...row });
  }

  async findById(tenantId: string, contactId: string) {
    const row = this.rows.get(contactId);
    return row && row.tenantId === tenantId ? { ...row } : null;
  }

  async list(
    tenantId: string,
    query: Parameters<ContactRepository["list"]>[1],
  ): Promise<Page<ContactRecord>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const search = query.search?.toLowerCase();
    const filtered = [...this.rows.values()].filter((row) => {
      if (row.tenantId !== tenantId) return false;
      if (query.status && row.status !== query.status) return false;
      if (query.type && row.type !== query.type) return false;
      if (!search) return true;
      return [row.firstName, row.lastName, row.companyName, row.email]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(search));
    });
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    };
  }

  async create(
    tenantId: string,
    input: Parameters<ContactRepository["create"]>[1],
  ) {
    const id = `contact-${this.rows.size + 1}`;
    const row: ContactRecord = {
      id,
      tenantId,
      type: input.type,
      status: "ACTIVE",
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      companyName: input.companyName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      mobile: input.mobile ?? null,
      taxPin: input.taxPin ?? null,
      notes: input.notes ?? null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      addresses: [],
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async update(
    tenantId: string,
    contactId: string,
    input: Parameters<ContactRepository["update"]>[2],
  ) {
    const row = this.rows.get(contactId);
    if (!row || row.tenantId !== tenantId) return null;
    Object.assign(row, input);
    return { ...row };
  }

  async archive(tenantId: string, contactId: string) {
    const row = this.rows.get(contactId);
    if (!row || row.tenantId !== tenantId || row.status === "ARCHIVED") {
      return false;
    }
    row.status = "ARCHIVED";
    row.archivedAt = "2026-02-01T00:00:00.000Z";
    return true;
  }

  async restore(tenantId: string, contactId: string) {
    const row = this.rows.get(contactId);
    if (!row || row.tenantId !== tenantId || row.status === "ACTIVE") {
      return false;
    }
    row.status = "ACTIVE";
    row.archivedAt = null;
    return true;
  }
}

class InMemoryItemRepository implements ItemRepository {
  private readonly rows = new Map<string, ItemRecord>();

  constructor(seed: ItemRecord[] = []) {
    for (const row of seed) this.rows.set(row.id, { ...row });
  }

  async findById(tenantId: string, itemId: string) {
    const row = this.rows.get(itemId);
    return row && row.tenantId === tenantId ? { ...row } : null;
  }

  async list(
    tenantId: string,
    query: Parameters<ItemRepository["list"]>[1],
  ): Promise<Page<ItemRecord>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const search = query.search?.toLowerCase();
    const filtered = [...this.rows.values()].filter((row) => {
      if (row.tenantId !== tenantId) return false;
      if (query.status && row.status !== query.status) return false;
      if (query.type && row.type !== query.type) return false;
      if (!search) return true;
      return [row.name, row.sku]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(search));
    });
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    };
  }

  async create(
    tenantId: string,
    input: Parameters<ItemRepository["create"]>[1],
  ) {
    const id = `item-${this.rows.size + 1}`;
    const row: ItemRecord = {
      id,
      tenantId,
      type: input.type,
      status: "ACTIVE",
      name: input.name,
      sku: input.sku ?? null,
      description: input.description ?? null,
      unitOfMeasure: input.unitOfMeasure,
      unitPrice: input.unitPrice,
      currency: input.currency,
      taxRateId: input.taxRateId ?? null,
      notes: input.notes ?? null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async update(
    tenantId: string,
    itemId: string,
    input: Parameters<ItemRepository["update"]>[2],
  ) {
    const row = this.rows.get(itemId);
    if (!row || row.tenantId !== tenantId) return null;
    Object.assign(row, input);
    return { ...row };
  }

  async archive(tenantId: string, itemId: string) {
    const row = this.rows.get(itemId);
    if (!row || row.tenantId !== tenantId) return false;
    row.status = "INACTIVE";
    return true;
  }

  async restore(tenantId: string, itemId: string) {
    const row = this.rows.get(itemId);
    if (!row || row.tenantId !== tenantId) return false;
    row.status = "ACTIVE";
    return true;
  }
}

/**
 * The customer catalogue port. `upsert` is where the single-tenant rule lives:
 * it refuses a pair whose contact or item is not in the same tenant.
 */
class InMemoryContactItemRepository implements ContactItemRepository {
  private readonly rows = new Map<string, ContactItemRecord>();

  constructor(
    private readonly contacts: InMemoryContactRepository,
    private readonly items: InMemoryItemRepository,
  ) {}

  async findById(tenantId: string, contactItemId: string) {
    const row = this.rows.get(contactItemId);
    return row && row.tenantId === tenantId ? { ...row } : null;
  }

  async findForPair(tenantId: string, contactId: string, itemId: string) {
    for (const row of this.rows.values()) {
      if (
        row.tenantId === tenantId &&
        row.contactId === contactId &&
        row.itemId === itemId
      ) {
        return { ...row };
      }
    }
    return null;
  }

  async list(
    tenantId: string,
    query: Parameters<ContactItemRepository["list"]>[1],
  ): Promise<Page<ContactItemRecord>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const filtered = [...this.rows.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        (!query.contactId || row.contactId === query.contactId) &&
        (!query.itemId || row.itemId === query.itemId),
    );
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    };
  }

  async upsert(
    tenantId: string,
    input: Parameters<ContactItemRepository["upsert"]>[1],
  ) {
    const contact = await this.contacts.findById(tenantId, input.contactId);
    const item = await this.items.findById(tenantId, input.itemId);
    if (!contact || !item) {
      throw new Error("CROSS_TENANT_CATALOGUE_ASSIGNMENT");
    }

    const existing = await this.findForPair(
      tenantId,
      input.contactId,
      input.itemId,
    );
    const record: ContactItemRecord = {
      id: existing?.id ?? `contact-item-${this.rows.size + 1}`,
      tenantId,
      contactId: input.contactId,
      itemId: input.itemId,
      customCode: input.customCode ?? null,
      customName: input.customName ?? null,
      customUnitOfMeasure: input.customUnitOfMeasure ?? null,
      agreedPrice: input.agreedPrice,
      discountPercent: input.discountPercent,
      isAvailable: input.isAvailable ?? true,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      createdAt: existing?.createdAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.rows.set(record.id, record);
    return { ...record };
  }

  async remove(tenantId: string, contactItemId: string) {
    const row = this.rows.get(contactItemId);
    if (!row || row.tenantId !== tenantId) return false;
    return this.rows.delete(contactItemId);
  }
}

function makeContact(
  id: string,
  tenantId: string,
  overrides: Partial<ContactRecord> = {},
): ContactRecord {
  return {
    id,
    tenantId,
    type: "BUSINESS",
    status: "ACTIVE",
    firstName: null,
    lastName: null,
    companyName: "Acme Ltd",
    email: null,
    phone: null,
    mobile: null,
    taxPin: null,
    notes: "internal note",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    addresses: [],
    ...overrides,
  };
}

function makeItem(
  id: string,
  tenantId: string,
  overrides: Partial<ItemRecord> = {},
): ItemRecord {
  return {
    id,
    tenantId,
    type: "PRODUCT",
    status: "ACTIVE",
    name: "Widget",
    sku: "WDG-1",
    description: null,
    unitOfMeasure: "each",
    unitPrice: "100.00",
    currency: "KES",
    taxRateId: null,
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("repository ports can be implemented without Prisma", () => {
  it("enumerates the same statuses and types as the schema enums", () => {
    expect(CONTACT_TYPES).toEqual(["INDIVIDUAL", "BUSINESS"]);
    expect(ITEM_TYPES).toEqual(["PRODUCT", "SERVICE"]);
    expect(ITEM_STATUSES).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("keeps reads tenant-scoped", async () => {
    const repo = new InMemoryContactRepository([
      makeContact("c1", TENANT_ID),
      makeContact("c2", OTHER_TENANT_ID, { companyName: "Theirs" }),
    ]);

    expect(await repo.findById(TENANT_ID, "c1")).not.toBeNull();
    // The same id under a different tenant resolves to nothing.
    expect(await repo.findById(TENANT_ID, "c2")).toBeNull();

    const page = await repo.list(TENANT_ID, { pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe("c1");
  });

  it("supports search and pagination over the port", async () => {
    const repo = new InMemoryContactRepository([
      makeContact("c1", TENANT_ID, { companyName: "Acme Ltd" }),
      makeContact("c2", TENANT_ID, { companyName: "Beta Traders" }),
      makeContact("c3", TENANT_ID, { companyName: "Acme Holdings" }),
    ]);

    const search = await repo.list(TENANT_ID, {
      search: "acme",
      pageSize: 10,
    });
    expect(search.total).toBe(2);

    const paged = await repo.list(TENANT_ID, { page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(1);
    expect(paged.totalPages).toBe(2);
  });

  it("archives softly and restores", async () => {
    const repo = new InMemoryContactRepository([makeContact("c1", TENANT_ID)]);

    expect(await repo.archive(TENANT_ID, "c1")).toBe(true);
    const archived = await repo.findById(TENANT_ID, "c1");
    expect(archived?.status).toBe("ARCHIVED");
    expect(archived?.archivedAt).not.toBeNull();
    // Archiving twice is refused, not an error.
    expect(await repo.archive(TENANT_ID, "c1")).toBe(false);

    expect(await repo.restore(TENANT_ID, "c1")).toBe(true);
    expect((await repo.findById(TENANT_ID, "c1"))?.status).toBe("ACTIVE");
  });

  it("refuses a cross-tenant customer catalogue assignment", async () => {
    const contacts = new InMemoryContactRepository([
      makeContact("c1", TENANT_ID),
    ]);
    const items = new InMemoryItemRepository([makeItem("i1", TENANT_ID)]);
    const link = new InMemoryContactItemRepository(contacts, items);

    // Own tenant: allowed.
    const record = await link.upsert(TENANT_ID, {
      contactId: "c1",
      itemId: "i1",
      agreedPrice: "90.00",
      discountPercent: "0",
    });
    expect(record.tenantId).toBe(TENANT_ID);

    // A contact from another tenant cannot be linked, even with a known item.
    await expect(
      link.upsert(TENANT_ID, {
        contactId: "foreign-contact",
        itemId: "i1",
        agreedPrice: "1.00",
        discountPercent: "0",
      }),
    ).rejects.toThrow("CROSS_TENANT_CATALOGUE_ASSIGNMENT");
  });

  it("records internal notes on the contact record but they are never sent to a portal role", async () => {
    const repo = new InMemoryContactRepository([
      makeContact("c1", TENANT_ID, { notes: "Chases slow payers" }),
    ]);
    const contact = await repo.findById(TENANT_ID, "c1");
    expect(contact?.notes).toBe("Chases slow payers");
    // The portal role has no contacts.read, so this record is unreachable to it.
    expect(
      tenantRoleHasPermission(
        "CUSTOMER_PORTAL_USER",
        PERMISSIONS.CONTACTS_READ,
      ),
    ).toBe(false);
  });
});
