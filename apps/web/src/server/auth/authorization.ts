import {
  currentScope,
  enterScope,
  prisma,
  sessionScope,
  tenantScope,
  type DbScope,
} from "@amisibiz/database";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  SUPPORT_TENANT_PERMISSIONS,
  tenantRoleHasPermission,
  platformRoleHasPermission,
  isWritePermission,
  type Permission,
} from "@amisibiz/auth";
import { touchTenantActivity } from "@/server/services/tenant-indicators";
import type { PlatformRole, TenantRole, TenantStatus } from "@prisma/client";

/**
 * Server-side authorization service.
 *
 * Rules enforced here:
 *  - The actor, tenant and role are always resolved from the database using the
 *    authenticated user id — never from browser-supplied values.
 *  - Membership is validated on EVERY protected tenant operation.
 *  - Access is denied by default when the membership, role or permission is
 *    missing (including cross-tenant / forged ids).
 *  - Platform authorization is a separate domain from tenant authorization.
 *  - Denied privileged operations are audited.
 *  - Authorization also OPENS THE RLS SCOPE. This module is the only place that
 *    decides `app.current_tenant_id` / `app.current_user_id` for a request, so
 *    a call site cannot forget it: the database then refuses rows the matrix
 *    would have refused anyway. The two layers are deliberately redundant —
 *    the matrix answers "may this role do this thing", RLS answers "even if the
 *    code is wrong later, which rows exist for you".
 */

export type AuthzErrorCode =
  "UNAUTHENTICATED" | "NO_MEMBERSHIP" | "TENANT_PENDING" | "FORBIDDEN";

export class AuthorizationError extends Error {
  readonly code: AuthzErrorCode;

  constructor(code: AuthzErrorCode, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

/** How the tenant context was earned: as a member, or under a support grant. */
export type TenantAccessVia = "membership" | "support_grant";

export type TenantAuthzContext = {
  userId: string;
  tenantId: string;
  role: TenantRole;
  tenantStatus: TenantStatus;
  /**
   * `membership` — an ordinary workspace role.
   * `support_grant` — provider support acting under an explicit, expiring
   * grant; such a context is READ-ONLY (`readonly`) by definition.
   */
  via: TenantAccessVia;
  /**
   * Reads allowed, writes refused. Two different situations land here, and the
   * denial message has to tell them apart:
   *  - a support grant, which is read-only whatever the tenant's status;
   *  - a member of a SUSPENDED workspace, whose reads, downloads and audit
   *    trail stay open while the platform has stopped their writes.
   */
  readonly: boolean;
  /** The grant behind a support context; null for members. */
  supportGrantId: string | null;
  /** Context applied to every statement run with this authorization. */
  scope: DbScope;
};

export type PlatformAuthzContext = {
  userId: string;
  platformRole: PlatformRole;
  scope: DbScope;
};

// Two non-ACTIVE statuses, two different rules, and the difference is the whole
// point of the Phase 2 suspension semantics:
//
//  - SUSPENDED is a business decision the provider takes against a workspace that
//    already has data. Its members keep reading and downloading what exists
//    (`readonly`), lose the ability to write or sync, and keep their audit trail
//    — the database expresses the same split through `app_tenant_accepts_writes`
//    and the write-aware policy family.
//  - PENDING is a workspace that has never been opened. There is nothing to read
//    yet and no session of the business to preserve, so it stays fully closed to
//    its members; provisioning writes (numbering series, the first owner seat)
//    happen through their own guarded paths, not through a tenant permission.
const READABLE_TENANT_STATUSES: readonly TenantStatus[] = [
  "ACTIVE",
  "SUSPENDED",
];
const WRITABLE_TENANT_STATUS: TenantStatus = "ACTIVE";

/**
 * Reads the actor's own platform standing from the database.
 *
 * The claims returned here are only ever advisory: `is_platform_admin()` and
 * `is_platform_support()` re-read `User.platformRole`/`User.status` inside every
 * policy, so passing `true` for a user who is not an admin buys nothing. They
 * are still derived from the row — not from the caller — so the value a request
 * carries matches what the database will conclude.
 */
async function resolvePlatformClaims(userId: string): Promise<{
  platformRole: PlatformRole | null;
  status: string;
}> {
  enterScope(sessionScope(userId));

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true, status: true },
  });

  if (!user) {
    throw new AuthorizationError(
      "UNAUTHENTICATED",
      "You must be signed in to perform this action.",
    );
  }

  return { platformRole: user.platformRole, status: user.status };
}

/**
 * Guards against acting as somebody else. `getSessionUser()` opens the request
 * scope from the verified Supabase token; every authorization call must name the
 * same user. A mismatch means the caller passed an identity that never went
 * through the trust chain, so the request is refused before any data is read.
 */
function assertActorMatchesAmbientScope(userId: string): void {
  const scope = currentScope();
  if (scope?.userId && scope.userId !== userId) {
    console.error(
      "[authz] actor/scope mismatch: authorized for",
      userId,
      "but the request scope belongs to",
      scope.userId,
    );
    throw new AuthorizationError(
      "UNAUTHENTICATED",
      "You must be signed in to perform this action.",
    );
  }
}

/**
 * Resolves a tenant-scoped authorization context for an authenticated user and
 * makes it the ambient scope for the rest of the request.
 *
 * Two ways in: an active membership, or — for the read-only permission set — an
 * active support grant. Nobody else gets this context, and the tenant id is
 * never accepted on trust: the `TenantMember` lookup runs under RLS, so a forged
 * id for another workspace simply finds no row.
 */
export async function resolveTenantContext(
  userId: string,
  tenantId: string,
): Promise<TenantAuthzContext> {
  assertActorMatchesAmbientScope(userId);
  enterScope(sessionScope(userId));

  const membership = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: {
      role: true,
      tenant: { select: { status: true } },
    },
  });

  if (membership) {
    if (!READABLE_TENANT_STATUSES.includes(membership.tenant.status)) {
      throw new AuthorizationError(
        "TENANT_PENDING",
        "This organisation's workspace is not available.",
      );
    }

    const claims = await resolvePlatformClaims(userId);
    const scope = tenantScope(userId, tenantId, membership.role, {
      isPlatformAdmin: claims.platformRole === "SUPER_ADMIN",
      isPlatformSupport: claims.platformRole === "SUPPORT",
    });
    enterScope(scope);

    // A member of a suspended workspace is authorized for reads and refused
    // every write; a platform admin in the same request keeps full provider
    // authority, because `isPlatformAdmin` travels in the scope and the policies
    // re-read it — suspension stops the tenant's own writes, never the
    // provider's ability to run the workspace back.
    const suspended = membership.tenant.status !== WRITABLE_TENANT_STATUS;

    return {
      userId,
      tenantId,
      role: membership.role,
      tenantStatus: membership.tenant.status,
      via: "membership",
      readonly: suspended && !scope.isPlatformAdmin,
      supportGrantId: null,
      scope,
    };
  }

  // No membership: the only remaining door is an explicit support grant. It is
  // looked up from the grant table — never from a claim — and refuses anything
  // but the read-only set (the caller checks the permission below).
  const grant = await prisma.supportAccessGrant.findFirst({
    where: {
      tenantId,
      platformUserId: userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      tenant: { select: { status: true } },
      platformUser: { select: { status: true, platformRole: true } },
    },
  });

  const holder = grant?.platformUser;
  if (
    !grant ||
    !holder ||
    holder.status !== "ACTIVE" ||
    holder.platformRole !== "SUPPORT"
  ) {
    throw new AuthorizationError(
      "NO_MEMBERSHIP",
      "You do not have access to this organisation.",
    );
  }

  // Support may keep reading a suspended workspace: the grant confers reads only,
  // and a provider diagnosing why a business is offline needs to see what is
  // there. A PENDING workspace has no such record to diagnose, so it stays closed.
  if (!READABLE_TENANT_STATUSES.includes(grant.tenant.status)) {
    throw new AuthorizationError(
      "TENANT_PENDING",
      "This organisation's workspace is not available.",
    );
  }

  const scope = tenantScope(userId, tenantId, null, {
    isPlatformSupport: true,
  });
  enterScope(scope);

  return {
    userId,
    tenantId,
    // The matrix is not consulted for support contexts: SUPPORT_TENANT_PERMISSIONS
    // is the whole of what a grant confers. The role is reported as VIEWER so
    // logging and UI have something truthful to show ("read-only here"), while
    // `via` and `readonly` carry the actual basis of the access.
    role: "VIEWER",
    tenantStatus: grant.tenant.status,
    via: "support_grant",
    readonly: true,
    supportGrantId: grant.id,
    scope,
  };
}

/**
 * Authorizes a tenant operation: the user must be an active member of the
 * tenant AND hold the required permission. Denials are audited.
 *
 * A provider-support context is authorized only for the read-only grant set, and
 * every use of it is audited (`support.accessUsed`) with the grant id.
 *
 * The write gate at the end is what makes suspension mean something in the
 * application rather than only in the database: a permission that changes state
 * (`isWritePermission`) cannot be exercised with a read-only context, and a
 * permission that only reads can. Both refusals are audited, and an authorized
 * write stamps the workspace's activity indicator on the way through.
 */
export async function authorizeTenant(
  userId: string,
  tenantId: string,
  permission: Permission,
): Promise<TenantAuthzContext> {
  let context: TenantAuthzContext;
  try {
    context = await resolveTenantContext(userId, tenantId);
  } catch (err) {
    if (err instanceof AuthorizationError && err.code === "NO_MEMBERSHIP") {
      await recordAudit({
        action: AUDIT_ACTIONS.AUTHZ_DENIED,
        userId,
        tenantId,
        metadata: { permission, reason: "no_membership" },
      });
    }
    throw err;
  }

  if (context.via === "support_grant") {
    if (!SUPPORT_TENANT_PERMISSIONS.includes(permission)) {
      await recordAudit({
        action: AUDIT_ACTIONS.SUPPORT_ACCESS_DENIED,
        userId,
        tenantId,
        metadata: { permission, reason: "permission_outside_grant" },
      });
      throw new AuthorizationError(
        "FORBIDDEN",
        "You are not permitted to perform this action.",
      );
    }

    // Each privileged read is recorded: who, which tenant, which grant, what.
    await recordAudit({
      action: AUDIT_ACTIONS.SUPPORT_ACCESS_USED,
      userId,
      tenantId,
      resource: "SupportAccessGrant",
      resourceId: context.supportGrantId,
      metadata: { permission },
    });
    return context;
  }

  if (!tenantRoleHasPermission(context.role, permission)) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTHZ_DENIED,
      userId,
      tenantId,
      metadata: { permission, role: context.role, reason: "insufficient_role" },
    });
    throw new AuthorizationError(
      "FORBIDDEN",
      "You are not permitted to perform this action.",
    );
  }

  if (isWritePermission(permission)) {
    await assertWritableContext(context, permission);
    await touchTenantActivity(context.tenantId);
  }

  return context;
}

/**
 * Refuses a write attempted with a read-only context.
 *
 * The database already refuses it — `has_tenant_write_access()` has no support
 * branch, and the write-aware family gates a suspended workspace's members — but
 * failing here gives the user a clear message instead of a policy violation,
 * keeps the refusal visible in the application layer too, and records which of
 * the two read-only situations it was. A denial without an audit row is a
 * suspension nobody can see.
 *
 * The audit is AWAITED before the error is thrown, deliberately: a denial that
 * is written only in the suspended request's microtask queue is a denial that
 * may never reach the database, and the console's whole account of "this device
 * tried to write while suspended" depends on that row existing.
 */
export async function assertWritableContext(
  context: TenantAuthzContext,
  permission?: Permission,
): Promise<void> {
  if (!context.readonly) return;

  const metadata = {
    ...(permission ? { permission } : {}),
    tenantStatus: context.tenantStatus,
    ...(context.via === "support_grant"
      ? { reason: "write_with_support_grant" }
      : { reason: "tenant_suspended" }),
  };

  await recordAudit({
    action:
      context.via === "support_grant"
        ? AUDIT_ACTIONS.SUPPORT_ACCESS_DENIED
        : AUDIT_ACTIONS.TENANT_WRITE_DENIED,
    userId: context.userId,
    tenantId: context.tenantId,
    resource: "Tenant",
    resourceId: context.tenantId,
    metadata,
  });

  throw new AuthorizationError(
    "FORBIDDEN",
    context.via === "support_grant"
      ? "Support access is read-only."
      : "This workspace is suspended. Existing records stay available to view and download, but changes and synchronization are paused until Amisi Genuine reactivates it.",
  );
}

/**
 * Authorizes a platform operation. Platform privileges are entirely separate
 * from tenant roles and are never conferred by tenant membership.
 */
export async function authorizePlatform(
  userId: string,
  permission: Permission,
): Promise<PlatformAuthzContext> {
  assertActorMatchesAmbientScope(userId);
  enterScope(sessionScope(userId));

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true, status: true },
  });

  if (!user || user.status !== "ACTIVE") {
    throw new AuthorizationError(
      "UNAUTHENTICATED",
      "You must be signed in to perform this action.",
    );
  }

  // platformRole is nullable by design: an ordinary business user holds no
  // platform role at all, and the deny-by-default check rejects null.
  const platformRole = user.platformRole;

  if (!platformRole || !platformRoleHasPermission(platformRole, permission)) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTHZ_DENIED,
      userId,
      metadata: {
        permission,
        platformRole: platformRole ?? null,
        reason: "insufficient_platform_role",
      },
    });
    throw new AuthorizationError(
      "FORBIDDEN",
      "You are not permitted to perform this action.",
    );
  }

  // No tenant id: platform authority comes from `is_platform_admin()`, which
  // reads the actor's row, not from a claimed workspace.
  const scope = sessionScope(userId, {
    isPlatformAdmin: platformRole === "SUPER_ADMIN",
    isPlatformSupport: platformRole === "SUPPORT",
  });
  enterScope(scope);

  return { userId, platformRole, scope };
}

/**
 * Authorizes a platform action that targets one specific tenant (activation,
 * suspension, a support grant) and scopes the request to that tenant.
 *
 * The tenant id still has to resolve to a real tenant the actor can see, so this
 * cannot be used to plant a context around an arbitrary uuid: platform admins
 * can address every tenant by design, and that is precisely why the permission
 * check above runs first and the transition guards run in the database.
 */
export async function authorizePlatformTenant(
  userId: string,
  tenantId: string,
  permission: Permission,
): Promise<PlatformAuthzContext & { tenantId: string }> {
  const platform = await authorizePlatform(userId, permission);
  const scope = tenantScope(userId, tenantId, null, {
    isPlatformAdmin: platform.platformRole === "SUPER_ADMIN",
  });
  enterScope(scope);
  return { ...platform, tenantId, scope };
}
