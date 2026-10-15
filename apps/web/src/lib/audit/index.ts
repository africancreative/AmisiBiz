import {
  bootstrapScope,
  currentScope,
  runInScope,
  type ScopedTx,
} from "@amisibiz/database";
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
  // Phase 04 — business branding, contacts CRM and catalogue. Metadata for
  // these events records field names and ids only, never PII or prices.
  BRANDING_UPDATED: "branding.updated",
  BRANDING_LOGO_UPLOADED: "branding.logoUploaded",
  BRANDING_LOGO_DELETED: "branding.logoDeleted",
  CONTACT_CREATED: "contact.created",
  CONTACT_UPDATED: "contact.updated",
  CONTACT_ARCHIVED: "contact.archived",
  CONTACT_RESTORED: "contact.restored",
  TAX_CATEGORY_CREATED: "taxCategory.created",
  TAX_CATEGORY_UPDATED: "taxCategory.updated",
  TAX_CATEGORY_DELETED: "taxCategory.deleted",
  ITEM_CREATED: "item.created",
  ITEM_UPDATED: "item.updated",
  ITEM_DELETED: "item.deleted",
  CONTACT_ITEM_CREATED: "contactItem.created",
  CONTACT_ITEM_UPDATED: "contactItem.updated",
  CONTACT_ITEM_REMOVED: "contactItem.removed",
  // Phase 05 — the document engine. A document is not edited after issuance;
  // these events record lifecycle *facts* (an issue, a void, a payment) rather
  // than field edits, which is the same distinction the audit trail draws for
  // payments: recording a payment is an event, setting a status is not.
  DOCUMENT_CREATED: "document.created",
  DOCUMENT_UPDATED: "document.updated",
  DOCUMENT_ISSUED: "document.issued",
  DOCUMENT_VOIDED: "document.voided",
  DOCUMENT_QUOTATION_ACCEPTED: "document.quotationAccepted",
  DOCUMENT_QUOTATION_REJECTED: "document.quotationRejected",
  DOCUMENT_QUOTATION_EXPIRED: "document.quotationExpired",
  DOCUMENT_QUOTATION_CANCELLED: "document.quotationCancelled",
  DOCUMENT_CONVERTED: "document.converted",
  DOCUMENT_PAYMENT_RECORDED: "document.paymentRecorded",
  DOCUMENT_PAYMENT_REVERSED: "document.paymentReversed",
  DOCUMENT_DELIVERY_RECORDED: "document.deliveryRecorded",
  DOCUMENT_DELIVERED: "document.delivered",
  DOCUMENT_DOWNLOADED: "document.downloaded",
  DOCUMENT_PORTAL_LINKED: "document.portalLinked",
  DOCUMENT_PORTAL_DOWNLOADED: "document.portalDownloaded",
  // Phase 1 — provider support access. Every one of these events is a complete
  // record of a privileged read: granting, revoking, and each USE of a grant.
  // Metadata carries the grant id, the reason and durations only — never the
  // tenant's business data (constitution: no PII in logs).
  SUPPORT_ACCESS_GRANTED: "support.accessGranted",
  SUPPORT_ACCESS_REVOKED: "support.accessRevoked",
  SUPPORT_ACCESS_USED: "support.accessUsed",
  SUPPORT_ACCESS_DENIED: "support.accessDenied",
  // Phase 2 — provider administration. `tenant.writeDenied` and `sync.rejected`
  // are the two events that make suspension observable: they are recorded when a
  // suspended workspace (or a device acting for one) presents an operation the
  // platform has taken offline, which is also the only evidence an operator has
  // that an offline client is still holding cached data.
  TENANT_WRITE_DENIED: "tenant.writeDenied",
  SYNC_REJECTED: "sync.rejected",
  PLATFORM_TENANT_UPDATED: "platform.tenantUpdated",
  PLATFORM_TENANT_PLAN_ASSIGNED: "platform.tenantPlanAssigned",
  PLATFORM_TENANT_BRANDING_UPDATED: "platform.tenantBrandingUpdated",
  PLATFORM_TENANT_NUMBERING_UPDATED: "platform.tenantNumberingUpdated",
  PLATFORM_TENANT_DOMAIN_UPDATED: "platform.tenantDomainUpdated",
  PLATFORM_TENANT_OWNER_ASSIGNED: "platform.tenantOwnerAssigned",
  PLATFORM_TENANT_LOGO_UPLOADED: "platform.tenantLogoUploaded",
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
 * Append one audit row, in the caller's transaction when one is open.
 *
 * This is a raw INSERT, not `prisma.auditLog.create`, and the difference
 * matters under RLS: an ORM create emits `INSERT … RETURNING`, and the RETURNING
 * read is filtered by the table's SELECT policy — which admits owner/admin and
 * granted support only. A viewer's denied action, a registration, or an
 * authorization denial against a forged tenant id would then fail (or silently
 * vanish) precisely when the audit trail is most needed. The INSERT policy is
 * `WITH CHECK (true)`: every context may append, no context may rewrite, and
 * nothing is ever read back.
 */
export async function appendAuditLog(
  tx: ScopedTx,
  event: AuditEvent,
): Promise<void> {
  const metadata = sanitize(event.metadata);
  // Serialise the SANITIZED value: persisting `event.metadata` here would write
  // the raw payload — including any `password`/`token`/`secret` key — straight
  // into the audit trail, which is exactly what `sanitize` exists to prevent.
  const json = metadata === undefined ? null : JSON.stringify(metadata);

  await tx.$executeRaw`
    INSERT INTO "AuditLog" (
      "tenantId", "userId", "action", "resource", "resourceId",
      "metadata", "ipAddress", "userAgent"
    ) VALUES (
      nullif(${event.tenantId ?? ""}::text, '')::uuid,
      nullif(${event.userId ?? ""}::text, '')::uuid,
      ${event.action},
      nullif(${event.resource ?? ""}::text, ''),
      nullif(${event.resourceId ?? ""}::text, ''),
      nullif(${json ?? ""}::text, '')::jsonb,
      nullif(${event.ipAddress ?? ""}::text, ''),
      nullif(${event.userAgent ?? ""}::text, '')
    )`;
}

/**
 * Writes an audit log entry against the ambient request scope. Audit logging
 * must never break the calling operation: failures are swallowed and reported
 * server-side only.
 *
 * Denial audits routinely run *before* any tenant context exists (that is the
 * whole point — an unauthorized caller has no scope), so a bootstrap scope is
 * used when none is ambient. That is safe for this one statement: the audit
 * table grants INSERT unconditionally and reads nothing back.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  const scope = currentScope() ?? bootstrapScope();
  try {
    await runInScope(scope, (tx) => appendAuditLog(tx, event));
  } catch (err) {
    console.error("[audit] Failed to record event:", event.action, err);
  }
}

/** Re-exported for call sites that build typed audit payloads. */
export type AuditMetadata = Prisma.InputJsonValue;
