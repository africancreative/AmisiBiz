import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 07 — Audit and observability.
 *
 * What is locked here:
 *  - the logger redacts secrets even when they are nested or inside arrays;
 *  - the audit writer still OMITS credential-shaped keys, recursively (the
 *    top-level-only pass was the real gap this phase closed);
 *  - the audit read actions enforce permission, tenant scoping and input bounds;
 *  - error tracking never surfaces a raw message outside development.
 *
 * The harness is the same one used across the suite: `@amisibiz/database` and
 * the session resolver are replaced by `./prisma-mock` and `./auth-mock`, so the
 * arguments handed to Prisma — which are the production query — can be asserted.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));

import { prismaMock, auditsFor } from "./prisma-mock";
import { authMock } from "./auth-mock";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT_ID = "33333333-3333-4333-8333-333333333333";

describe("logger redaction", () => {
  it("redacts secrets recursively in structured context", async () => {
    const { createLogger } = await import("@/lib/logger");
    const logger = createLogger("test");
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    logger.info("something happened", {
      nested: {
        password: "hunter2",
        headers: { authorization: "Bearer eyJhbGciOi..." },
        items: [{ token: "abc" }, { safe: "ok" }],
      },
      safe: "value",
    });

    expect(spy).toHaveBeenCalled();
    // Non-production output is `[scope] message` plus the redacted context.
    const context = spy.mock.calls[0]?.[1] as
      Record<string, unknown> | undefined;
    expect(context).toBeDefined();

    const nested = (context?.nested as Record<string, unknown>) ?? {};
    expect(nested.password).toBeUndefined();
    expect(
      (nested.headers as Record<string, unknown>).authorization,
    ).toBeUndefined();

    const items = (nested.items as Record<string, unknown>[]) ?? [];
    expect(items[0]?.token).toBeUndefined();
    expect(items[1]?.safe).toBe("ok");

    // Innocuous keys survive at every level.
    expect(context?.safe).toBe("value");

    spy.mockRestore();
  });
});

describe("audit recursive sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits credential-shaped keys at any depth", async () => {
    const { recordAudit, AUDIT_ACTIONS } = await import("@/lib/audit");
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
      metadata: {
        details: {
          tokenHash: "deadbeef",
          array: [{ secret: "x" }, { other: "y" }],
        },
        reason: "nope",
      },
    });

    const [row] = auditsFor(AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED);
    expect(row).toBeDefined();
    const metadata = row?.metadata ?? {};
    expect(metadata.reason).toBe("nope");

    const details = metadata.details as Record<string, unknown>;
    expect(details.tokenHash).toBeUndefined();

    const arr = details.array as Record<string, unknown>[];
    expect(arr[0]?.secret).toBeUndefined();
    expect(arr[1]?.other).toBe("y");
  });
});

describe("error tracking", () => {
  it("returns a correlation id and never surfaces the raw message outside development", async () => {
    const { reportError } = await import("@/lib/error-tracking");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = reportError(new Error("sensitive internal detail"), {
      digest: "abc123",
    });

    expect(res.correlationId).toBe("abc123");
    // NODE_ENV is "test" here, so the message/stack must be withheld exactly as
    // they would be in production.
    const logged = spy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("sensitive internal detail");

    spy.mockRestore();
  });
});

describe("audit read actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getAuditLogAction denies without permission", async () => {
    authMock.mockResolvedValueOnce({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      platformRole: null,
      status: "ACTIVE",
    } as never);
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "VIEWER",
      tenant: { status: "ACTIVE" },
    } as never);

    const { getAuditLogAction } = await import("@/server/actions/audit");
    const res = await getAuditLogAction({ tenantId: TENANT_ID });

    expect(res.success).toBe(false);
    if (res.success) throw new Error("expected the action to be denied");
    expect(res.code).toBe("FORBIDDEN");
  });

  it("getAuditLogAction scopes to the authorized tenant", async () => {
    authMock.mockResolvedValueOnce({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      platformRole: null,
      status: "ACTIVE",
    } as never);
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "TENANT_OWNER",
      tenant: { status: "ACTIVE" },
    } as never);

    const now = new Date("2026-10-22T00:00:00Z");
    prismaMock.auditLog.findMany.mockResolvedValueOnce([
      {
        id: "a1",
        action: "test.action",
        resource: "Document",
        resourceId: "r1",
        tenantId: TENANT_ID,
        userId: USER_ID,
        metadata: null,
        ipAddress: null,
        userAgent: null,
        createdAt: now,
        user: { id: USER_ID, name: "Alex", email: "alex@example.com" },
        tenant: { id: TENANT_ID, name: "T1", slug: "t1" },
      },
    ] as never);
    prismaMock.auditLog.count.mockResolvedValueOnce(1 as never);

    const { getAuditLogAction } = await import("@/server/actions/audit");
    const res = await getAuditLogAction({
      tenantId: TENANT_ID,
      page: 1,
      pageSize: 25,
    });

    expect(res.success).toBe(true);
    if (res.success && res.data) {
      expect(res.data.entries).toHaveLength(1);
      expect(res.data.entries[0]?.actorId).toBe(USER_ID);
    }
    const findCall = prismaMock.auditLog.findMany.mock.calls.at(-1)?.[0] as
      { where: { tenantId?: string } } | undefined;
    expect(findCall?.where.tenantId).toBe(TENANT_ID);
  });

  it("getPlatformAuditLogAction requires platform.audit.read", async () => {
    authMock.mockResolvedValueOnce({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      platformRole: null,
      status: "ACTIVE",
    } as never);

    const { getPlatformAuditLogAction } =
      await import("@/server/actions/audit");
    const res = await getPlatformAuditLogAction({});
    expect(res.success).toBe(false);
  });

  it("getPlatformAuditLogAction reads across tenants for SUPER_ADMIN", async () => {
    // Persistent stubs: this case drives the action twice, and a `…Once` stub
    // would leave the second call with no session (and no platform claims).
    authMock.mockResolvedValue({ id: USER_ID, platformRole: "SUPER_ADMIN" });
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    } as never);
    prismaMock.auditLog.findMany.mockResolvedValue([] as never);
    prismaMock.auditLog.count.mockResolvedValue(0 as never);

    const { getPlatformAuditLogAction } =
      await import("@/server/actions/audit");

    const res = await getPlatformAuditLogAction({
      tenantId: OTHER_TENANT_ID,
      page: 1,
      pageSize: 25,
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data?.totalPages).toBe(1);
    }
    const filtered = prismaMock.auditLog.findMany.mock.calls.at(-1)?.[0] as
      { where: { tenantId?: string } } | undefined;
    expect(filtered?.where.tenantId).toBe(OTHER_TENANT_ID);

    // With no tenant filter the query stays open across the whole table.
    const res2 = await getPlatformAuditLogAction({ page: 1, pageSize: 25 });
    expect(res2.success).toBe(true);
    const open = prismaMock.auditLog.findMany.mock.calls.at(-1)?.[0] as
      { where: { tenantId?: string } } | undefined;
    expect(open?.where.tenantId).toBeUndefined();
  });

  it("denies a cross-tenant audit read (forged tenant id)", async () => {
    authMock.mockResolvedValueOnce({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      platformRole: null,
      status: "ACTIVE",
    } as never);
    // The actor has no membership in the requested workspace, so the tenant
    // context cannot be resolved and nothing is read.
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce(null);

    const { getAuditLogAction } = await import("@/server/actions/audit");
    const res = await getAuditLogAction({ tenantId: OTHER_TENANT_ID });

    expect(res.success).toBe(false);
    if (res.success) throw new Error("expected the action to be denied");
    expect(res.code).toBe("FORBIDDEN");
    expect(prismaMock.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("bounds the page size before authorizing", async () => {
    authMock.mockResolvedValueOnce({ id: USER_ID });

    const { getAuditLogAction } = await import("@/server/actions/audit");
    const res = await getAuditLogAction({
      tenantId: TENANT_ID,
      page: 1,
      pageSize: 5000,
    });

    expect(res.success).toBe(false);
    if (res.success) throw new Error("expected the query to be rejected");
    expect(res.code).toBe("VALIDATION_ERROR");
    // Nothing was read: an out-of-bounds query never reaches authorization.
    expect(prismaMock.auditLog.findMany).not.toHaveBeenCalled();
  });
});
