import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantStatus } from "@prisma/client";

/**
 * Phase 2 — provider administration.
 *
 * The Phase 2 acceptance criteria are all of the form "an unauthorized provider
 * route or Server Action returns an appropriate denial", "the status change and
 * its audit event are recorded atomically", "suspension preserves business
 * records", and "the tenant's own roles cannot reach platform authority". This
 * suite is the evidence for those sentences: every provider write is exercised
 * from the outside (a Server Action call with a payload) and asserted on both
 * sides — what happened when the operator was authorized, and what did NOT
 * happen when they were not.
 *
 * The mocks are the ones the whole suite shares (`prisma-mock` replaces
 * `@amisibiz/database`, `auth-mock` replaces the session resolver), so a
 * production code path that forgot to authorize would show up here as an
 * unexpected delegate call rather than as a passing test.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { prismaMock, auditsFor, auditRows, tenantScope } from "./prisma-mock";
import { authMock, getSessionUser } from "./auth-mock";
import { PERMISSIONS, isWritePermission } from "@amisibiz/auth";
import { AUDIT_ACTIONS } from "@/lib/audit";
import {
  authorizeTenant,
  type TenantAuthzContext,
} from "@/server/auth/authorization";
import {
  activateTenantAction,
  addTenantDomainAction,
  assignTenantOwnerAction,
  assignTenantPlanAction,
  createTenantAction,
  reactivateTenantAction,
  removeTenantDomainAction,
  setPrimaryDomainAction,
  suspendTenantAction,
  updateTenantBrandingForTenantAction,
  updateTenantNumberingAction,
  updateTenantProfileAction,
  updateTenantSlugAction,
} from "@/server/actions/platform";
import {
  answerSyncRequest,
  SYNC_REFUSAL_CODES,
} from "@/server/services/tenant-indicators";
import {
  availableTransitions,
  TENANT_STATUS_TRANSITIONS,
} from "@/server/services/tenant-lifecycle";
import {
  getTenantAuditEvents,
  getTenantDetail,
  getTenantStatusHistory,
  listPlanOptions,
  searchTenants,
} from "@/lib/admin/tenant-queries";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const PLAN_ID = "55555555-5555-4555-8555-555555555555";

const addressedTenant = (
  overrides: Partial<{
    status: TenantStatus;
    slug: string;
    planId: string | null;
  }> = {},
) => ({
  id: TENANT_ID,
  slug: "acme",
  status: "ACTIVE" as TenantStatus,
  planId: null as string | null,
  ...overrides,
});

/** Every delegate a provider write could touch. Used to prove a refusal is total. */
type WriteSpy = { mock: { calls: unknown[] }; getMockName: () => string };

const WRITE_DELEGATES: WriteSpy[] = [
  prismaMock.tenant.create,
  prismaMock.tenant.update,
  prismaMock.tenant.updateMany,
  prismaMock.tenant.delete,
  prismaMock.tenant.deleteMany,
  prismaMock.tenantSettings.update,
  prismaMock.tenantBranding.create,
  prismaMock.tenantBranding.update,
  prismaMock.tenantDomain.create,
  prismaMock.tenantDomain.update,
  prismaMock.tenantDomain.updateMany,
  prismaMock.tenantDomain.delete,
  prismaMock.tenantDomain.deleteMany,
  prismaMock.tenantStatusHistory.create,
  prismaMock.documentNumbering.create,
  prismaMock.documentNumbering.update,
  prismaMock.documentNumbering.upsert,
  prismaMock.documentNumbering.deleteMany,
  prismaMock.documentNumberSequence.update,
  prismaMock.documentNumberSequence.deleteMany,
  prismaMock.invitation.create,
  prismaMock.invitation.upsert,
  prismaMock.tenantMember.create,
  prismaMock.tenantMember.update,
  prismaMock.tenantMember.delete,
] as unknown as WriteSpy[];

function expectNoProviderWrites() {
  const called = WRITE_DELEGATES.filter((fn) => fn.mock.calls.length > 0);
  expect(called.map((fn) => fn.getMockName())).toEqual([]);
}

/** Raw SQL calls as `{ sql, values }`, the shape the indicator functions need. */
function rawCalls(): Array<{ sql: string; values: unknown[] }> {
  const calls = prismaMock.$executeRaw.mock.calls as unknown as unknown[][];
  return calls.map((call) => ({
    sql: (call[0] as readonly string[]).join("?"),
    values: call.slice(1),
  }));
}

function rawCallContaining(fragment: string) {
  return rawCalls().filter((call) => call.sql.includes(fragment));
}

function rowsWritten(): unknown[] {
  return [
    ...prismaMock.tenant.update.mock.calls,
    ...prismaMock.tenant.updateMany.mock.calls,
    ...prismaMock.tenantDomain.create.mock.calls,
    ...prismaMock.tenantBranding.create.mock.calls,
    ...prismaMock.tenantBranding.update.mock.calls,
    ...prismaMock.documentNumbering.upsert.mock.calls,
    ...prismaMock.invitation.upsert.mock.calls,
  ].flat();
}

/**
 * The single audit row written for one action, or a failing assertion.
 *
 * `auditsFor()` returns an array, and reading `[0]` from it under
 * `noUncheckedIndexedAccess` yields `undefined` — which every case below would
 * then have to re-check. Asserting "exactly one, and here it is" once is both
 * shorter and the statement the test actually means: a provider write appends
 * its one evidence row.
 */
function soleAudit(action: string) {
  const rows = auditsFor(action);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error(`Expected one ${action} audit row`);
  return row;
}

function asPlatformAdmin() {
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: "SUPER_ADMIN",
    status: "ACTIVE",
  });
}

/** An ordinary business account: no platform role at all. */
function asOrdinaryUser() {
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
}

/** Support staff: a platform role whose permission set is empty. */
function asSupportStaff() {
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: "SUPPORT",
    status: "ACTIVE",
  });
}

beforeEach(async () => {
  vi.clearAllMocks();

  authMock.mockResolvedValue({
    id: ACTOR_ID,
    email: "operator@amisi.co.ke",
    name: "Operator",
    platformRole: "SUPER_ADMIN",
    status: "ACTIVE",
  });

  // Every entry point resolves the session first, and that is what opens the
  // request's RLS scope; authorization refuses an actor whose session was never
  // resolved in the request.
  await getSessionUser();

  asPlatformAdmin();

  prismaMock.tenant.findUnique.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    if ("slug" in where) return null;
    if (where.id === TENANT_ID) return addressedTenant();
    return null;
  });
  prismaMock.tenant.update.mockResolvedValue({ id: TENANT_ID });
  prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.tenant.create.mockResolvedValue({ id: TENANT_ID, slug: "acme" });
  prismaMock.tenant.count.mockResolvedValue(0);
  prismaMock.tenant.findMany.mockResolvedValue([]);
  prismaMock.tenantStatusHistory.create.mockResolvedValue({ id: "history_1" });
  prismaMock.tenantStatusHistory.findMany.mockResolvedValue([]);
  prismaMock.tenantDomain.findUnique.mockResolvedValue(null);
  prismaMock.tenantDomain.findFirst.mockResolvedValue(null);
  prismaMock.tenantDomain.count.mockResolvedValue(1);
  prismaMock.tenantDomain.create.mockResolvedValue({ id: "domain_1" });
  prismaMock.tenantDomain.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.tenantDomain.update.mockResolvedValue({ id: "domain_1" });
  prismaMock.tenantDomain.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.plan.findUnique.mockResolvedValue(null);
  prismaMock.plan.findMany.mockResolvedValue([]);
  prismaMock.tenantBranding.findUnique.mockResolvedValue(null);
  prismaMock.tenantBranding.create.mockResolvedValue({ id: "branding_1" });
  prismaMock.tenantBranding.update.mockResolvedValue({ id: "branding_1" });
  prismaMock.documentNumbering.upsert.mockResolvedValue({ id: "series_1" });
  prismaMock.documentNumbering.createMany.mockResolvedValue({ count: 3 });
  prismaMock.tenantMember.findFirst.mockResolvedValue(null);
  prismaMock.tenantMember.findUnique.mockResolvedValue(null);
  prismaMock.invitation.upsert.mockResolvedValue({
    id: "invitation_1",
    status: "PENDING",
  });
});

// ─── Denial: the platform gate holds on every provider write ─────────────────

describe("provider writes are refused without the platform permission", () => {
  const cases: Array<{
    name: string;
    permission: string;
    run: () => Promise<unknown>;
  }> = [
    {
      name: "suspend",
      permission: PERMISSIONS.PLATFORM_TENANTS_SUSPEND,
      run: () =>
        suspendTenantAction({ tenantId: TENANT_ID, reason: "abuse reported" }),
    },
    {
      name: "activate",
      permission: PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
      run: () =>
        activateTenantAction({
          tenantId: TENANT_ID,
          reason: "contract signed",
        }),
    },
    {
      name: "reactivate",
      permission: PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
      run: () =>
        reactivateTenantAction({
          tenantId: TENANT_ID,
          reason: "arrangement settled",
        }),
    },
    {
      name: "profile",
      permission: PERMISSIONS.PLATFORM_TENANTS_UPDATE,
      run: () =>
        updateTenantProfileAction({ tenantId: TENANT_ID, name: "New" }),
    },
    {
      name: "slug",
      permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
      run: () =>
        updateTenantSlugAction({ tenantId: TENANT_ID, slug: "new-slug" }),
    },
    {
      name: "add hostname",
      permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
      run: () =>
        addTenantDomainAction({
          tenantId: TENANT_ID,
          hostname: "invoices.example.co.ke",
        }),
    },
    {
      name: "primary hostname",
      permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
      run: () =>
        setPrimaryDomainAction({
          tenantId: TENANT_ID,
          hostname: "invoices.example.co.ke",
        }),
    },
    {
      name: "remove hostname",
      permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
      run: () =>
        removeTenantDomainAction({
          tenantId: TENANT_ID,
          hostname: "invoices.example.co.ke",
        }),
    },
    {
      name: "plan",
      permission: PERMISSIONS.PLATFORM_TENANTS_PLAN_ASSIGN,
      run: () =>
        assignTenantPlanAction({ tenantId: TENANT_ID, planId: PLAN_ID }),
    },
    {
      name: "branding",
      permission: PERMISSIONS.PLATFORM_TENANTS_UPDATE,
      run: () =>
        updateTenantBrandingForTenantAction({
          tenantId: TENANT_ID,
          displayName: "Acme Genuine",
        }),
    },
    {
      name: "numbering",
      permission: PERMISSIONS.PLATFORM_TENANTS_UPDATE,
      run: () =>
        updateTenantNumberingAction({
          tenantId: TENANT_ID,
          series: [{ type: "INVOICE", prefix: "INV", padding: 4 }],
        }),
    },
    {
      name: "initial owner",
      permission: PERMISSIONS.PLATFORM_TENANTS_CREATE,
      run: () =>
        assignTenantOwnerAction({
          tenantId: TENANT_ID,
          email: "owner@example.co.ke",
        }),
    },
  ];

  for (const role of [
    { label: "an ordinary business user", set: asOrdinaryUser },
    { label: "support staff without a grant", set: asSupportStaff },
  ]) {
    it(`refuses ${cases.length} provider writes to ${role.label}`, async () => {
      role.set();

      for (const testCase of cases) {
        const result = (await testCase.run()) as {
          success: boolean;
          code?: string;
        };

        expect({ ...result, action: testCase.name }).toMatchObject({
          success: false,
          code: "FORBIDDEN",
          action: testCase.name,
        });
      }

      expectNoProviderWrites();
      // Each refusal is one audited denial naming the permission it lacked.
      const denials = auditsFor(AUDIT_ACTIONS.AUTHZ_DENIED);
      expect(denials).toHaveLength(cases.length);
      const permissions = denials.map((row) => row.metadata.permission);
      expect(permissions).toContain(PERMISSIONS.PLATFORM_TENANTS_SUSPEND);
      expect(permissions).toContain(PERMISSIONS.PLATFORM_TENANTS_PLAN_ASSIGN);
    });
  }

  it("refuses provisioning too, and writes nothing", async () => {
    asOrdinaryUser();

    const result = await createTenantAction({ name: "Acme Ltd" });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(prismaMock.tenant.create).not.toHaveBeenCalled();
    expect(prismaMock.tenantStatusHistory.create).not.toHaveBeenCalled();
    expect(prismaMock.documentNumbering.createMany).not.toHaveBeenCalled();
  });

  it("a workspace owner with no platform role cannot activate its own tenant", async () => {
    // The requirement is explicit: tenant roles never confer platform authority,
    // so the owner of a PENDING workspace cannot open their own shop. The
    // membership exists, and it changes nothing.
    asOrdinaryUser();
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_OWNER", "PENDING"),
    );

    const result = await activateTenantAction({
      tenantId: TENANT_ID,
      reason: "we are ready",
    });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(prismaMock.tenant.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.tenantStatusHistory.create).not.toHaveBeenCalled();
  });

  it("refuses a forged tenant id with the same generic answer as a missing one", async () => {
    // The payload's `tenantId` only ever scopes authorization; the platform scope
    // cannot address a workspace that does not exist, and the console is not told
    // which of "no such tenant" or "not yours" it was.
    const result = await updateTenantProfileAction({
      tenantId: "99999999-9999-4999-8999-999999999999",
      name: "Forged",
    });

    expect(result).toMatchObject({
      success: false,
      code: "NOT_FOUND",
      error: "No organisation matches that reference.",
    });
    expectNoProviderWrites();
  });

  it("refuses a payload that is not a valid provider input", async () => {
    const results = await Promise.all([
      suspendTenantAction({ tenantId: "not-a-uuid", reason: "abuse" }),
      assignTenantPlanAction({ tenantId: TENANT_ID, planId: "not-a-uuid" }),
      updateTenantProfileAction({ tenantId: TENANT_ID }),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        success: false,
        code: "VALIDATION_ERROR",
      });
    }
    expectNoProviderWrites();
  });
});

// ─── Status transitions: atomic, evidenced, manual ───────────────────────────

function membershipRow(role: string, status: TenantStatus) {
  return { role, tenant: { status } };
}

describe("tenant status transitions are written atomically", () => {
  it("suspension is one transaction: guarded update, history row and audit event", async () => {
    const result = await suspendTenantAction({
      tenantId: TENANT_ID,
      reason: "Non-payment for three cycles, agreed with director",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID, status: "ACTIVE" },
        data: expect.objectContaining({
          status: "SUSPENDED",
          suspendedById: ACTOR_ID,
          suspensionReason:
            "Non-payment for three cycles, agreed with director",
        }),
      }),
    );
    expect(prismaMock.tenantStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          fromStatus: "ACTIVE",
          toStatus: "SUSPENDED",
          changedById: ACTOR_ID,
          reason: "Non-payment for three cycles, agreed with director",
        }),
      }),
    );

    const audit = soleAudit(AUDIT_ACTIONS.PLATFORM_TENANT_SUSPENDED);
    expect(audit.tenantId).toBe(TENANT_ID);
    expect(audit.userId).toBe(ACTOR_ID);
    expect(audit.metadata).toEqual({
      reason: "Non-payment for three cycles, agreed with director",
    });
  });

  it("refuses a transition whose expected status is gone, and writes no history", async () => {
    // A second operator who already suspended the workspace moves zero rows: the
    // `WHERE status = <expected>` guard is the concurrency control, and a history
    // row for a change that did not happen would be a false record.
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 0 });

    const result = await suspendTenantAction({
      tenantId: TENANT_ID,
      reason: "abuse reported",
    });

    expect(result).toMatchObject({
      success: false,
      code: "CONFLICT",
      error: "Only an active organisation can be suspended.",
    });
    expect(prismaMock.tenantStatusHistory.create).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });

  it("leaves business rows and storage alone: suspension deletes nothing", async () => {
    await suspendTenantAction({
      tenantId: TENANT_ID,
      reason: "manual suspension for testing",
    });

    // The only writes are the guarded status update and the append-only history
    // row. No delete anywhere, and the branding/document/contact tables are never
    // touched — a suspended business keeps every record it has.
    expect(prismaMock.tenant.delete).not.toHaveBeenCalled();
    expect(prismaMock.tenant.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.tenantDomain.delete).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.delete).not.toHaveBeenCalled();
    expect(prismaMock.documentNumbering.delete).not.toHaveBeenCalled();
    expect(prismaMock.documentNumbering.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.documentNumberSequence.delete).not.toHaveBeenCalled();
    expect(prismaMock.documentNumberSequence.deleteMany).not.toHaveBeenCalled();
    expect(
      prismaMock.contact.delete.mock.calls.length +
        prismaMock.document.delete.mock.calls.length +
        prismaMock.item.delete.mock.calls.length,
    ).toBe(0);
  });

  it("reactivation clears the suspension bookkeeping and keeps the history", async () => {
    const result = await reactivateTenantAction({
      tenantId: TENANT_ID,
      reason: "Payment arrangement settled",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID, status: "SUSPENDED" },
        data: expect.objectContaining({
          status: "ACTIVE",
          suspendedAt: null,
          suspendedById: null,
          suspensionReason: null,
        }),
      }),
    );
    expect(prismaMock.tenantStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromStatus: "SUSPENDED",
          toStatus: "ACTIVE",
        }),
      }),
    );
    expect(auditsFor(AUDIT_ACTIONS.PLATFORM_TENANT_REACTIVATED)).toHaveLength(
      1,
    );
  });

  it("publishes exactly the three implemented transitions, each with its own permission", async () => {
    // This is the verified list the administrator documentation reproduces. The
    // permission belongs to the transition rather than to the action file so a
    // suspend-only operator cannot reactivate, and no caller can add a fourth
    // transition without adding the row here.
    expect(
      TENANT_STATUS_TRANSITIONS.map((transition) => ({
        from: transition.fromStatus,
        to: transition.toStatus,
        permission: transition.permission,
      })),
    ).toEqual([
      {
        from: "PENDING",
        to: "ACTIVE",
        permission: PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
      },
      {
        from: "ACTIVE",
        to: "SUSPENDED",
        permission: PERMISSIONS.PLATFORM_TENANTS_SUSPEND,
      },
      {
        from: "SUSPENDED",
        to: "ACTIVE",
        permission: PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
      },
    ]);

    expect(availableTransitions("PENDING").map((t) => t.key)).toEqual([
      "activate",
    ]);
    expect(availableTransitions("ACTIVE").map((t) => t.key)).toEqual([
      "suspend",
    ]);
    expect(availableTransitions("SUSPENDED").map((t) => t.key)).toEqual([
      "reactivate",
    ]);
  });

  it("has no automatic suspension path: nothing in the console moves a status by itself", async () => {
    // The MVP rule is manual activation and suspension. The only writers of a
    // status are the three actions above, each requiring a reason and a
    // permission, and every transition row records the human who chose it.
    for (const transition of TENANT_STATUS_TRANSITIONS) {
      expect(transition.permission.startsWith("platform.")).toBe(true);
    }

    const result = await suspendTenantAction({ tenantId: TENANT_ID });
    expect(result).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
    expect(prismaMock.tenant.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Suspension semantics: writes and sync off, reads and downloads on ───────

describe("a suspended workspace keeps its reads and loses its writes", () => {
  beforeEach(() => {
    // The actor is a workspace member with no platform role. A SUPER_ADMIN actor
    // would resolve `readonly: false` by design — the provider's own authority
    // survives suspension — and every denial below would silently not happen.
    asOrdinaryUser();
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_OWNER", "SUSPENDED"),
    );
  });

  it("refuses each write permission and audits tenant.writeDenied for all of them", async () => {
    const writePermissions = [
      PERMISSIONS.CONTACTS_CREATE,
      PERMISSIONS.CONTACTS_UPDATE,
      PERMISSIONS.CONTACTS_DELETE,
      PERMISSIONS.ITEMS_CREATE,
      PERMISSIONS.INVOICES_ISSUE,
      PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
      PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
    ];

    for (const permission of writePermissions) {
      expect(isWritePermission(permission)).toBe(true);
      await expect(
        authorizeTenant(ACTOR_ID, TENANT_ID, permission),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    // The audit rows are what makes the suspension visible to the operator, and
    // they are written before the error propagates — not fire-and-forget.
    const denials = auditsFor(AUDIT_ACTIONS.TENANT_WRITE_DENIED);
    expect(denials).toHaveLength(writePermissions.length);
    expect(denials[0]?.metadata.reason).toBe("tenant_suspended");
    expect(denials[0]?.metadata.tenantStatus).toBe("SUSPENDED");
  });

  it("keeps reads and downloads working for the workspace's own members", async () => {
    for (const permission of [
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.DOCUMENTS_READ,
      PERMISSIONS.DOCUMENTS_DOWNLOAD,
      PERMISSIONS.BUSINESS_SETTINGS_READ,
    ]) {
      await expect(
        authorizeTenant(ACTOR_ID, TENANT_ID, permission),
      ).resolves.toMatchObject({ readonly: true, tenantStatus: "SUSPENDED" });
    }

    expect(auditsFor(AUDIT_ACTIONS.TENANT_WRITE_DENIED)).toHaveLength(0);
  });

  it("stamps activity for an authorized write and never for a read", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_ADMIN", "ACTIVE"),
    );

    await authorizeTenant(ACTOR_ID, TENANT_ID, PERMISSIONS.CONTACTS_READ);
    expect(rawCallContaining("touch_tenant_activity")).toHaveLength(0);

    await authorizeTenant(ACTOR_ID, TENANT_ID, PERMISSIONS.CONTACTS_CREATE);
    const stamps = rawCallContaining("touch_tenant_activity");
    expect(stamps).toHaveLength(1);
    expect(stamps[0]?.values).toEqual([TENANT_ID]);
  });

  it("an indicator that cannot be written does not refuse the business operation", async () => {
    // The `lastActivityAt` column is a derived fact. If the SECURITY DEFINER
    // stamp fails, the console has a reporting gap — it must not cost a customer
    // their invoice.
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_ADMIN", "ACTIVE"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    prismaMock.$executeRaw.mockRejectedValue(new Error("connection lost"));

    try {
      await expect(
        authorizeTenant(ACTOR_ID, TENANT_ID, PERMISSIONS.CONTACTS_CREATE),
      ).resolves.toMatchObject({ role: "TENANT_ADMIN" });
    } finally {
      // Restored here rather than in `beforeEach`: the shared harness's default
      // `$executeRaw` resolves, and leaving a rejection in place would make the
      // next case fail for the wrong reason.
      prismaMock.$executeRaw.mockResolvedValue(1);
      consoleError.mockRestore();
    }
  });

  it("the provider keeps write authority over the workspace it suspended", async () => {
    // Otherwise the operator who suspended a business could not fix the branding,
    // move its hostname or bring it back — suspension stops the tenant's writes,
    // not the provider's.
    asPlatformAdmin();
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    const result = await updateTenantBrandingForTenantAction({
      tenantId: TENANT_ID,
      displayName: "Acme Genuine",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.tenantBranding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
  });

  it("a PENDING workspace stays closed to its members", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_OWNER", "PENDING"),
    );

    await expect(
      authorizeTenant(ACTOR_ID, TENANT_ID, PERMISSIONS.CONTACTS_READ),
    ).rejects.toMatchObject({ code: "TENANT_PENDING" });
  });
});

// ─── The synchronization answer ──────────────────────────────────────────────

describe("synchronization attempts are answered and recorded", () => {
  function contextFor(overrides: {
    readonly: boolean;
    tenantStatus: TenantStatus;
    via?: "membership" | "support_grant";
  }) {
    return {
      userId: ACTOR_ID,
      tenantId: TENANT_ID,
      role: "TENANT_OWNER" as const,
      tenantStatus: overrides.tenantStatus,
      via: overrides.via ?? ("membership" as const),
      readonly: overrides.readonly,
      supportGrantId: null,
      // The harness's scope stub and the real `DbScope` are the same shape; the
      // cast is the mock's limitation, not a claim about the context.
      scope: tenantScope(
        ACTOR_ID,
        TENANT_ID,
        "TENANT_OWNER",
        {},
      ) as unknown as TenantAuthzContext["scope"],
    };
  }

  it("accepts a sync from a writable member and clears the previous refusal code", async () => {
    const attempt = await answerSyncRequest(
      contextFor({ readonly: false, tenantStatus: "ACTIVE" }),
    );

    expect(attempt).toEqual({ accepted: true });
    const recorded = rawCallContaining("record_tenant_sync_attempt");
    expect(recorded).toHaveLength(1);
    // accepted, and a null code: a newer accepted sync must not be shown next to
    // an old failure in the console.
    expect(recorded[0]?.values).toEqual([TENANT_ID, true, null]);
    expect(auditsFor(AUDIT_ACTIONS.SYNC_REJECTED)).toHaveLength(0);
  });

  it("refuses a suspended workspace with a machine code and an audit row", async () => {
    const attempt = await answerSyncRequest(
      contextFor({ readonly: true, tenantStatus: "SUSPENDED" }),
    );

    expect(attempt).toEqual({
      accepted: false,
      code: SYNC_REFUSAL_CODES.tenantSuspended,
    });
    const recorded = rawCallContaining("record_tenant_sync_attempt");
    expect(recorded[0]?.values).toEqual([TENANT_ID, false, "tenant_suspended"]);

    const rejection = soleAudit(AUDIT_ACTIONS.SYNC_REJECTED);
    expect(rejection.metadata.code).toBe("tenant_suspended");
    expect(rejection.metadata.tenantStatus).toBe("SUSPENDED");
  });

  it("refuses a provider support grant and names the real reason", async () => {
    const attempt = await answerSyncRequest(
      contextFor({
        readonly: true,
        tenantStatus: "ACTIVE",
        via: "support_grant",
      }),
    );

    expect(attempt).toEqual({
      accepted: false,
      code: SYNC_REFUSAL_CODES.supportReadOnly,
    });

    // The console shows this string to an operator, so it has to say which of the
    // two read-only situations it was: the workspace is ACTIVE, and the grant is
    // what is read-only.
    const recorded = rawCallContaining("record_tenant_sync_attempt");
    expect(recorded[0]?.values).toEqual([
      TENANT_ID,
      false,
      "support_read_only",
    ]);
    const rejection = soleAudit(AUDIT_ACTIONS.SYNC_REJECTED);
    expect(rejection.metadata.code).toBe("support_read_only");
    expect(rejection.metadata.via).toBe("support_grant");
  });
});

// ─── Workspace address: slug and hostnames ───────────────────────────────────

describe("workspace address management", () => {
  it("moves the slug and audits old and new values", async () => {
    const result = await updateTenantSlugAction({
      tenantId: TENANT_ID,
      slug: "acme-genuine",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID },
        data: { slug: "acme-genuine" },
      }),
    );
    const audit = soleAudit(AUDIT_ACTIONS.PLATFORM_TENANT_DOMAIN_UPDATED);
    expect(audit.metadata).toEqual({
      field: "slug",
      from: "acme",
      to: "acme-genuine",
    });
  });

  it("refuses a slug already taken without naming the tenant that holds it", async () => {
    prismaMock.tenant.findUnique.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {};
      if ("slug" in where) return { id: OTHER_TENANT_ID };
      return addressedTenant();
    });

    const result = await updateTenantSlugAction({
      tenantId: TENANT_ID,
      slug: "acme-genuine",
    });

    expect(result).toMatchObject({
      success: false,
      code: "CONFLICT",
      error: "That slug is already in use by another organisation.",
    });
    expect(String(JSON.stringify(rowsWritten()))).not.toContain(
      OTHER_TENANT_ID,
    );
    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
  });

  it("refuses a reserved or malformed slug before touching the database", async () => {
    // A one-character slug is legal (`isValidSlug` bounds length at the top, not
    // the bottom), so the reserved name and the shape rules are what this case
    // is really about.
    for (const slug of ["admin", "acme-", "has spaces", "-leading"]) {
      const result = await updateTenantSlugAction({
        tenantId: TENANT_ID,
        slug,
      });
      expect(result).toMatchObject({
        success: false,
        code: "VALIDATION_ERROR",
      });
    }
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("makes the first hostname primary and refuses a hostname another tenant holds", async () => {
    prismaMock.tenantDomain.count.mockResolvedValue(0);

    const added = await addTenantDomainAction({
      tenantId: TENANT_ID,
      hostname: "Invoices.Example.co.KE",
    });
    expect(added).toMatchObject({ success: true });
    expect(prismaMock.tenantDomain.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          hostname: "invoices.example.co.ke",
          isPrimary: true,
        }),
      }),
    );

    // Now the workspace has a primary, so a second hostname is not one — unless
    // the operator says so, in which case the old primary is demoted first.
    prismaMock.tenantDomain.count.mockResolvedValue(1);
    await addTenantDomainAction({
      tenantId: TENANT_ID,
      hostname: "shop.example.co.ke",
      setAsPrimary: true,
    });
    expect(prismaMock.tenantDomain.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID, isPrimary: true },
        data: { isPrimary: false },
      }),
    );

    prismaMock.tenantDomain.findUnique.mockResolvedValue({
      id: "domain_foreign",
      tenantId: OTHER_TENANT_ID,
    });
    const clash = await addTenantDomainAction({
      tenantId: TENANT_ID,
      hostname: "taken.example.co.ke",
    });
    expect(clash).toMatchObject({
      success: false,
      code: "CONFLICT",
      error: "That hostname is already assigned to another organisation.",
    });
  });

  it("never leaves a workspace with two primaries or none while moving the primary", async () => {
    prismaMock.tenantDomain.findFirst.mockResolvedValue({
      id: "domain_2",
      isPrimary: false,
    });

    const result = await setPrimaryDomainAction({
      tenantId: TENANT_ID,
      hostname: "shop.example.co.ke",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.tenantDomain.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isPrimary: false } }),
    );
    expect(prismaMock.tenantDomain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "domain_2" },
        data: { isPrimary: true },
      }),
    );
  });

  it("refuses to promote a hostname the workspace does not own", async () => {
    const result = await setPrimaryDomainAction({
      tenantId: TENANT_ID,
      hostname: "someone-else.example.co.ke",
    });

    expect(result).toMatchObject({
      success: false,
      code: "NOT_FOUND",
      error: "That hostname is not assigned to this organisation.",
    });
    expect(prismaMock.tenantDomain.update).not.toHaveBeenCalled();
    expect(prismaMock.tenantDomain.updateMany).not.toHaveBeenCalled();
  });

  it("detaching a hostname removes the routing rule and nothing else", async () => {
    const result = await removeTenantDomainAction({
      tenantId: TENANT_ID,
      hostname: "shop.example.co.ke",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.tenantDomain.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, hostname: "shop.example.co.ke" },
    });
    // The delete is scoped to the addressed tenant: the hostname alone is not the
    // key, so a provider cannot remove another workspace's domain by name.
    expect(prismaMock.tenant.delete).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.delete).not.toHaveBeenCalled();
  });

  it("a hostname removal that matches no row is refused, not silently successful", async () => {
    prismaMock.tenantDomain.deleteMany.mockResolvedValue({ count: 0 });

    const result = await removeTenantDomainAction({
      tenantId: TENANT_ID,
      hostname: "never-assigned.example.co.ke",
    });

    expect(result).toMatchObject({
      success: false,
      code: "NOT_FOUND",
      error: "That hostname is not assigned to this organisation.",
    });
    expect(auditRows()).toEqual([]);
  });
});

// ─── Plan label ──────────────────────────────────────────────────────────────

describe("plan assignment is a label, not an entitlement", () => {
  it("assigns an ACTIVE plan and audits the code rather than a price", async () => {
    prismaMock.plan.findUnique.mockResolvedValue({
      id: PLAN_ID,
      code: "STANDARD",
      status: "ACTIVE",
    });

    const result = await assignTenantPlanAction({
      tenantId: TENANT_ID,
      planId: PLAN_ID,
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { planId: PLAN_ID } }),
    );
    const audit = soleAudit(AUDIT_ACTIONS.PLATFORM_TENANT_PLAN_ASSIGNED);
    expect(audit.metadata).toEqual({ planCode: "STANDARD" });
  });

  it("refuses a RETIRED plan and an unknown one, and writes nothing", async () => {
    prismaMock.plan.findUnique.mockResolvedValue({
      id: PLAN_ID,
      code: "STARTER",
      status: "RETIRED",
    });
    const retired = await assignTenantPlanAction({
      tenantId: TENANT_ID,
      planId: PLAN_ID,
    });
    expect(retired).toMatchObject({
      success: false,
      code: "CONFLICT",
      error: "That plan is no longer available for assignment.",
    });

    prismaMock.plan.findUnique.mockResolvedValue(null);
    const unknown = await assignTenantPlanAction({
      tenantId: TENANT_ID,
      planId: "88888888-8888-4888-8888-888888888888",
    });
    expect(unknown).toMatchObject({
      success: false,
      code: "NOT_FOUND",
      error: "Unknown plan.",
    });

    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });

  it("clears the label with null, and refuses to set it to what it already is", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(
      addressedTenant({ planId: PLAN_ID }),
    );
    // The plan has to resolve for the "already assigned" refusal to be the one
    // the operator hears: the lookup runs first, so an unknown plan would
    // otherwise answer with `Unknown plan.` instead.
    prismaMock.plan.findUnique.mockResolvedValue({
      id: PLAN_ID,
      code: "STANDARD",
      status: "ACTIVE",
    });

    const same = await assignTenantPlanAction({
      tenantId: TENANT_ID,
      planId: PLAN_ID,
    });
    expect(same).toMatchObject({
      success: false,
      code: "VALIDATION_ERROR",
      error: "That is already the assigned plan.",
    });

    const cleared = await assignTenantPlanAction({
      tenantId: TENANT_ID,
      planId: null,
    });
    expect(cleared).toMatchObject({ success: true });
    expect(prismaMock.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { planId: null } }),
    );
    const audit = soleAudit(AUDIT_ACTIONS.PLATFORM_TENANT_PLAN_ASSIGNED);
    expect(audit.metadata).toEqual({ planCode: null });
  });

  it("assigning a plan never touches the tenant status", async () => {
    prismaMock.plan.findUnique.mockResolvedValue({
      id: PLAN_ID,
      code: "STANDARD",
      status: "ACTIVE",
    });

    await assignTenantPlanAction({ tenantId: TENANT_ID, planId: PLAN_ID });

    // The MVP has no automatic suspension for an overdue arrangement: the plan is
    // a commercial note, and only `platform.tenants.suspend` changes a status.
    expect(prismaMock.tenant.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.tenantStatusHistory.create).not.toHaveBeenCalled();
    expect(
      (
        prismaMock.tenant.update.mock.calls as unknown as Array<
          [{ data: Record<string, unknown> }]
        >
      ).every(
        ([args]) =>
          !("status" in args.data) &&
          !("suspendedAt" in args.data) &&
          !("suspensionReason" in args.data),
      ),
    ).toBe(true);
  });
});

// ─── Branding and numbering: the same row a tenant would write ───────────────

describe("provider branding and numbering configuration", () => {
  it("writes the validated branding patch and audits field names only", async () => {
    prismaMock.tenantBranding.findUnique.mockResolvedValue({
      id: "branding_1",
    });

    const result = await updateTenantBrandingForTenantAction({
      tenantId: TENANT_ID,
      displayName: "Acme Genuine",
      postalAddress: "P.O. Box 1234, Nairobi",
      taxPin: "A1234567890",
      currency: "KES",
      documentLayout: "compact",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.tenantBranding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          displayName: "Acme Genuine",
          taxPin: "A1234567890",
          currency: "KES",
          documentLayout: "compact",
        }),
      }),
    );

    // The trail says WHICH fields changed, never their contents: an address and a
    // PIN are not audit material.
    const audit = soleAudit(AUDIT_ACTIONS.PLATFORM_TENANT_BRANDING_UPDATED);
    expect(audit.metadata.fields).toEqual([
      "displayName",
      "postalAddress",
      "taxPin",
      "currency",
      "documentLayout",
    ]);
    const trail = JSON.stringify(auditRows());
    expect(trail).not.toContain("A1234567890");
    expect(trail).not.toContain("P.O. Box 1234");
  });

  it("refuses an unreadable colour pair before opening a transaction", async () => {
    const result = await updateTenantBrandingForTenantAction({
      tenantId: TENANT_ID,
      primaryColor: "#1d4ed8",
      primaryForeground: "#0f172a",
    });

    expect(result).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expectNoProviderWrites();
  });

  it("never lets a branding patch move a logoUrl", async () => {
    await updateTenantBrandingForTenantAction({
      tenantId: TENANT_ID,
      displayName: "Acme Genuine",
      // A caller that invents a logo field is ignored, not written: logo bytes
      // reach the row only through the upload route.
      logoUrl: "https://attacker.example/other-tenant.png",
    } as unknown as Record<string, unknown>);

    const data = prismaMock.tenantBranding.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect("logoUrl" in data.data).toBe(false);
  });

  it("writes the series configuration and leaves issued numbers alone", async () => {
    const result = await updateTenantNumberingAction({
      tenantId: TENANT_ID,
      series: [
        {
          type: "INVOICE",
          prefix: "AG",
          padding: 5,
          periodStyle: "CALENDAR_YEAR",
        },
        {
          type: "QUOTATION",
          prefix: "QUO",
          padding: 4,
          periodStyle: "FINANCIAL_YEAR",
          fiscalStartMonth: 7,
        },
      ],
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.documentNumbering.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.documentNumbering.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_type: { tenantId: TENANT_ID, type: "INVOICE" },
        },
        update: expect.objectContaining({ prefix: "AG", padding: 5 }),
      }),
    );

    // Changing a prefix renumbers nothing: the counters and the documents are not
    // this path's business.
    expect(prismaMock.documentNumberSequence.update).not.toHaveBeenCalled();
    expect(prismaMock.documentNumberSequence.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.document.update).not.toHaveBeenCalled();
    expect(prismaMock.document.updateMany).not.toHaveBeenCalled();
  });

  it("refuses duplicate or unknown document types in one numbering payload", async () => {
    const duplicated = await updateTenantNumberingAction({
      tenantId: TENANT_ID,
      series: [
        { type: "INVOICE", prefix: "INV", padding: 4 },
        { type: "INVOICE", prefix: "AG", padding: 4 },
      ],
    });
    expect(duplicated).toMatchObject({
      success: false,
      code: "VALIDATION_ERROR",
    });

    const unknown = await updateTenantNumberingAction({
      tenantId: TENANT_ID,
      series: [{ type: "PAYMENT_RECEIPT", prefix: "RCP", padding: 4 }],
    });
    expect(unknown).toMatchObject({ success: false, code: "VALIDATION_ERROR" });

    expect(prismaMock.documentNumbering.upsert).not.toHaveBeenCalled();
  });
});

// ─── Initial owner: an invitation, never a membership ────────────────────────

describe("assigning the initial owner", () => {
  it("issues a TENANT_OWNER invitation and does not create a membership", async () => {
    const result = await assignTenantOwnerAction({
      tenantId: TENANT_ID,
      email: "Owner@Example.co.ke",
    });

    expect(result).toMatchObject({ success: true });
    expect(prismaMock.tenantMember.create).not.toHaveBeenCalled();

    const call = prismaMock.invitation.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(call.where).toEqual({
      tenantId_email: { tenantId: TENANT_ID, email: "owner@example.co.ke" },
    });
    expect(call.create).toMatchObject({
      tenantId: TENANT_ID,
      email: "owner@example.co.ke",
      role: "TENANT_OWNER",
      invitedBy: ACTOR_ID,
      status: "PENDING",
    });

    // Only the hash is stored, and it is not the literal token.
    const tokenHash = String(call.create.tokenHash);
    expect(tokenHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(tokenHash)).toBe(true);
    const trail = JSON.stringify(auditRows());
    expect(trail).not.toContain(tokenHash);
  });

  it("refuses when the workspace already has an owner seat", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValue({ id: "member_owner" });

    const result = await assignTenantOwnerAction({
      tenantId: TENANT_ID,
      email: "second@example.co.ke",
    });

    expect(result).toMatchObject({
      success: false,
      code: "CONFLICT",
      error:
        "This organisation already has an owner. Ownership moves through a role change inside the workspace.",
    });
    expect(prismaMock.invitation.upsert).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });

  it("works on a PENDING workspace, which is where the first owner is invited", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(
      addressedTenant({ status: "PENDING" }),
    );

    const result = await assignTenantOwnerAction({
      tenantId: TENANT_ID,
      email: "owner@example.co.ke",
    });

    expect(result).toMatchObject({ success: true });
  });

  it("provisioning creates a PENDING tenant and never grants ownership from an email", async () => {
    const result = await createTenantAction({
      name: "Acme Genuine Ltd",
      ownerEmail: "owner@example.co.ke",
    });

    expect(result).toMatchObject({ success: true });
    const created = prismaMock.tenant.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.status).toBe("PENDING");
    expect(created.data.slug).toBe("acme-genuine-ltd");

    // Ownership arrives through the invitation the recipient must accept; no
    // membership row exists for an address that has not signed in.
    expect(prismaMock.tenantMember.create).not.toHaveBeenCalled();
    expect(prismaMock.invitation.upsert).toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.TENANT_CREATED)).toHaveLength(1);
  });
});

// ─── The console's own read models ───────────────────────────────────────────

describe("provider console reads are authorization checks of their own", () => {
  it("refuses every console read to an account without the platform permission", async () => {
    asOrdinaryUser();

    await expect(searchTenants({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(getTenantDetail(TENANT_ID)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(listPlanOptions()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(getTenantStatusHistory(TENANT_ID)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
    expect(prismaMock.tenant.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.plan.findMany).not.toHaveBeenCalled();
  });

  it("keeps the audit trail behind its own permission", async () => {
    // `platform.audit.read` is separate from `platform.tenants.read` on purpose:
    // a console that can list workspaces must not gain the evidence trail of
    // every one of them without saying so. SUPPORT holds no platform permission
    // at all, so it is refused both — and each refusal names the permission that
    // was actually asked for, which is what proves the two reads are two checks.
    asSupportStaff();

    await expect(getTenantAuditEvents(TENANT_ID)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(searchTenants({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(prismaMock.auditLog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();

    const permissions = auditsFor(AUDIT_ACTIONS.AUTHZ_DENIED).map(
      (row) => row.metadata.permission,
    );
    expect(permissions).toEqual([
      PERMISSIONS.PLATFORM_AUDIT_READ,
      PERMISSIONS.PLATFORM_TENANTS_READ,
    ]);
  });

  it("clamps an out-of-range page and ignores a forged filter instead of going unbounded", async () => {
    prismaMock.tenant.count.mockResolvedValue(0);

    const result = await searchTenants({
      page: "999999999",
      pageSize: "5000",
      status: "NOT_A_STATUS",
      planId: "not-a-uuid",
    });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    // An unparseable filter reads as "no filter": the console still renders.
    const where = prismaMock.tenant.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(where.where).toEqual({});
    expect(where.take).toBeLessThanOrEqual(100);
  });

  it("reads one workspace's history through the addressed tenant id only", async () => {
    prismaMock.tenantStatusHistory.findMany.mockResolvedValue([]);

    await getTenantStatusHistory(TENANT_ID);

    expect(prismaMock.tenantStatusHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID },
        take: expect.any(Number),
      }),
    );
  });
});
