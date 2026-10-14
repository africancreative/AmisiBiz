import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import type { TenantRole } from "@prisma/client";

/**
 * Phase 04 security tests — tenant branding, contacts CRM and the catalogue.
 *
 * Rule 10 of the project constitution requires automated coverage for every
 * security-sensitive feature, with explicit attention to cross-tenant access
 * attempts and privilege escalation. These suites call the real Server Actions
 * and validation schemas against a mocked Prisma client, and assert on the
 * arguments handed to Prisma — because those arguments are the production query.
 *
 * `scopedById()` simulates a tenant-scoped table: a row is returned only when the
 * query filters on that row's own tenant (and its id/sku/email when supplied).
 * If an action ever dropped its tenant predicate, a foreign row would come back
 * and the affected test would fail.
 *
 * `asRole()` installs a membership keyed on (tenantId, userId), so requesting a
 * tenant the user does not belong to resolves to no membership — exactly the
 * behaviour `resolveTenantContext` depends on.
 */

vi.mock("@/lib/db/prisma", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));

import { prismaMock } from "./prisma-mock";
import { authMock } from "./auth-mock";
import { PERMISSIONS, TENANT_ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { AUDIT_ACTIONS } from "@/lib/audit";
import {
  createContactAction,
  updateContactAction,
  archiveContactAction,
  restoreContactAction,
  getContactsAction,
  getContactAction,
  getContactBalanceAction,
} from "@/server/actions/contact";
import {
  createItemAction,
  updateItemAction,
  deleteItemAction,
  getItemsAction,
  createTaxCategoryAction,
} from "@/server/actions/item";
import {
  createContactItemAction,
  updateContactItemAction,
  deleteContactItemAction,
  getAvailableItemsForContactAction,
} from "@/server/actions/contact-item";
import {
  updateTenantBrandingAction,
  getTenantBrandingAction,
  deleteLogoAction,
} from "@/server/actions/branding";
import { getDocumentsAction } from "@/server/actions/document";
import {
  createContactSchema,
  updateContactSchema,
} from "@/lib/validations/contact";
import {
  createItemSchema,
  itemQuerySchema,
  createTaxCategorySchema,
} from "@/lib/validations/item";
import { createContactItemSchema } from "@/lib/validations/contact-item";
import {
  updateTenantBrandingSchema,
  brandingFieldsSchema,
} from "@/lib/validations/branding";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "ckuser00000000000000001";
const TENANT_ID = "cktenant0000000000000001";
const OTHER_TENANT_ID = "cktenant0000000000000002";

const CONTACT_ID = "ckcontact000000000000001";
const OTHER_CONTACT_ID = "ckcontact000000000000002";
const ITEM_ID = "ckitem000000000000000001";
const OTHER_ITEM_ID = "ckitem000000000000000002";
const TAX_RATE_ID = "cktaxrate0000000000001";
const OTHER_TAX_RATE_ID = "cktaxrate0000000000002";
const TAX_CATEGORY_ID = "cktaxcat0000000000001";
const CONTACT_ITEM_ID = "ckcitem0000000000000001";
const BRANDING_ID = "ckbranding000000000001";

type ScopedRow = { id: string; tenantId: string; [key: string]: unknown };

const ownContact: ScopedRow = {
  id: CONTACT_ID,
  tenantId: TENANT_ID,
  email: "jane@example.com",
  status: "ACTIVE",
  firstName: "Jane",
  lastName: "Wanjiru",
};

const foreignContact: ScopedRow = {
  id: OTHER_CONTACT_ID,
  tenantId: OTHER_TENANT_ID,
  email: "other@somewhere-else.co.ke",
  status: "ACTIVE",
  companyName: "Somewhere Else Ltd",
};

const ownItem: ScopedRow = {
  id: ITEM_ID,
  tenantId: TENANT_ID,
  name: "Cargo service",
  sku: "SRV-1",
  status: "ACTIVE",
};

const foreignItem: ScopedRow = {
  id: OTHER_ITEM_ID,
  tenantId: OTHER_TENANT_ID,
  name: "Their item",
  sku: "THEIR-1",
  status: "ACTIVE",
};

const ownTaxRate: ScopedRow = {
  id: TAX_RATE_ID,
  tenantId: TENANT_ID,
  rate: new Prisma.Decimal("0.16"),
};

const foreignTaxRate: ScopedRow = {
  id: OTHER_TAX_RATE_ID,
  tenantId: OTHER_TENANT_ID,
  rate: new Prisma.Decimal("0.16"),
};

const ownContactItem: ScopedRow = {
  id: CONTACT_ITEM_ID,
  tenantId: TENANT_ID,
  contactId: CONTACT_ID,
  itemId: ITEM_ID,
};

/** A `findFirst` that only answers a query scoped to the row's own tenant. */
function scopedById(rows: ScopedRow[]) {
  return async (args: unknown) => {
    const where =
      (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    const id = typeof where.id === "string" ? where.id : undefined;
    const tenantId =
      typeof where.tenantId === "string" ? where.tenantId : undefined;
    const sku = typeof where.sku === "string" ? where.sku : undefined;
    const email =
      typeof where.email === "string" ? where.email.toLowerCase() : undefined;

    return (
      rows.find(
        (row) =>
          (id === undefined || row.id === id) &&
          (tenantId === undefined || row.tenantId === tenantId) &&
          (sku === undefined || row.sku === sku) &&
          (email === undefined ||
            String(row.email ?? "").toLowerCase() === email),
      ) ?? null
    );
  };
}

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

/** Loosely re-typed action result: the union makes `.data`/`.code` narrow-only. */
type Loose = {
  success: boolean;
  data?: Record<string, unknown>;
  code?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

function loose(result: unknown): Loose {
  return result as Loose;
}

/** Reads the audit rows written for one action name. */
function auditFor(action: string) {
  return prismaMock.auditLog.create.mock.calls
    .map((call) => (call[0] as { data: Record<string, unknown> }).data)
    .filter((data) => data.action === action);
}

/** First argument of a Prisma delegate call, as a plain object. */
function callArg(mock: unknown, index = 0): Record<string, unknown> {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[index]?.[0] ?? {}) as Record<string, unknown>;
}

/** Neutral, per-delegate starting values so no implementation leaks between tests. */
function neutralValue(name: string): unknown {
  switch (name) {
    case "findMany":
      return [];
    case "count":
      return 0;
    case "aggregate":
      return { _sum: { total: null } };
    case "updateMany":
    case "createMany":
    case "deleteMany":
      return { count: 1 };
    case "create":
    case "update":
    case "upsert":
      return { id: "ckgenerated0000000001" };
    default:
      return null;
  }
}

/**
 * `clearAllMocks()` keeps implementations, so every Phase 04 delegate is pushed
 * back to a neutral return value before each test. Delegates without a
 * `mockResolvedValue` (there shouldn't be any) are skipped.
 */
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
  // Actions log authorization denials server-side; the tests assert on the
  // returned ActionResult, so the runner output stays readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  authMock.mockResolvedValue({
    id: USER_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: "USER",
    status: "ACTIVE",
  });

  prismaMock.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(prismaMock)
      : await Promise.all(arg as Promise<unknown>[]),
  );
  prismaMock.auditLog.create.mockResolvedValue({ id: "log_1" });

  // Every Phase 04 delegate returns to a neutral state before each test runs.
  for (const delegate of [
    prismaMock.contact,
    prismaMock.item,
    prismaMock.taxRate,
    prismaMock.taxCategory,
    prismaMock.contactItem,
    prismaMock.contactAddress,
    prismaMock.document,
    prismaMock.tenantBranding,
    prismaMock.tenantMember,
    prismaMock.tenant,
    prismaMock.user,
  ]) {
    resetDelegate(delegate);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Cross-tenant reads ───────────────────────────────────────────────────────

describe("Phase 04 cross-tenant read isolation", () => {
  it("denies a contact read against a tenant the user does not belong to", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(
      await getContactAction(OTHER_CONTACT_ID, OTHER_TENANT_ID),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    // Authorization runs before any query, so nothing is read at all.
    expect(prismaMock.contact.findFirst).not.toHaveBeenCalled();
    expect(auditFor(AUDIT_ACTIONS.AUTHZ_DENIED)).toHaveLength(1);
  });

  it("reads a foreign contact id inside an authorized tenant as not-found", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact, foreignContact]),
    );

    const result = loose(await getContactAction(OTHER_CONTACT_ID, TENANT_ID));

    expect(result.success).toBe(true);
    expect(result.data?.contact).toBeNull();
    expect(callArg(prismaMock.contact.findFirst).where).toMatchObject({
      id: OTHER_CONTACT_ID,
      tenantId: TENANT_ID,
    });
  });

  it("returns the contact when id and tenant both match", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact, foreignContact]),
    );

    const result = loose(await getContactAction(CONTACT_ID, TENANT_ID));

    expect(result.success).toBe(true);
    const contact = result.data?.contact as { id: string } | null;
    expect(contact?.id).toBe(CONTACT_ID);
  });

  it("scopes the contact list and its count to the authorized tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findMany.mockResolvedValue([ownContact]);
    prismaMock.contact.count.mockResolvedValue(1);

    const result = loose(await getContactsAction({ tenantId: TENANT_ID }));

    expect(result.success).toBe(true);
    const where = callArg(prismaMock.contact.findMany).where as Record<
      string,
      unknown
    >;
    expect(where.tenantId).toBe(TENANT_ID);
    expect(where).not.toHaveProperty("tenantId_ne");
    expect(
      (callArg(prismaMock.contact.count, 0).where as Record<string, unknown>)
        .tenantId,
    ).toBe(TENANT_ID);
  });

  it("refuses to list another tenant's items", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(await getItemsAction({ tenantId: OTHER_TENANT_ID }));

    expect(result.success).toBe(false);
    expect(prismaMock.item.findMany).not.toHaveBeenCalled();
  });

  it("refuses to list another tenant's documents", async () => {
    asRole("DOCUMENT_MANAGER");

    const result = loose(
      await getDocumentsAction({ tenantId: OTHER_TENANT_ID }),
    );

    expect(result.success).toBe(false);
    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
  });

  it("reads branding only through the authorized tenant key", async () => {
    asRole("BUSINESS_ADMIN");
    prismaMock.tenantBranding.findUnique.mockResolvedValue({
      id: BRANDING_ID,
      tenantId: TENANT_ID,
      currency: "KES",
    });

    const result = loose(await getTenantBrandingAction(TENANT_ID));

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.tenantBranding.findUnique).where).toEqual({
      tenantId: TENANT_ID,
    });
  });

  it("rejects a malformed tenant id before touching the database", async () => {
    asRole("BUSINESS_ADMIN");

    const result = loose(await getTenantBrandingAction("not-a-valid-id"));

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.tenantBranding.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an outstanding balance for a contact in another tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact, foreignContact]),
    );

    const result = loose(
      await getContactBalanceAction(OTHER_CONTACT_ID, TENANT_ID),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(prismaMock.document.aggregate).not.toHaveBeenCalled();
  });

  it("returns the outstanding balance as a decimal string, never a number", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(scopedById([ownContact]));
    prismaMock.document.aggregate.mockResolvedValue({
      _sum: { total: new Prisma.Decimal("12345.6700") },
    });
    prismaMock.document.count.mockResolvedValue(3);
    prismaMock.tenantBranding.findUnique.mockResolvedValue({ currency: "KES" });

    const result = loose(await getContactBalanceAction(CONTACT_ID, TENANT_ID));

    expect(result.success).toBe(true);
    expect(typeof result.data?.outstanding).toBe("string");
    expect(result.data?.outstanding).toBe("12345.67");
    expect(result.data?.currency).toBe("KES");
    expect(result.data?.documentCount).toBe(3);
    // Only unsettled document statuses count towards the balance.
    const where = callArg(prismaMock.document.aggregate).where as Record<
      string,
      unknown
    >;
    expect(where.status).toEqual({
      in: ["ISSUED", "OVERDUE", "PARTIALLY_PAID"],
    });
    expect(where.tenantId).toBe(TENANT_ID);
  });
});

// ─── Contacts: writes, mass assignment, soft delete ──────────────────────────

describe("Phase 04 contact writes", () => {
  it("creates a contact under the authorized tenant only", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.create.mockResolvedValue({
      id: CONTACT_ID,
      type: "INDIVIDUAL",
    });

    const result = loose(
      await createContactAction({
        tenantId: TENANT_ID,
        type: "INDIVIDUAL",
        firstName: "  Jane  ",
        email: "JANE@Example.com",
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(prismaMock.contact.create).data as Record<
      string,
      unknown
    >;
    expect(data.tenantId).toBe(TENANT_ID);
    expect(data.firstName).toBe("Jane");
    expect(data.email).toBe("jane@example.com");
  });

  it("strips non-writable fields from a create payload (mass assignment)", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.create.mockResolvedValue({
      id: CONTACT_ID,
      type: "INDIVIDUAL",
    });

    await createContactAction({
      tenantId: TENANT_ID,
      firstName: "Jane",
      // An id, a status bypass and fields from other tables: none may persist.
      id: CONTACT_ID,
      status: "ARCHIVED",
      archivedAt: "2026-01-01T00:00:00.000Z",
      role: "BUSINESS_OWNER",
      sessionVersion: 99,
      platformRole: "PLATFORM_ADMIN",
    });

    const data = callArg(prismaMock.contact.create).data as Record<
      string,
      unknown
    >;
    for (const forbidden of [
      "id",
      "status",
      "archivedAt",
      "role",
      "sessionVersion",
      "platformRole",
    ]) {
      expect(data).not.toHaveProperty(forbidden);
    }
    expect(data.tenantId).toBe(TENANT_ID);
  });

  it("never writes contact PII into the audit log", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.create.mockResolvedValue({
      id: CONTACT_ID,
      type: "BUSINESS",
    });

    await createContactAction({
      tenantId: TENANT_ID,
      type: "BUSINESS",
      companyName: "Acme Ltd",
      email: "accounts@acme.co.ke",
      phone: "+254700000000",
      taxPin: "P00000000000",
      notes: "Credit terms 30 days",
    });

    const metadata = auditFor(AUDIT_ACTIONS.CONTACT_CREATED)[0]?.metadata ?? {};
    expect(Object.keys(metadata)).toEqual(["type"]);
    const serialized = JSON.stringify(metadata).toLowerCase();
    for (const leak of [
      "accounts@acme",
      "+254700000000",
      "p00000000000",
      "credit terms",
      "acme ltd",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("rejects an individual contact with no name at all", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(await createContactAction({ tenantId: TENANT_ID }));

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });

  it("rejects a business contact without a company name", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(
      await createContactAction({
        tenantId: TENANT_ID,
        type: "BUSINESS",
        firstName: "Jane",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });

  it("treats a duplicate email inside the tenant as a conflict, not an overwrite", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(scopedById([ownContact]));

    const result = loose(
      await createContactAction({
        tenantId: TENANT_ID,
        firstName: "Copycat",
        email: "jane@example.com",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });

  it("updates a contact with a tenant-pinned where clause and no status field", async () => {
    asRole("BUSINESS_ADMIN");
    prismaMock.contact.findFirst.mockImplementation(scopedById([ownContact]));

    const result = loose(
      await updateContactAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        phone: "+254711000111",
        // Mass-assignment attempts.
        status: "ARCHIVED",
        targetTenantId: OTHER_TENANT_ID,
        id: OTHER_CONTACT_ID,
        sessionVersion: 4,
      }),
    );

    expect(result.success).toBe(true);
    const call = callArg(prismaMock.contact.updateMany);
    expect(call.where).toEqual({ id: CONTACT_ID, tenantId: TENANT_ID });
    const data = call.data as Record<string, unknown>;
    expect(data.phone).toBe("+254711000111");
    for (const forbidden of [
      "status",
      "id",
      "tenantId",
      "targetTenantId",
      "sessionVersion",
    ]) {
      expect(data).not.toHaveProperty(forbidden);
    }
  });

  it("refuses to update a contact that lives in another tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact, foreignContact]),
    );

    const result = loose(
      await updateContactAction({
        tenantId: TENANT_ID,
        contactId: OTHER_CONTACT_ID,
        phone: "+254700000000",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("archives as a soft delete and never removes the row or its documents", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(scopedById([ownContact]));
    prismaMock.document.count.mockResolvedValue(2);

    const result = loose(
      await archiveContactAction({
        contactId: CONTACT_ID,
        tenantId: TENANT_ID,
      }),
    );

    expect(result.success).toBe(true);
    const call = callArg(prismaMock.contact.updateMany);
    expect(call.where).toEqual({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      status: "ACTIVE",
    });
    expect(call.data).toMatchObject({ status: "ARCHIVED" });
    // Historical records must survive: there is no hard-delete path for a
    // contact, its addresses or its documents.
    expect(prismaMock.contact.delete).not.toHaveBeenCalled();
    expect(prismaMock.contactAddress.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.document.delete).not.toHaveBeenCalled();
    expect(prismaMock.document.deleteMany).not.toHaveBeenCalled();
    // How many documents still depend on the contact is audited, without PII.
    expect(auditFor(AUDIT_ACTIONS.CONTACT_ARCHIVED)[0]?.metadata).toEqual({
      linkedDocuments: 2,
    });
  });

  it("refuses to archive a contact in another tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact, foreignContact]),
    );

    const result = loose(
      await archiveContactAction({
        contactId: OTHER_CONTACT_ID,
        tenantId: TENANT_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("restores only the status of an archived contact", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      email: null,
      status: "ARCHIVED",
    });

    const result = loose(
      await restoreContactAction({
        contactId: CONTACT_ID,
        tenantId: TENANT_ID,
        // The caller does not get to name the field it wants flipped.
        status: "ACTIVE",
      }),
    );

    expect(result.success).toBe(true);
    const call = callArg(prismaMock.contact.updateMany);
    expect(call.where).toEqual({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      status: "ARCHIVED",
    });
    expect(Object.keys(call.data as Record<string, unknown>).sort()).toEqual([
      "archivedAt",
      "status",
    ]);
  });
});

// ─── RBAC: privilege escalation on contacts ──────────────────────────────────

describe("Phase 04 contact RBAC", () => {
  const contactWrites: ReadonlyArray<
    readonly [string, () => Promise<unknown>]
  > = [
    [
      "createContactAction",
      () => createContactAction({ tenantId: TENANT_ID, firstName: "Jane" }),
    ],
    [
      "updateContactAction",
      () =>
        updateContactAction({
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          phone: "+254700000000",
        }),
    ],
    [
      "archiveContactAction",
      () =>
        archiveContactAction({ contactId: CONTACT_ID, tenantId: TENANT_ID }),
    ],
    [
      "restoreContactAction",
      () =>
        restoreContactAction({ contactId: CONTACT_ID, tenantId: TENANT_ID }),
    ],
  ];

  it("lets a VIEWER read but never write contacts", async () => {
    asRole("VIEWER");
    const failures: string[] = [];
    for (const [label, run] of contactWrites) {
      const result = loose(await run());
      if (result.success || result.code !== "FORBIDDEN") {
        failures.push(
          `${label}: success=${result.success} code=${result.code}`,
        );
      }
    }
    expect(failures).toEqual([]);
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("records an authorization denial for every refused write", async () => {
    asRole("VIEWER");
    for (const [, run] of contactWrites) await run();
    expect(auditFor(AUDIT_ACTIONS.AUTHZ_DENIED)).toHaveLength(
      contactWrites.length,
    );
  });

  it("lets SALES_STAFF manage contacts but never archive one", async () => {
    asRole("SALES_STAFF");
    prismaMock.contact.findFirst.mockImplementation(scopedById([ownContact]));

    const created = loose(
      await createContactAction({ tenantId: TENANT_ID, firstName: "Jane" }),
    );
    expect(created.success).toBe(true);

    const archived = loose(
      await archiveContactAction({
        contactId: CONTACT_ID,
        tenantId: TENANT_ID,
      }),
    );
    expect(archived.success).toBe(false);
    expect(archived.code).toBe("FORBIDDEN");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("keeps document-only roles out of the contact writer", async () => {
    asRole("DOCUMENT_MANAGER");

    const result = loose(
      await createContactAction({ tenantId: TENANT_ID, firstName: "Jane" }),
    );

    expect(result.success).toBe(false);
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });

  it("blocks every contact write when the tenant is not operational", async () => {
    for (const status of ["SUSPENDED", "PENDING"] as const) {
      asRole("BUSINESS_OWNER", status);
      const result = loose(
        await createContactAction({ tenantId: TENANT_ID, firstName: "Jane" }),
      );
      expect(result.success).toBe(false);
      expect(result.code).toBe("FORBIDDEN");
    }
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });

  it("matches the documented permission matrix for contacts", () => {
    expect(
      TENANT_ROLE_PERMISSIONS.SALES_STAFF.includes(PERMISSIONS.CONTACTS_CREATE),
    ).toBe(true);
    expect(
      TENANT_ROLE_PERMISSIONS.SALES_STAFF.includes(PERMISSIONS.CONTACTS_DELETE),
    ).toBe(false);
    expect(
      TENANT_ROLE_PERMISSIONS.VIEWER.includes(PERMISSIONS.CONTACTS_READ),
    ).toBe(true);
    expect(
      TENANT_ROLE_PERMISSIONS.VIEWER.includes(PERMISSIONS.CONTACTS_UPDATE),
    ).toBe(false);
  });
});

// ─── Catalogue: items, prices, tax ───────────────────────────────────────────

describe("Phase 04 catalogue writes", () => {
  const taxRateInput = (rate: string) => ({
    tenantId: TENANT_ID,
    name: "VAT",
    isDefault: false,
    rates: [
      { categoryId: TAX_CATEGORY_ID, name: "VAT 16%", rate, isActive: true },
    ],
  });

  it("stores a unit price as an exact decimal, not a binary float", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.item.create.mockResolvedValue({
      id: ITEM_ID,
      name: "Consulting",
      type: "SERVICE",
      sku: "SRV-1",
    });

    const result = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        type: "SERVICE",
        status: "ACTIVE",
        name: "Consulting",
        sku: "SRV-1",
        unitOfMeasure: "hour",
        unitPrice: "0.1",
        currency: "KES",
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(prismaMock.item.create).data as Record<
      string,
      unknown
    >;
    expect(data.unitPrice).toBeInstanceOf(Prisma.Decimal);
    expect((data.unitPrice as Prisma.Decimal).toString()).toBe("0.1");
    // 0.1 + 0.2 is 0.30000000000000004 as a JS number; as a Decimal it is exact.
    expect(
      new Prisma.Decimal("0.1").add(new Prisma.Decimal("0.2")).toString(),
    ).toBe("0.3");
  });

  it("rejects prices that are not exact decimal strings", () => {
    const base = { tenantId: TENANT_ID, name: "Widget", unitOfMeasure: "each" };
    for (const unitPrice of [
      "-100",
      "1.23456",
      "1,200.00",
      "1e3",
      "abc",
      "",
      "0.1.2",
      "  12  ",
    ]) {
      expect(
        createItemSchema.safeParse({ ...base, unitPrice }).success,
        `unitPrice ${JSON.stringify(unitPrice)}`,
      ).toBe(false);
    }
    for (const unitPrice of ["0", "0.00", "199999.9999", "1250"]) {
      expect(createItemSchema.safeParse({ ...base, unitPrice }).success).toBe(
        true,
      );
    }
  });

  it("refuses a tax rate that belongs to another tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.taxRate.findFirst.mockImplementation(
      scopedById([ownTaxRate, foreignTaxRate]),
    );

    const result = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Widget",
        unitOfMeasure: "each",
        unitPrice: "100",
        taxRateId: OTHER_TAX_RATE_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.taxRateId).toBeDefined();
    expect(prismaMock.item.create).not.toHaveBeenCalled();
  });

  it("accepts a tax rate from the authorized tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.taxRate.findFirst.mockImplementation(scopedById([ownTaxRate]));
    prismaMock.item.create.mockResolvedValue({
      id: ITEM_ID,
      name: "Widget",
      type: "PRODUCT",
      sku: null,
    });

    const result = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Widget",
        unitOfMeasure: "each",
        unitPrice: "100",
        taxRateId: TAX_RATE_ID,
      }),
    );

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.item.create).data).toMatchObject({
      tenantId: TENANT_ID,
      taxRateId: TAX_RATE_ID,
    });
  });

  it("enforces SKU uniqueness only within the tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.item.findFirst.mockImplementation(scopedById([ownItem]));

    const duplicate = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Another",
        sku: "SRV-1",
        unitOfMeasure: "each",
        unitPrice: "10",
      }),
    );
    expect(duplicate.code).toBe("CONFLICT");
    expect(prismaMock.item.create).not.toHaveBeenCalled();

    // The same SKU held by another business is not visible to a tenant-scoped
    // lookup, so it is not reported as a conflict either.
    prismaMock.item.findFirst.mockResolvedValue(null);
    const unique = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Another",
        sku: "THEIR-1",
        unitOfMeasure: "each",
        unitPrice: "10",
      }),
    );
    expect(unique.success).toBe(true);
  });

  it("rejects a whitespace-only SKU instead of storing an empty code", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Widget",
        sku: "   ",
        unitOfMeasure: "each",
        unitPrice: "10",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.item.create).not.toHaveBeenCalled();
  });

  it("rejects a unit of measure outside the controlled list", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Widget",
        unitOfMeasure: "bogus-unit",
        unitPrice: "10",
      }),
    );

    expect(result.success).toBe(false);
    expect(prismaMock.item.create).not.toHaveBeenCalled();
  });

  it("rejects an unsupported currency on an item", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Widget",
        unitOfMeasure: "each",
        unitPrice: "10",
        currency: "UGX",
      }),
    );

    expect(result.success).toBe(false);
    expect(prismaMock.item.create).not.toHaveBeenCalled();
  });

  it("updates an item only within the authorized tenant and strips foreign keys", async () => {
    asRole("BUSINESS_ADMIN");
    prismaMock.item.findFirst.mockImplementation(scopedById([ownItem]));

    const result = loose(
      await updateItemAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        unitPrice: "123.4500",
        // Not writable through an item update:
        contactId: OTHER_CONTACT_ID,
        targetTenantId: OTHER_TENANT_ID,
        id: OTHER_ITEM_ID,
      }),
    );

    expect(result.success).toBe(true);
    const call = callArg(prismaMock.item.updateMany);
    expect(call.where).toEqual({ id: ITEM_ID, tenantId: TENANT_ID });
    const data = call.data as Record<string, unknown>;
    expect((data.unitPrice as Prisma.Decimal).toString()).toBe("123.45");
    expect(data).not.toHaveProperty("contactId");
    expect(data).not.toHaveProperty("tenantId");
    expect(data).not.toHaveProperty("targetTenantId");
    expect(data).not.toHaveProperty("id");
  });

  it("refuses to update an item belonging to another tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.item.findFirst.mockImplementation(
      scopedById([ownItem, foreignItem]),
    );

    const result = loose(
      await updateItemAction({
        tenantId: TENANT_ID,
        itemId: OTHER_ITEM_ID,
        unitPrice: "1",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(prismaMock.item.updateMany).not.toHaveBeenCalled();
  });

  it("disconnects a tax rate only through the relation form", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.item.findFirst.mockImplementation(scopedById([ownItem]));

    const result = loose(
      await updateItemAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        taxRateId: null,
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(prismaMock.item.updateMany).data as Record<
      string,
      unknown
    >;
    expect(data.taxRate).toEqual({ disconnect: true });
    expect(data).not.toHaveProperty("taxRateId");
  });

  it("keeps an item that a customer catalogue references out of deletion", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.item.findFirst.mockImplementation(scopedById([ownItem]));
    prismaMock.contactItem.findFirst.mockImplementation(
      scopedById([ownContactItem]),
    );

    const result = loose(await deleteItemAction(ITEM_ID, TENANT_ID));

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(prismaMock.item.delete).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced item by id after scoping the lookup", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.item.findFirst.mockImplementation(scopedById([ownItem]));

    const result = loose(await deleteItemAction(ITEM_ID, TENANT_ID));

    expect(result.success).toBe(true);
    expect(prismaMock.item.delete).toHaveBeenCalledWith({
      where: { id: ITEM_ID },
    });
  });

  it("refuses to delete another tenant's item", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.item.findFirst.mockImplementation(
      scopedById([ownItem, foreignItem]),
    );

    const result = loose(await deleteItemAction(OTHER_ITEM_ID, TENANT_ID));

    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(prismaMock.item.delete).not.toHaveBeenCalled();
  });

  it("denies item writes to a VIEWER and item deletion to SALES_STAFF", async () => {
    asRole("VIEWER");
    const created = loose(
      await createItemAction({
        tenantId: TENANT_ID,
        name: "Widget",
        unitOfMeasure: "each",
        unitPrice: "1",
      }),
    );
    expect(created.success).toBe(false);
    expect(loose(await deleteItemAction(ITEM_ID, TENANT_ID)).success).toBe(
      false,
    );
    expect(prismaMock.item.create).not.toHaveBeenCalled();
    expect(prismaMock.item.delete).not.toHaveBeenCalled();

    asRole("SALES_STAFF");
    expect(loose(await deleteItemAction(ITEM_ID, TENANT_ID)).success).toBe(
      false,
    );
    expect(prismaMock.item.delete).not.toHaveBeenCalled();
  });

  it("stores a tax rate as a 0–1 fraction and rejects overflow", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.taxCategory.create.mockResolvedValue({
      id: TAX_CATEGORY_ID,
      name: "VAT",
    });

    const result = loose(await createTaxCategoryAction(taxRateInput("0.16")));

    expect(result.success).toBe(true);
    const rates = callArg(prismaMock.taxRate.createMany).data as {
      rate: Prisma.Decimal;
      tenantId: string;
      categoryId: string;
    }[];
    expect(rates[0]?.rate).toBeInstanceOf(Prisma.Decimal);
    expect(rates[0]?.rate.toString()).toBe("0.16");
    expect(rates[0]?.tenantId).toBe(TENANT_ID);
    expect(rates[0]?.categoryId).toBe(TAX_CATEGORY_ID);

    for (const rate of ["16", "1.0001", "-0.1", "0.16001", "16%"]) {
      expect(
        createTaxCategorySchema.safeParse(taxRateInput(rate)).success,
        `rate ${rate}`,
      ).toBe(false);
    }

    const overflow = loose(await createTaxCategoryAction(taxRateInput("16")));
    expect(overflow.success).toBe(false);
    expect(overflow.code).toBe("VALIDATION_ERROR");
  });

  it("clears the previous default tax category inside the same tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.taxCategory.create.mockResolvedValue({
      id: TAX_CATEGORY_ID,
      name: "VAT",
    });

    const result = loose(
      await createTaxCategoryAction({
        tenantId: TENANT_ID,
        name: "VAT",
        isDefault: true,
        rates: [
          {
            categoryId: TAX_CATEGORY_ID,
            name: "VAT 16%",
            rate: "0.16",
            isActive: true,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    // The demotion is tenant-scoped: another business's default is untouched.
    expect(callArg(prismaMock.taxCategory.updateMany, 0).where).toMatchObject({
      tenantId: TENANT_ID,
      id: { not: TAX_CATEGORY_ID },
      isDefault: true,
    });
  });
});

// ─── Customer-specific catalogue ─────────────────────────────────────────────

describe("Phase 04 customer-specific catalogue", () => {
  it("assigns an agreed price without touching the default catalogue price", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(scopedById([ownContact]));
    prismaMock.item.findFirst.mockImplementation(scopedById([ownItem]));
    prismaMock.contactItem.create.mockResolvedValue({ id: CONTACT_ITEM_ID });

    const result = loose(
      await createContactItemAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        itemId: ITEM_ID,
        agreedPrice: "80.00",
        discountPercent: "10",
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(prismaMock.contactItem.create).data as Record<
      string,
      unknown
    >;
    expect(data.tenantId).toBe(TENANT_ID);
    expect((data.agreedPrice as Prisma.Decimal).toString()).toBe("80");
    expect((data.discountPercent as Prisma.Decimal).toString()).toBe("10");
    // The brief's central guarantee: a customer price never rewrites the default.
    expect(prismaMock.item.update).not.toHaveBeenCalled();
    expect(prismaMock.item.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.item.create).not.toHaveBeenCalled();
  });

  it("refuses a contact or item from another tenant", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact, foreignContact]),
    );
    prismaMock.item.findFirst.mockImplementation(
      scopedById([ownItem, foreignItem]),
    );

    const crossContact = loose(
      await createContactItemAction({
        tenantId: TENANT_ID,
        contactId: OTHER_CONTACT_ID,
        itemId: ITEM_ID,
        agreedPrice: "80",
      }),
    );
    expect(crossContact.success).toBe(false);
    expect(crossContact.code).toBe("NOT_FOUND");

    const crossItem = loose(
      await createContactItemAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        itemId: OTHER_ITEM_ID,
        agreedPrice: "80",
      }),
    );
    expect(crossItem.success).toBe(false);
    expect(crossItem.code).toBe("NOT_FOUND");

    expect(prismaMock.contactItem.create).not.toHaveBeenCalled();
  });

  it("refuses archived contacts and inactive items", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      status: "ARCHIVED",
    });
    prismaMock.item.findFirst.mockImplementation(scopedById([ownItem]));

    const archived = loose(
      await createContactItemAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        itemId: ITEM_ID,
        agreedPrice: "80",
      }),
    );
    expect(archived.success).toBe(false);
    expect(archived.code).toBe("CONFLICT");

    prismaMock.contact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      status: "ACTIVE",
    });
    prismaMock.item.findFirst.mockResolvedValue({
      id: ITEM_ID,
      tenantId: TENANT_ID,
      status: "INACTIVE",
    });
    const inactive = loose(
      await createContactItemAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        itemId: ITEM_ID,
        agreedPrice: "80",
      }),
    );
    expect(inactive.success).toBe(false);
    expect(inactive.code).toBe("CONFLICT");
    expect(prismaMock.contactItem.create).not.toHaveBeenCalled();
  });

  it("never lets an update re-point the assignment at another contact or item", async () => {
    asRole("BUSINESS_ADMIN");
    prismaMock.contactItem.findFirst.mockImplementation(
      scopedById([ownContactItem]),
    );

    const result = loose(
      await updateContactItemAction({
        tenantId: TENANT_ID,
        contactItemId: CONTACT_ITEM_ID,
        agreedPrice: "75.50",
        contactId: OTHER_CONTACT_ID,
        itemId: OTHER_ITEM_ID,
        isAvailable: false,
      }),
    );

    expect(result.success).toBe(true);
    const call = callArg(prismaMock.contactItem.updateMany);
    expect(call.where).toEqual({ id: CONTACT_ITEM_ID, tenantId: TENANT_ID });
    expect(Object.keys(call.data as Record<string, unknown>).sort()).toEqual([
      "agreedPrice",
      "isAvailable",
    ]);
    expect(prismaMock.item.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to update an assignment for a tenant the actor does not belong to", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contactItem.findFirst.mockImplementation(
      scopedById([ownContactItem]),
    );

    const result = loose(
      await updateContactItemAction({
        tenantId: OTHER_TENANT_ID,
        contactItemId: CONTACT_ITEM_ID,
        agreedPrice: "1",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.contactItem.updateMany).not.toHaveBeenCalled();
  });

  it("removes an agreement without deleting the contact or the item", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contactItem.findFirst.mockImplementation(
      scopedById([ownContactItem]),
    );

    const result = loose(
      await deleteContactItemAction({
        contactItemId: CONTACT_ITEM_ID,
        tenantId: TENANT_ID,
      }),
    );

    expect(result.success).toBe(true);
    expect(prismaMock.contactItem.delete).toHaveBeenCalledWith({
      where: { id: CONTACT_ITEM_ID },
    });
    expect(prismaMock.contact.delete).not.toHaveBeenCalled();
    expect(prismaMock.item.delete).not.toHaveBeenCalled();
  });

  it("rejects a percentage outside 0–100", () => {
    const base = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      itemId: ITEM_ID,
      agreedPrice: "80",
    };
    expect(
      createContactItemSchema.safeParse({ ...base, discountPercent: "100.01" })
        .success,
    ).toBe(false);
    expect(
      createContactItemSchema.safeParse({ ...base, discountPercent: "-1" })
        .success,
    ).toBe(false);
    expect(
      createContactItemSchema.safeParse({ ...base, discountPercent: "100" })
        .success,
    ).toBe(true);
  });

  it("does not offer the assignment picker for an archived contact", async () => {
    asRole("BUSINESS_OWNER");
    prismaMock.contact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      status: "ARCHIVED",
    });

    const result = loose(
      await getAvailableItemsForContactAction(CONTACT_ID, TENANT_ID),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(prismaMock.item.findMany).not.toHaveBeenCalled();
  });

  it("denies catalogue writes to a VIEWER", async () => {
    asRole("VIEWER");

    const assign = loose(
      await createContactItemAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        itemId: ITEM_ID,
        agreedPrice: "80",
      }),
    );

    expect(assign.success).toBe(false);
    expect(assign.code).toBe("FORBIDDEN");
    expect(prismaMock.contactItem.create).not.toHaveBeenCalled();
    // Denied before the customer/item existence probes even run.
    expect(prismaMock.contact.findFirst).not.toHaveBeenCalled();
  });
});

// ─── Branding ─────────────────────────────────────────────────────────────────

describe("Phase 04 branding validation and isolation", () => {
  it("rejects a colour that is not a bare hex value (CSS injection)", async () => {
    asRole("BUSINESS_ADMIN");
    const failures: string[] = [];
    for (const primaryColor of [
      "red",
      "#1d4",
      "#1d4ed8; } body { display:none",
      "javascript:alert(1)",
      "#1d4ed8 onload=alert(1)",
      "url(http://evil.test/x.png)",
      "<style>body{display:none}</style>",
      "#1d4ed8e",
    ]) {
      const result = loose(
        await updateTenantBrandingAction({ tenantId: TENANT_ID, primaryColor }),
      );
      if (result.success || result.code !== "VALIDATION_ERROR") {
        failures.push(`${primaryColor}: ${result.code}`);
      }
    }
    expect(failures).toEqual([]);
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.update).not.toHaveBeenCalled();
  });

  it("rejects a website that is not an absolute http(s) URL", async () => {
    asRole("BUSINESS_ADMIN");
    const failures: string[] = [];
    for (const website of [
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "//evil.test",
      "evil.test/x",
    ]) {
      const result = loose(
        await updateTenantBrandingAction({ tenantId: TENANT_ID, website }),
      );
      if (result.success) failures.push(website);
    }
    expect(failures).toEqual([]);
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();
  });

  it("accepts a well-formed https website", async () => {
    asRole("BUSINESS_ADMIN");

    const result = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        website: "https://acme.co.ke",
      }),
    );

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.tenantBranding.create).data).toMatchObject({
      tenantId: TENANT_ID,
      website: "https://acme.co.ke",
    });
  });

  it("enforces the contrast minimum on the server, not just in the form", async () => {
    asRole("BUSINESS_ADMIN");

    const result = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        primaryColor: "#ffffff",
        primaryForeground: "#777777",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.update).not.toHaveBeenCalled();
  });

  it("accepts the documented default palette", async () => {
    asRole("BUSINESS_ADMIN");

    const result = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        primaryColor: "#1d4ed8",
        primaryForeground: "#f8fafc",
      }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects a currency outside the supported set and normalises case", async () => {
    asRole("BUSINESS_ADMIN");

    const usd = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        currency: "USD",
      }),
    );
    expect(usd.success).toBe(false);
    expect(usd.code).toBe("VALIDATION_ERROR");

    const lower = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        currency: "kes",
      }),
    );
    expect(lower.success).toBe(true);
    expect(callArg(prismaMock.tenantBranding.create).data).toMatchObject({
      currency: "KES",
    });
  });

  it("rejects an unknown document layout", async () => {
    asRole("BUSINESS_ADMIN");

    const result = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        documentLayout: "compact; @import url(http://evil.test)",
      }),
    );

    expect(result.success).toBe(false);
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();
  });

  it("writes only whitelisted fields and never an attacker-supplied logoUrl", async () => {
    asRole("BUSINESS_ADMIN");

    const result = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        displayName: "Acme Ltd",
        logoUrl: "https://evil.test/x.svg",
        id: BRANDING_ID,
        targetTenantId: OTHER_TENANT_ID,
        sessionVersion: 7,
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(prismaMock.tenantBranding.create).data as Record<
      string,
      unknown
    >;
    expect(Object.keys(data).sort()).toEqual(["displayName", "tenantId"]);
    expect(data.tenantId).toBe(TENANT_ID);
  });

  it("treats an empty string as clearing a free-text branding field", async () => {
    asRole("BUSINESS_ADMIN");
    prismaMock.tenantBranding.findUnique.mockResolvedValue({ id: BRANDING_ID });

    const result = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        defaultFooter: "",
        website: "",
        taxPin: "  ",
      }),
    );

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.tenantBranding.update).data).toEqual({
      defaultFooter: null,
      website: null,
      taxPin: null,
    });
  });

  it("audits branding by field name only, never the address or tax PIN", async () => {
    asRole("BUSINESS_ADMIN");

    await updateTenantBrandingAction({
      tenantId: TENANT_ID,
      postalAddress: "P.O. Box 123, Nairobi",
      taxPin: "P00000000000",
      contactEmail: "accounts@acme.co.ke",
    });

    const metadata = (auditFor(AUDIT_ACTIONS.BRANDING_UPDATED)[0]?.metadata ??
      {}) as Record<string, unknown>;
    expect(metadata.fields).toEqual(
      expect.arrayContaining(["postalAddress", "taxPin", "contactEmail"]),
    );
    const serialized = JSON.stringify(metadata).toLowerCase();
    expect(serialized).not.toContain("p.o. box 123");
    expect(serialized).not.toContain("p00000000000");
    expect(serialized).not.toContain("accounts@acme");
  });

  it("refuses branding writes for a non-member and for read-only roles", async () => {
    asRole("BUSINESS_OWNER");
    const foreign = loose(
      await updateTenantBrandingAction({
        tenantId: OTHER_TENANT_ID,
        displayName: "Someone else",
      }),
    );
    expect(foreign.success).toBe(false);
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();

    asRole("VIEWER");
    const viewer = loose(
      await updateTenantBrandingAction({
        tenantId: TENANT_ID,
        displayName: "Escalation",
      }),
    );
    expect(viewer.success).toBe(false);
    expect(viewer.code).toBe("FORBIDDEN");

    // SALES_STAFF may read settings but may not change the brand.
    asRole("SALES_STAFF");
    expect(
      loose(
        await updateTenantBrandingAction({
          tenantId: TENANT_ID,
          displayName: "Escalation",
        }),
      ).success,
    ).toBe(false);
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();
  });

  it("clears only the logoUrl on logo deletion", async () => {
    asRole("BUSINESS_ADMIN");
    prismaMock.tenantBranding.findUnique.mockResolvedValue({
      id: BRANDING_ID,
      logoUrl: `/uploads/tenants/${TENANT_ID}/logo/abc.png`,
    });

    const result = loose(await deleteLogoAction(TENANT_ID));

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.tenantBranding.update).data).toEqual({
      logoUrl: null,
    });
  });

  it("reports nothing when no logo is set", async () => {
    asRole("BUSINESS_ADMIN");
    prismaMock.tenantBranding.findUnique.mockResolvedValue({
      id: BRANDING_ID,
      logoUrl: null,
    });

    const result = loose(await deleteLogoAction(TENANT_ID));

    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(prismaMock.tenantBranding.update).not.toHaveBeenCalled();
  });

  it("normalises colours and requires the tenant locator on the server schema", () => {
    const parsed = brandingFieldsSchema.parse({
      displayName: "Acme",
      registeredName: "Acme Genuine Enterprises Ltd",
      primaryColor: "#1D4ED8",
      currency: "KES",
      documentLayout: "standard",
    });
    // Stored colours are lower-cased so a value cannot vary by case only.
    expect(parsed.primaryColor).toBe("#1d4ed8");
    // `brandingFieldsSchema` is a patch; the action schema still demands context.
    expect(
      updateTenantBrandingSchema.safeParse({ displayName: "Acme" }).success,
    ).toBe(false);
    expect(
      updateTenantBrandingSchema.safeParse({ tenantId: TENANT_ID }).success,
    ).toBe(true);
  });
});

// ─── Query bounds ─────────────────────────────────────────────────────────────

describe("Phase 04 query parameter bounds", () => {
  it("rejects an unbounded page size instead of dumping a tenant's data", async () => {
    asRole("BUSINESS_OWNER");
    const failures: string[] = [];
    for (const pageSize of [0, -1, 101, 100_000, 1.5]) {
      const result = loose(
        await getContactsAction({ tenantId: TENANT_ID, pageSize }),
      );
      if (result.success || result.code !== "VALIDATION_ERROR") {
        failures.push(String(pageSize));
      }
    }
    expect(failures).toEqual([]);
    expect(prismaMock.contact.findMany).not.toHaveBeenCalled();
  });

  it("rejects a non-positive page and a free-text sort column", async () => {
    asRole("BUSINESS_OWNER");

    expect(
      loose(await getContactsAction({ tenantId: TENANT_ID, page: 0 })).success,
    ).toBe(false);
    expect(
      loose(
        await getContactsAction({
          tenantId: TENANT_ID,
          sortBy: "email; DROP TABLE Contact",
        }),
      ).success,
    ).toBe(false);
    expect(prismaMock.contact.findMany).not.toHaveBeenCalled();
  });

  it("computes pagination from the validated page and size", async () => {
    asRole("BUSINESS_OWNER");

    const result = loose(
      await getContactsAction({ tenantId: TENANT_ID, page: 3, pageSize: 10 }),
    );

    expect(result.success).toBe(true);
    expect(prismaMock.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it("pins the item list to the authorized tenant with a bounded sort", async () => {
    asRole("BUSINESS_OWNER");
    expect(
      itemQuerySchema.safeParse({ tenantId: TENANT_ID, sortBy: "unitPrice" })
        .success,
    ).toBe(true);
    expect(
      itemQuerySchema.safeParse({ tenantId: TENANT_ID, sortBy: "taxRate.rate" })
        .success,
    ).toBe(false);

    const result = loose(
      await getItemsAction({
        tenantId: TENANT_ID,
        sortBy: "unitPrice",
        sortOrder: "asc",
      }),
    );

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.item.findMany).where).toMatchObject({
      tenantId: TENANT_ID,
    });
    expect(callArg(prismaMock.item.findMany).orderBy).toEqual({
      unitPrice: "asc",
    });
  });

  it("bounds the document query and scopes it to the authorized tenant", async () => {
    asRole("DOCUMENT_MANAGER");

    expect(
      loose(await getDocumentsAction({ tenantId: TENANT_ID, pageSize: 500 }))
        .success,
    ).toBe(false);

    const ok = loose(
      await getDocumentsAction({
        tenantId: TENANT_ID,
        page: 2,
        pageSize: 25,
        sortBy: "issuedAt",
      }),
    );
    expect(ok.success).toBe(true);
    expect(callArg(prismaMock.document.findMany).where).toMatchObject({
      tenantId: TENANT_ID,
    });
    expect(prismaMock.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25 }),
    );
  });

  it("never lets a browser-supplied tenant id widen a read", async () => {
    asRole("BUSINESS_OWNER");

    // The actor belongs to TENANT_ID only. A forged value is denied before the
    // query is built, so `context.tenantId` can never be the attacker's string.
    expect(
      loose(await getDocumentsAction({ tenantId: OTHER_TENANT_ID })).success,
    ).toBe(false);
    expect(
      loose(await getItemsAction({ tenantId: OTHER_TENANT_ID })).success,
    ).toBe(false);
    expect(
      loose(await getContactsAction({ tenantId: OTHER_TENANT_ID })).success,
    ).toBe(false);
    for (const mock of [
      prismaMock.document.findMany,
      prismaMock.item.findMany,
      prismaMock.contact.findMany,
    ]) {
      for (const call of mock.mock.calls) {
        const where = (call[0] as { where?: Record<string, unknown> })?.where;
        expect(where?.tenantId).not.toBe(OTHER_TENANT_ID);
      }
    }
  });
});

// ─── Unauthenticated access ───────────────────────────────────────────────────

describe("Phase 04 unauthenticated access", () => {
  const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["getContactsAction", () => getContactsAction({ tenantId: TENANT_ID })],
    ["getContactAction", () => getContactAction(CONTACT_ID, TENANT_ID)],
    [
      "getContactBalanceAction",
      () => getContactBalanceAction(CONTACT_ID, TENANT_ID),
    ],
    [
      "createContactAction",
      () => createContactAction({ tenantId: TENANT_ID, firstName: "Jane" }),
    ],
    [
      "updateContactAction",
      () =>
        updateContactAction({
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          phone: "+254700000000",
        }),
    ],
    [
      "archiveContactAction",
      () =>
        archiveContactAction({ contactId: CONTACT_ID, tenantId: TENANT_ID }),
    ],
    [
      "restoreContactAction",
      () =>
        restoreContactAction({ contactId: CONTACT_ID, tenantId: TENANT_ID }),
    ],
    ["getItemsAction", () => getItemsAction({ tenantId: TENANT_ID })],
    [
      "createItemAction",
      () =>
        createItemAction({
          tenantId: TENANT_ID,
          name: "Widget",
          unitOfMeasure: "each",
          unitPrice: "1",
        }),
    ],
    [
      "updateItemAction",
      () =>
        updateItemAction({
          tenantId: TENANT_ID,
          itemId: ITEM_ID,
          unitPrice: "2",
        }),
    ],
    ["deleteItemAction", () => deleteItemAction(ITEM_ID, TENANT_ID)],
    [
      "createTaxCategoryAction",
      () =>
        createTaxCategoryAction({
          tenantId: TENANT_ID,
          name: "VAT",
          isDefault: false,
          rates: [
            {
              categoryId: TAX_CATEGORY_ID,
              name: "VAT 16%",
              rate: "0.16",
              isActive: true,
            },
          ],
        }),
    ],
    [
      "createContactItemAction",
      () =>
        createContactItemAction({
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          itemId: ITEM_ID,
          agreedPrice: "1",
        }),
    ],
    [
      "updateContactItemAction",
      () =>
        updateContactItemAction({
          tenantId: TENANT_ID,
          contactItemId: CONTACT_ITEM_ID,
          agreedPrice: "1",
        }),
    ],
    [
      "deleteContactItemAction",
      () =>
        deleteContactItemAction({
          contactItemId: CONTACT_ITEM_ID,
          tenantId: TENANT_ID,
        }),
    ],
    [
      "getAvailableItemsForContactAction",
      () => getAvailableItemsForContactAction(CONTACT_ID, TENANT_ID),
    ],
    [
      "updateTenantBrandingAction",
      () =>
        updateTenantBrandingAction({ tenantId: TENANT_ID, displayName: "X" }),
    ],
    ["getTenantBrandingAction", () => getTenantBrandingAction(TENANT_ID)],
    ["deleteLogoAction", () => deleteLogoAction(TENANT_ID)],
    ["getDocumentsAction", () => getDocumentsAction({ tenantId: TENANT_ID })],
  ];

  it("refuses every Phase 04 action without a session", async () => {
    authMock.mockResolvedValue(null);

    const problems: string[] = [];
    for (const [label, run] of calls) {
      try {
        await run();
        problems.push(`${label} resolved instead of redirecting`);
      } catch (err) {
        const message = (err as Error).message ?? "";
        if (!/^REDIRECT:/.test(message)) {
          problems.push(`${label} threw ${message}`);
        }
      }
    }

    expect(problems).toEqual([]);
    expect(prismaMock.contact.findMany).not.toHaveBeenCalled();
    expect(prismaMock.item.findMany).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
  });

  it("still refuses writes when the session belongs to a different user", async () => {
    // The tenant id is never trusted: membership is re-resolved for the session
    // user on every call, so an unrelated account cannot inherit an access grant.
    authMock.mockResolvedValue({
      id: "cksomeoneelse000000001",
      email: "attacker@example.com",
      platformRole: "USER",
      status: "ACTIVE",
    });
    asRole("BUSINESS_OWNER");

    expect(
      loose(await createContactAction({ tenantId: TENANT_ID, firstName: "X" }))
        .success,
    ).toBe(false);
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });
});

// ─── Partial-update shape invariants ──────────────────────────────────────────

describe("Phase 04 partial update schemas stay patch-shaped", () => {
  it("accepts a single-field contact patch and ignores absent fields", () => {
    const parsed = updateContactSchema.parse({
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      phone: "+254700000000",
    });
    // Absent fields must not be materialised as nulls by the schema.
    expect(Object.keys(parsed).sort()).toEqual([
      "contactId",
      "phone",
      "tenantId",
    ]);
  });

  it("only enforces the contact identity rule when a name field is touched", () => {
    expect(
      updateContactSchema.safeParse({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        notes: "Updated notes only",
      }).success,
    ).toBe(true);
    // Turning a contact into a business without a company name is rejected.
    expect(
      updateContactSchema.safeParse({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        type: "BUSINESS",
      }).success,
    ).toBe(false);
  });

  it("applies the same identity rule to creates", () => {
    expect(
      createContactSchema.safeParse({
        tenantId: TENANT_ID,
        type: "BUSINESS",
        companyName: "Acme",
      }).success,
    ).toBe(true);
    expect(
      createContactSchema.safeParse({ tenantId: TENANT_ID, type: "BUSINESS" })
        .success,
    ).toBe(false);
  });
});
