import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

/**
 * Canonical audit action names. Keep these stable — they are queried by the
 * audit viewer and by security monitoring. Never rename an existing value.
 */
export const AUDIT_ACTIONS = {
  AUTH_SIGN_IN: "auth.signIn",
  AUTH_SIGN_OUT: "auth.signOut",
  AUTH_SIGN_IN_FAILED: "auth.signInFailed",
  AUTH_LOGIN_RATE_LIMITED: "auth.loginRateLimited",
  AUTH_REGISTER: "auth.register",
  AUTH_PASSWORD_RESET_REQUESTED: "auth.passwordResetRequested",
  AUTH_PASSWORD_RESET: "auth.passwordReset",
  AUTH_EMAIL_VERIFIED: "auth.emailVerified",
  AUTHZ_DENIED: "authz.denied",
  TENANT_CREATED: "tenant.created",
  TENANT_UPDATED: "tenant.updated",
  TENANT_INVITED: "team.invited",
  TENANT_ROLE_UPDATED: "team.roleUpdated",
  TENANT_MEMBER_REMOVED: "team.memberRemoved",
  TENANT_INVITATION_ACCEPTED: "team.invitationAccepted",
  PLATFORM_TENANT_SUSPENDED: "platform.tenantSuspended",
  PLATFORM_TENANT_ACTIVATED: "platform.tenantActivated",
  PLATFORM_TENANT_REACTIVATED: "platform.tenantReactivated",
  PLATFORM_TENANT_OWNER_INVITED: "platform.tenantOwnerInvited",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditEvent = {
  action: string;
  tenantId?: string | null;
  userId?: string | null;
  resource?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const SENSITIVE_KEYS = [
  "password",
  "token",
  "tokenhash",
  "secret",
  "authorization",
  "cookie",
];

/**
 * Strips obvious secrets from audit metadata so credentials are never
 * persisted in the audit log.
 */
function sanitize(
  metadata: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!metadata) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s))) continue;
    clean[key] = value;
  }
  return clean as Prisma.InputJsonValue;
}

/**
 * Writes an audit log entry. Audit logging must never break the calling
 * operation: failures are swallowed and reported server-side only.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    action: event.action,
    tenantId: event.tenantId ?? null,
    userId: event.userId ?? null,
    resource: event.resource ?? null,
    resourceId: event.resourceId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
  };

  const metadata = sanitize(event.metadata);
  if (metadata !== undefined) {
    data.metadata = metadata;
  }

  try {
    await prisma.auditLog.create({ data });
  } catch (err) {
    console.error("[audit] Failed to record event:", event.action, err);
  }
}
