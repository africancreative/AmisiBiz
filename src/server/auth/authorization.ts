import { prisma } from "@/lib/db/prisma";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  tenantRoleHasPermission,
  platformRoleHasPermission,
  type Permission,
} from "@/lib/auth/permissions";
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
 */

export type AuthzErrorCode =
  "UNAUTHENTICATED" | "NO_MEMBERSHIP" | "TENANT_SUSPENDED" | "FORBIDDEN";

export class AuthorizationError extends Error {
  readonly code: AuthzErrorCode;

  constructor(code: AuthzErrorCode, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

export type TenantAuthzContext = {
  userId: string;
  tenantId: string;
  role: TenantRole;
  tenantStatus: TenantStatus;
};

export type PlatformAuthzContext = {
  userId: string;
  platformRole: PlatformRole;
};

// Only ACTIVE tenants are operational. Suspension must not delete data, and a
// PENDING tenant is provisioned but not yet usable. Both are denied here — the
// authoritative check that runs on every protected tenant operation.
const OPERATIONAL_TENANT_STATUS: TenantStatus = "ACTIVE";

/**
 * Resolves a tenant-scoped authorization context for an authenticated user.
 * Throws when the user is not a member, or when the tenant is not operational.
 */
export async function resolveTenantContext(
  userId: string,
  tenantId: string,
): Promise<TenantAuthzContext> {
  const membership = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: {
      role: true,
      tenant: { select: { status: true } },
    },
  });

  // No membership — covers both "belongs to another tenant" and forged ids.
  if (!membership) {
    throw new AuthorizationError(
      "NO_MEMBERSHIP",
      "You do not have access to this organisation.",
    );
  }

  if (membership.tenant.status !== OPERATIONAL_TENANT_STATUS) {
    throw new AuthorizationError(
      "TENANT_SUSPENDED",
      "This organisation's workspace is not available.",
    );
  }

  return {
    userId,
    tenantId,
    role: membership.role,
    tenantStatus: membership.tenant.status,
  };
}

/**
 * Authorizes a tenant operation: the user must be an active member of the
 * tenant AND hold the required permission. Denials are audited.
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

  return context;
}

/**
 * Authorizes a platform operation. Platform privileges are entirely separate
 * from tenant roles and are never conferred by tenant membership.
 */
export async function authorizePlatform(
  userId: string,
  permission: Permission,
): Promise<PlatformAuthzContext> {
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

  if (!platformRoleHasPermission(user.platformRole, permission)) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTHZ_DENIED,
      userId,
      metadata: {
        permission,
        platformRole: user.platformRole,
        reason: "insufficient_platform_role",
      },
    });
    throw new AuthorizationError(
      "FORBIDDEN",
      "You are not permitted to perform this action.",
    );
  }

  return { userId, platformRole: user.platformRole };
}
