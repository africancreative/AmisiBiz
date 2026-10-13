import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlatformRole, TenantRole } from "@prisma/client";

vi.mock("@/lib/db/prisma", () => import("./prisma-mock"));
vi.mock("@/lib/auth/config", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { prismaMock } from "./prisma-mock";
import { authMock } from "./auth-mock";
import {
  requireAuth,
  TENANT_ROLE_RANK,
  hasAtLeastTenantRole,
  isPlatformAdmin,
} from "@/lib/auth/helpers";
import {
  authorizeTenant,
  authorizePlatform,
} from "@/server/auth/authorization";
import {
  PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  tenantRoleHasPermission,
  platformRoleHasPermission,
  isPlatformPermission,
} from "@/lib/auth/permissions";
import {
  updateMemberRoleAction,
  removeMemberAction,
  inviteMemberAction,
  acceptInvitationAction,
} from "@/server/actions/tenant";
import {
  suspendTenantAction,
  activateTenantAction,
  reactivateTenantAction,
} from "@/server/actions/platform";
import {
  inviteMemberSchema,
  updateMemberRoleSchema,
} from "@/lib/validations/tenant";
import { loginSchema } from "@/lib/validations/auth";
import { isSessionValid, revokeUserSessions } from "@/lib/auth/session";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID = "cktenant0000000000000001";
const OTHER_TENANT_ID = "cktenant0000000000000002";
const MEMBER_ID = "ckmember0000000000000001";
const USER_ID = "ckuser00000000000000001";

function membershipRow(
  role: TenantRole,
  status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
) {
  return { role, tenant: { status } };
}

function targetMember(role: TenantRole, tenantId = TENANT_ID) {
  return {
    id: MEMBER_ID,
    userId: "cktarget000000000000001",
    tenantId,
    role,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { resetRateLimit } = await import("@/lib/security/rate-limit");
  resetRateLimit();

  authMock.mockResolvedValue({
    user: {
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      platformRole: "USER",
      status: "ACTIVE",
    },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  });

  prismaMock.auditLog.create.mockResolvedValue({ id: "log_1" });
  prismaMock.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(prismaMock)
      : await Promise.all(arg as Promise<unknown>[]),
  );
});

// ─── Role helpers & permission policy ─────────────────────────────────────────

describe("role helpers and permission policy", () => {
  it("ranks tenant roles", () => {
    expect(TENANT_ROLE_RANK.BUSINESS_OWNER).toBeGreaterThan(
      TENANT_ROLE_RANK.BUSINESS_ADMIN,
    );
    expect(TENANT_ROLE_RANK.BUSINESS_ADMIN).toBeGreaterThan(
      TENANT_ROLE_RANK.DOCUMENT_MANAGER,
    );
    expect(TENANT_ROLE_RANK.DOCUMENT_MANAGER).toBeGreaterThan(
      TENANT_ROLE_RANK.SALES_STAFF,
    );
    expect(TENANT_ROLE_RANK.SALES_STAFF).toBeGreaterThan(
      TENANT_ROLE_RANK.VIEWER,
    );
  });

  it("hasAtLeastTenantRole compares by rank", () => {
    expect(hasAtLeastTenantRole("BUSINESS_ADMIN", "DOCUMENT_MANAGER")).toBe(
      true,
    );
    expect(hasAtLeastTenantRole("VIEWER", "BUSINESS_ADMIN")).toBe(false);
  });

  it("only PLATFORM_ADMIN is a platform admin", () => {
    expect(isPlatformAdmin("PLATFORM_ADMIN")).toBe(true);
    expect(isPlatformAdmin("PLATFORM_SUPPORT")).toBe(false);
    expect(isPlatformAdmin("USER")).toBe(false);
  });

  it("denies by default for a missing role", () => {
    expect(tenantRoleHasPermission(null, PERMISSIONS.CONTACTS_READ)).toBe(
      false,
    );
    expect(
      platformRoleHasPermission(undefined, PERMISSIONS.PLATFORM_TENANTS_READ),
    ).toBe(false);
  });

  it("keeps platform and tenant permission domains disjoint", () => {
    for (const role of Object.keys(TENANT_ROLE_PERMISSIONS) as TenantRole[]) {
      for (const permission of TENANT_ROLE_PERMISSIONS[role]) {
        expect(isPlatformPermission(permission)).toBe(false);
      }
    }
    for (const role of Object.keys(
      PLATFORM_ROLE_PERMISSIONS,
    ) as PlatformRole[]) {
      for (const permission of PLATFORM_ROLE_PERMISSIONS[role]) {
        expect(isPlatformPermission(permission)).toBe(true);
      }
    }
  });

  it("gives PLATFORM_SUPPORT no permissions", () => {
    expect(PLATFORM_ROLE_PERMISSIONS.PLATFORM_SUPPORT).toHaveLength(0);
  });

  it("only the owner may manage members", () => {
    expect(
      tenantRoleHasPermission(
        "BUSINESS_OWNER",
        PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
      ),
    ).toBe(true);
    expect(
      tenantRoleHasPermission(
        "BUSINESS_ADMIN",
        PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
      ),
    ).toBe(false);
  });
});

// ─── authorizeTenant ──────────────────────────────────────────────────────────

describe("authorizeTenant", () => {
  it("grants a permitted operation to a member", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("BUSINESS_ADMIN"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.BUSINESS_SETTINGS_UPDATE),
    ).resolves.toMatchObject({ role: "BUSINESS_ADMIN", tenantId: TENANT_ID });
  });

  it("denies a missing permission and audits the denial", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("VIEWER"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.BUSINESS_SETTINGS_UPDATE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "authz.denied" }),
      }),
    );
  });

  it("rejects forged/cross-tenant access with no membership", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);
    await expect(
      authorizeTenant(USER_ID, OTHER_TENANT_ID, PERMISSIONS.CONTACTS_READ),
    ).rejects.toMatchObject({ code: "NO_MEMBERSHIP" });
  });

  it("rejects operations on a suspended tenant", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("BUSINESS_OWNER", "SUSPENDED"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.CONTACTS_READ),
    ).rejects.toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  it("denies document issuance to a VIEWER", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("VIEWER"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.DOCUMENTS_ISSUE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows document issuance to SALES_STAFF", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("SALES_STAFF"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.DOCUMENTS_ISSUE),
    ).resolves.toMatchObject({ role: "SALES_STAFF" });
  });
});

// ─── authorizePlatform ────────────────────────────────────────────────────────

describe("authorizePlatform", () => {
  it("grants a platform permission to PLATFORM_ADMIN", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    });
    await expect(
      authorizePlatform(USER_ID, PERMISSIONS.PLATFORM_TENANTS_SUSPEND),
    ).resolves.toMatchObject({ platformRole: "PLATFORM_ADMIN" });
  });

  it("denies platform permissions to a normal USER and audits it", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "USER",
      status: "ACTIVE",
    });
    await expect(
      authorizePlatform(USER_ID, PERMISSIONS.PLATFORM_TENANTS_SUSPEND),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });

  it("does not confer tenant permissions through platform roles", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    });
    // PLATFORM_ADMIN holds no tenant permission; a tenant check still denies.
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.BUSINESS_SETTINGS_READ),
    ).rejects.toMatchObject({ code: "NO_MEMBERSHIP" });
  });
});

// ─── Unauthenticated access ───────────────────────────────────────────────────

describe("requireAuth", () => {
  it("redirects unauthenticated users", async () => {
    authMock.mockResolvedValueOnce(null);
    await expect(requireAuth("en")).rejects.toThrow("REDIRECT:/en/login");
  });
});

// ─── Tenant actions: isolation & escalation ───────────────────────────────────

describe("tenant membership actions", () => {
  it("blocks an ADMIN from changing a member's role (no manage permission)", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("BUSINESS_ADMIN"),
    );
    const result = await updateMemberRoleAction({
      memberId: MEMBER_ID,
      role: "SALES_STAFF",
      tenantId: TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.tenantMember.update).not.toHaveBeenCalled();
  });

  it("allows an OWNER to change a subordinate's role", async () => {
    prismaMock.tenantMember.findUnique.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        where.tenantId_userId
          ? Promise.resolve(membershipRow("BUSINESS_OWNER"))
          : Promise.resolve(targetMember("VIEWER")),
    );
    prismaMock.tenantMember.update.mockResolvedValue({ id: MEMBER_ID });
    prismaMock.user.update.mockResolvedValue({ id: "x" });

    const result = await updateMemberRoleAction({
      memberId: MEMBER_ID,
      role: "SALES_STAFF",
      tenantId: TENANT_ID,
    });

    expect(result.success).toBe(true);
    expect(prismaMock.tenantMember.update).toHaveBeenCalledWith({
      where: { id: MEMBER_ID },
      data: { role: "SALES_STAFF" },
    });
    // Role change revokes the target user's sessions.
    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it("rejects a target member belonging to a different tenant", async () => {
    prismaMock.tenantMember.findUnique.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        where.tenantId_userId
          ? Promise.resolve(membershipRow("BUSINESS_OWNER"))
          : Promise.resolve(targetMember("VIEWER", OTHER_TENANT_ID)),
    );
    const result = await updateMemberRoleAction({
      memberId: MEMBER_ID,
      role: "SALES_STAFF",
      tenantId: TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.tenantMember.update).not.toHaveBeenCalled();
  });

  it("blocks an OWNER from removing the last owner", async () => {
    prismaMock.tenantMember.findUnique.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        where.tenantId_userId
          ? Promise.resolve(membershipRow("BUSINESS_OWNER"))
          : Promise.resolve(targetMember("BUSINESS_OWNER")),
    );
    prismaMock.tenantMember.count.mockResolvedValue(1);
    const result = await removeMemberAction(MEMBER_ID, TENANT_ID);
    expect(result.success).toBe(false);
    expect(prismaMock.tenantMember.delete).not.toHaveBeenCalled();
  });

  it("denies inviting when the actor lacks the manage permission", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("DOCUMENT_MANAGER"),
    );
    const result = await inviteMemberAction({
      email: "peer@example.com",
      role: "SALES_STAFF",
      tenantId: TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.invitation.upsert).not.toHaveBeenCalled();
  });

  it("never lets an OWNER invite another owner (escalation blocked)", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("BUSINESS_OWNER"),
    );
    const result = await inviteMemberAction({
      email: "peer@example.com",
      role: "BUSINESS_OWNER",
      tenantId: TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.invitation.upsert).not.toHaveBeenCalled();
  });

  it("rejects accepting an invitation sent to a different email", async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({
      id: "inv_1",
      tenantId: TENANT_ID,
      email: "someone-else@example.com",
      role: "VIEWER",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const result = await acceptInvitationAction("tok");
    expect(result.success).toBe(false);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

// ─── Platform actions: unauthorized suspension ───────────────────────────────

describe("platform tenant lifecycle", () => {
  it("denies a normal user from suspending a tenant", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "USER",
      status: "ACTIVE",
    });
    const result = await suspendTenantAction({
      tenantId: TENANT_ID,
      reason: "abuse",
    });
    expect(result.success).toBe(false);
    expect(prismaMock.tenant.updateMany).not.toHaveBeenCalled();
  });

  it("requires a suspension reason", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    });
    const result = await suspendTenantAction({
      tenantId: TENANT_ID,
      reason: "",
    });
    expect(result.success).toBe(false);
    expect(prismaMock.tenant.updateMany).not.toHaveBeenCalled();
  });

  it("suspends an ACTIVE tenant with a reason (atomic transition guard)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    });
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });

    const result = await suspendTenantAction({
      tenantId: TENANT_ID,
      reason: "non-payment",
    });
    expect(result.success).toBe(true);
    expect(prismaMock.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID, status: "ACTIVE" },
        data: expect.objectContaining({
          status: "SUSPENDED",
          suspensionReason: "non-payment",
        }),
      }),
    );
  });

  it("refuses to suspend a tenant that is not ACTIVE", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    });
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 0 });
    const result = await suspendTenantAction({
      tenantId: TENANT_ID,
      reason: "reason here",
    });
    expect(result.success).toBe(false);
  });

  it("activates only a PENDING tenant", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    });
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });
    const result = await activateTenantAction(TENANT_ID);
    expect(result.success).toBe(true);
    expect(prismaMock.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TENANT_ID, status: "PENDING" } }),
    );
  });

  it("reactivates only a SUSPENDED tenant", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    });
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });
    const result = await reactivateTenantAction(TENANT_ID);
    expect(result.success).toBe(true);
    expect(prismaMock.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID, status: "SUSPENDED" },
      }),
    );
  });
});

// ─── Session validity / revocation ───────────────────────────────────────────

describe("session validity and revocation", () => {
  it("accepts an ACTIVE user with a matching version", () => {
    expect(isSessionValid({ status: "ACTIVE", sessionVersion: 3 }, 3)).toBe(
      true,
    );
  });

  it("rejects a stale (revoked) session version", () => {
    expect(isSessionValid({ status: "ACTIVE", sessionVersion: 4 }, 3)).toBe(
      false,
    );
  });

  it("rejects suspended users and missing users", () => {
    expect(isSessionValid({ status: "SUSPENDED", sessionVersion: 1 }, 1)).toBe(
      false,
    );
    expect(isSessionValid(null, 0)).toBe(false);
  });

  it("revokes sessions by incrementing the session version", async () => {
    prismaMock.user.update.mockResolvedValue({ id: USER_ID });
    await revokeUserSessions(USER_ID);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { sessionVersion: { increment: 1 } },
    });
  });
});

// ─── Registration cannot create platform admins ──────────────────────────────

describe("registerAction", () => {
  it("creates a USER platform role and an OWNER membership", async () => {
    const { registerAction } = await import("@/server/actions/auth");
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.tenant.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: USER_ID });
    prismaMock.tenant.create.mockResolvedValue({ id: TENANT_ID });
    prismaMock.tenantMember.create.mockResolvedValue({ id: "m1" });
    prismaMock.accountToken.create.mockResolvedValue({ id: "t1" });

    const result = await registerAction({
      name: "Amisi Genuine",
      email: "new@example.com",
      password: "Passw0rd1",
      confirmPassword: "Passw0rd1",
      tenantName: "Amisi Co",
    });

    expect(result.success).toBe(true);
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ platformRole: "USER" }),
      }),
    );
    expect(prismaMock.tenantMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "BUSINESS_OWNER" }),
      }),
    );
  });
});

// ─── Input validation ────────────────────────────────────────────────────────

describe("input validation", () => {
  it("inviteMemberSchema rejects the owner role", () => {
    const parsed = inviteMemberSchema.safeParse({
      email: "x@example.com",
      role: "BUSINESS_OWNER",
      tenantId: TENANT_ID,
    });
    expect(parsed.success).toBe(false);
  });

  it("updateMemberRoleSchema rejects invalid ids", () => {
    const parsed = updateMemberRoleSchema.safeParse({
      memberId: "not-a-cuid",
      role: "SALES_STAFF",
      tenantId: TENANT_ID,
    });
    expect(parsed.success).toBe(false);
  });

  it("loginSchema normalises email casing", () => {
    const parsed = loginSchema.parse({
      email: "  Owner@Example.COM ",
      password: "x",
    });
    expect(parsed.email).toBe("owner@example.com");
  });
});
