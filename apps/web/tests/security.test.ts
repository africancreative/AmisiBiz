import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlatformRole, TenantRole, TenantStatus } from "@prisma/client";

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("@/lib/supabase/server", () => import("./supabase-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { prismaMock, auditedActions, auditsFor } from "./prisma-mock";
import { authMock, getSessionUser } from "./auth-mock";
import {
  supabaseAdminMock,
  supabaseServerMock,
  resetSupabaseMocks,
} from "./supabase-mock";
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
} from "@amisibiz/auth";
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

// Identity columns are `uuid` since the Phase 1 migration, so fixtures are
// UUID-shaped: a malformed id is a validation failure, and these suites prove
// authorization behaviour, not id parsing.
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_USER_ID = "55555555-5555-4555-8555-555555555555";

function membershipRow(role: TenantRole, status: TenantStatus = "ACTIVE") {
  return { role, tenant: { status } };
}

function targetMember(role: TenantRole, tenantId = TENANT_ID) {
  return {
    id: MEMBER_ID,
    userId: TARGET_USER_ID,
    tenantId,
    role,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetSupabaseMocks();
  const { resetRateLimit } = await import("@/lib/security/rate-limit");
  resetRateLimit();

  authMock.mockResolvedValue({
    id: USER_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: null,
    status: "ACTIVE",
  });

  // Resolve the session the way every production entry point does: a Server
  // Action or guard calls `getSessionUser()` first, and that is what opens the
  // request's RLS scope. Authorization refuses an actor whose session was never
  // resolved in this request, so the suite establishes it here too.
  await getSessionUser();

  // Authorization always re-reads the actor's platform standing from the `User`
  // row (`resolvePlatformClaims`), never from the token. The default profile is
  // an ordinary ACTIVE business user; the platform cases below override it.
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
});

// ─── Role helpers & permission policy ─────────────────────────────────────────

describe("role helpers and permission policy", () => {
  it("ranks tenant roles", () => {
    expect(TENANT_ROLE_RANK.TENANT_OWNER).toBeGreaterThan(
      TENANT_ROLE_RANK.TENANT_ADMIN,
    );
    expect(TENANT_ROLE_RANK.TENANT_ADMIN).toBeGreaterThan(
      TENANT_ROLE_RANK.SALES,
    );
    // SALES / FINANCE / OPERATIONS are peers: the matrix treats them as equals
    // and the delegation guards must not rank one over another.
    expect(TENANT_ROLE_RANK.SALES).toBe(TENANT_ROLE_RANK.FINANCE);
    expect(TENANT_ROLE_RANK.FINANCE).toBe(TENANT_ROLE_RANK.OPERATIONS);
    expect(TENANT_ROLE_RANK.SALES).toBeGreaterThan(TENANT_ROLE_RANK.VIEWER);
    expect(TENANT_ROLE_RANK.VIEWER).toBeGreaterThan(
      TENANT_ROLE_RANK.CUSTOMER_PORTAL_USER,
    );
  });

  it("hasAtLeastTenantRole compares by rank", () => {
    expect(hasAtLeastTenantRole("TENANT_ADMIN", "FINANCE")).toBe(true);
    expect(hasAtLeastTenantRole("FINANCE", "SALES")).toBe(true);
    expect(hasAtLeastTenantRole("VIEWER", "TENANT_ADMIN")).toBe(false);
  });

  it("only SUPER_ADMIN is a platform admin", () => {
    expect(isPlatformAdmin("SUPER_ADMIN")).toBe(true);
    expect(isPlatformAdmin("SUPPORT")).toBe(false);
    // An ordinary business user holds no platform role at all.
    expect(isPlatformAdmin(null)).toBe(false);
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

  it("gives SUPPORT no permissions", () => {
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT).toHaveLength(0);
  });

  it("only owner-side roles may manage members", () => {
    expect(
      tenantRoleHasPermission(
        "TENANT_OWNER",
        PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
      ),
    ).toBe(true);
    // tenant_admin carries the day-to-day management duty in the Phase 1 matrix.
    expect(
      tenantRoleHasPermission(
        "TENANT_ADMIN",
        PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
      ),
    ).toBe(true);
    // The working roles never do: no business role below admin can add people.
    for (const role of ["SALES", "FINANCE", "OPERATIONS", "VIEWER"] as const) {
      expect(
        tenantRoleHasPermission(role, PERMISSIONS.BUSINESS_MEMBERS_MANAGE),
      ).toBe(false);
    }
  });
});

// ─── authorizeTenant ──────────────────────────────────────────────────────────

describe("authorizeTenant", () => {
  it("grants a permitted operation to a member", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_ADMIN"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.BUSINESS_SETTINGS_UPDATE),
    ).resolves.toMatchObject({ role: "TENANT_ADMIN", tenantId: TENANT_ID });
  });

  it("denies a missing permission and audits the denial", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("VIEWER"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.BUSINESS_SETTINGS_UPDATE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(auditedActions()).toContain("authz.denied");
  });

  it("rejects forged/cross-tenant access with no membership", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);
    await expect(
      authorizeTenant(USER_ID, OTHER_TENANT_ID, PERMISSIONS.CONTACTS_READ),
    ).rejects.toMatchObject({ code: "NO_MEMBERSHIP" });
  });

  it("lets a suspended member read but refuses every write", async () => {
    // Phase 2 semantics: suspension pauses a workspace's writes and
    // synchronization, and deliberately keeps its records readable and
    // downloadable. The refusal is a read-only context plus an audited write
    // denial — not a locked door, because the business still has to be able to
    // read its own issued documents.
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_OWNER", "SUSPENDED"),
    );

    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.CONTACTS_READ),
    ).resolves.toMatchObject({
      via: "membership",
      readonly: true,
      tenantStatus: "SUSPENDED",
    });

    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.CONTACTS_CREATE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(auditedActions()).toContain("tenant.writeDenied");
  });

  it("keeps a PENDING workspace closed", async () => {
    // PENDING is not "suspended but readable": nothing was ever opened, so there
    // is no workspace to show. Only activation changes that.
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_OWNER", "PENDING"),
    );

    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.CONTACTS_READ),
    ).rejects.toMatchObject({ code: "TENANT_PENDING" });
  });

  it("keeps provider authority over a suspended workspace unimpaired", async () => {
    // The operator who suspended a workspace must still be able to read and fix
    // it; `has_tenant_*_write_access()` keeps its platform-admin branch for
    // exactly that reason.
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_OWNER", "SUSPENDED"),
    );
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.CONTACTS_UPDATE),
    ).resolves.toMatchObject({ readonly: false, via: "membership" });
  });

  it("denies document issuance to a VIEWER", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("VIEWER"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.INVOICES_ISSUE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows quotation issuance to SALES", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("SALES"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.QUOTATIONS_ISSUE),
    ).resolves.toMatchObject({ role: "SALES" });
  });

  it("keeps invoice issuance out of the sales domain", async () => {
    // Issuing a quotation is selling; issuing an invoice is finance. The Phase 1
    // matrix separates them so no single working role both promises and demands
    // payment, and the requirement "a viewer cannot issue documents" is only
    // meaningful if issuance is not quietly granted to everybody who can write.
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("SALES"),
    );
    await expect(
      authorizeTenant(USER_ID, TENANT_ID, PERMISSIONS.INVOICES_ISSUE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── authorizePlatform ────────────────────────────────────────────────────────

describe("authorizePlatform", () => {
  it("grants a platform permission to SUPER_ADMIN", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    });
    await expect(
      authorizePlatform(USER_ID, PERMISSIONS.PLATFORM_TENANTS_SUSPEND),
    ).resolves.toMatchObject({ platformRole: "SUPER_ADMIN" });
  });

  it("denies platform permissions to a normal USER and audits it", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: null,
      status: "ACTIVE",
    });
    await expect(
      authorizePlatform(USER_ID, PERMISSIONS.PLATFORM_TENANTS_SUSPEND),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(auditedActions()).toContain("authz.denied");
  });

  it("does not confer tenant permissions through platform roles", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    });
    // SUPER_ADMIN holds no tenant permission; a tenant check still denies.
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
  it("blocks a role without the manage permission from changing a member", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("SALES"),
    );
    const result = await updateMemberRoleAction({
      memberId: MEMBER_ID,
      role: "SALES",
      tenantId: TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.tenantMember.update).not.toHaveBeenCalled();
  });

  it("allows an OWNER to change a subordinate's role", async () => {
    prismaMock.tenantMember.findUnique.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        where.tenantId_userId
          ? Promise.resolve(membershipRow("TENANT_OWNER"))
          : Promise.resolve(targetMember("VIEWER")),
    );
    prismaMock.tenantMember.update.mockResolvedValue({ id: MEMBER_ID });
    prismaMock.user.update.mockResolvedValue({ id: "x" });

    const result = await updateMemberRoleAction({
      memberId: MEMBER_ID,
      role: "SALES",
      tenantId: TENANT_ID,
    });

    expect(result.success).toBe(true);
    expect(prismaMock.tenantMember.update).toHaveBeenCalledWith({
      where: { id: MEMBER_ID },
      data: { role: "SALES" },
    });
    // Role change revokes the target user's sessions.
    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it("rejects a target member belonging to a different tenant", async () => {
    prismaMock.tenantMember.findUnique.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        where.tenantId_userId
          ? Promise.resolve(membershipRow("TENANT_OWNER"))
          : Promise.resolve(targetMember("VIEWER", OTHER_TENANT_ID)),
    );
    const result = await updateMemberRoleAction({
      memberId: MEMBER_ID,
      role: "SALES",
      tenantId: TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.tenantMember.update).not.toHaveBeenCalled();
  });

  it("blocks an OWNER from removing the last owner", async () => {
    prismaMock.tenantMember.findUnique.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        where.tenantId_userId
          ? Promise.resolve(membershipRow("TENANT_OWNER"))
          : Promise.resolve(targetMember("TENANT_OWNER")),
    );
    prismaMock.tenantMember.count.mockResolvedValue(1);
    const result = await removeMemberAction(MEMBER_ID, TENANT_ID);
    expect(result.success).toBe(false);
    expect(prismaMock.tenantMember.delete).not.toHaveBeenCalled();
  });

  it("denies inviting when the actor lacks the manage permission", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("FINANCE"),
    );
    const result = await inviteMemberAction({
      email: "peer@example.com",
      role: "SALES",
      tenantId: TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.invitation.upsert).not.toHaveBeenCalled();
  });

  it("never lets an OWNER invite another owner (escalation blocked)", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(
      membershipRow("TENANT_OWNER"),
    );
    const result = await inviteMemberAction({
      email: "peer@example.com",
      role: "TENANT_OWNER",
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
      platformRole: null,
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
      platformRole: "SUPER_ADMIN",
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
      platformRole: "SUPER_ADMIN",
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
      platformRole: "SUPER_ADMIN",
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
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    });
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });
    const result = await activateTenantAction({
      tenantId: TENANT_ID,
      reason: "Contract signed, onboarding complete",
    });
    expect(result.success).toBe(true);
    expect(prismaMock.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TENANT_ID, status: "PENDING" } }),
    );
  });

  it("requires a reason for activation and reactivation too", async () => {
    // Phase 2 rule: every transition is explained. A history that only records
    // why a workspace was suspended leaves the other half of the trail blank.
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    for (const action of [activateTenantAction, reactivateTenantAction]) {
      await expect(action({ tenantId: TENANT_ID })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("reason"),
      });
      await expect(
        action({ tenantId: TENANT_ID, reason: "  " }),
      ).resolves.toMatchObject({ success: false });
    }

    expect(prismaMock.tenant.updateMany).not.toHaveBeenCalled();
  });

  it("reactivates only a SUSPENDED tenant", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    });
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });
    const result = await reactivateTenantAction({
      tenantId: TENANT_ID,
      reason: "Payment arrangement settled, manual reactivation",
    });
    expect(result.success).toBe(true);
    expect(prismaMock.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID, status: "SUSPENDED" },
      }),
    );
  });

  it("refuses a transition the console cannot reach", async () => {
    // The table in `tenant-lifecycle.ts` is the whole of what exists: there is no
    // PENDING → SUSPENDED and no SUSPENDED → PENDING button to press, and no
    // automatic suspension anywhere. A payload naming one is refused rather than
    // silently mapped onto a neighbouring transition.
    const { TENANT_STATUS_TRANSITIONS } =
      await import("@/server/services/tenant-lifecycle");

    expect(
      TENANT_STATUS_TRANSITIONS.map((transition) =>
        [transition.fromStatus, transition.toStatus].join("→"),
      ),
    ).toEqual(["PENDING→ACTIVE", "ACTIVE→SUSPENDED", "SUSPENDED→ACTIVE"]);
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

  it("revokes sessions: bumps the version, kills GoTrue sessions, syncs the claim", async () => {
    prismaMock.user.update.mockResolvedValue({ sessionVersion: 4 });
    await revokeUserSessions(USER_ID);

    // 1. Authoritative database bump (fail-closed for our server).
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });

    // 2. GoTrue session kill: 1-second ban followed by an immediate unban.
    expect(supabaseAdminMock.auth.admin.updateUserById).toHaveBeenCalledWith(
      USER_ID,
      { ban_duration: "1s" },
    );
    expect(supabaseAdminMock.auth.admin.updateUserById).toHaveBeenCalledWith(
      USER_ID,
      { ban_duration: "none" },
    );

    // 3. Claim sync so future tokens carry the new version.
    expect(supabaseAdminMock.auth.admin.updateUserById).toHaveBeenCalledWith(
      USER_ID,
      { app_metadata: { amisibiz_session_version: 4 } },
    );
  });
});

// ─── Registration cannot create platform admins ──────────────────────────────

describe("registerAction", () => {
  it("creates a profile with no platform role and an OWNER membership", async () => {
    const { registerAction } = await import("@/server/actions/auth");
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.tenant.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: USER_ID });
    prismaMock.tenant.create.mockResolvedValue({
      id: TENANT_ID,
      slug: "amisi-co",
    });
    prismaMock.tenantMember.create.mockResolvedValue({ id: "m1" });
    supabaseServerMock.auth.signUp.mockResolvedValue({
      data: {
        user: { id: USER_ID, identities: [{ id: "ident_1" }] },
        session: { access_token: "test-access-token" },
      },
      error: null,
    });

    const result = await registerAction({
      name: "Amisi Genuine",
      email: "new@example.com",
      password: "Passw0rd1",
      confirmPassword: "Passw0rd1",
      tenantName: "Amisi Co",
    });

    expect(result.success).toBe(true);

    const createdUser = (
      prismaMock.user.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    // The app profile mirrors the Supabase Auth user id — never a
    // client-supplied value.
    expect(createdUser.id).toBe(USER_ID);
    // `User.platformRole` is nullable with no default, so omitting it is what
    // "no platform privileges" means. Self-registration must never be able to
    // mint a SUPER_ADMIN, by writing one or by leaving one out of the shape.
    expect(createdUser.platformRole ?? null).toBeNull();

    expect(prismaMock.tenantMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "TENANT_OWNER" }),
      }),
    );
  });
});

// ─── Audit hygiene ───────────────────────────────────────────────────────────

describe("audit metadata sanitization", () => {
  it("never persists a credential-shaped key, even when a caller supplies one", async () => {
    const { recordAudit, AUDIT_ACTIONS } = await import("@/lib/audit");

    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
      tenantId: TENANT_ID,
      metadata: {
        reason: "invalid_credentials",
        attempts: 2,
        password: "hunter2-but-not-really",
        currentPassword: "also-a-secret",
        tokenHash: "a665a45920422f9d417e4867efdc4fb8",
        secret: "sb_secret_placeholder",
        authorization: "Bearer eyJhbGciOi...",
        cookie: "sb-access-token=...",
      },
    });

    const [row] = auditsFor(AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED);
    // Fail loudly rather than reporting a pass against an `undefined` row: the
    // assertions below only mean something if the event was actually written.
    if (!row) throw new Error("no auth.signInFailed audit row was recorded");

    // The audit trail is read by humans and retained indefinitely: it may carry
    // WHY something happened, never a credential. `sanitize()` is the only thing
    // between a sloppy caller and a stored secret, so it is asserted here rather
    // than trusted — and the serialized row is checked as well as the key list,
    // because the value is what leaks.
    expect(Object.keys(row.metadata)).toEqual(["reason", "attempts"]);
    expect(JSON.stringify(row)).not.toMatch(
      /hunter2|also-a-secret|a665a459|sb_secret|Bearer ey|sb-access-token/,
    );
    expect(row.tenantId).toBe(TENANT_ID);
  });

  it("records an event with no metadata at all as SQL NULL, not as the string 'null'", async () => {
    const { recordAudit, AUDIT_ACTIONS } = await import("@/lib/audit");

    await recordAudit({ action: AUDIT_ACTIONS.AUTH_SIGN_IN, userId: USER_ID });

    const [row] = auditsFor(AUDIT_ACTIONS.AUTH_SIGN_IN);
    if (!row) throw new Error("no auth.signIn audit row was recorded");
    expect(row.metadata).toEqual({});
    expect(row.userId).toBe(USER_ID);
    expect(row.tenantId).toBeNull();
  });
});

// ─── Input validation ────────────────────────────────────────────────────────

describe("input validation", () => {
  it("inviteMemberSchema rejects the owner role", () => {
    const parsed = inviteMemberSchema.safeParse({
      email: "x@example.com",
      role: "TENANT_OWNER",
      tenantId: TENANT_ID,
    });
    expect(parsed.success).toBe(false);
  });

  it("updateMemberRoleSchema rejects invalid ids", () => {
    const parsed = updateMemberRoleSchema.safeParse({
      memberId: "not-a-cuid",
      role: "SALES",
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
