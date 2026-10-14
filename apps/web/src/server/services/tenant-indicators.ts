import { prisma } from "@amisibiz/database";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Operational indicators and the synchronization answer.
 *
 * Both of the columns the provider console shows — "last activity" and "last
 * synchronization attempt" — are written here, through the two SECURITY DEFINER
 * functions the database exposes for exactly this purpose
 * (`touch_tenant_activity`, `record_tenant_sync_attempt`) rather than by
 * widening a row policy so that ordinary code can patch a lifecycle column. That
 * choice is the whole design: the indicators are derived facts, and the only way
 * to write one is the function that also enforces "inside this workspace, or as
 * the platform".
 *
 * What these functions are NOT: a delivery guarantee. An offline device keeps
 * its cached rows until it next connects, and this server can only record what
 * it answered at that moment. Nothing here pretends a revocation reached a
 * device earlier than the transport carried it.
 */

/**
 * Machine-readable refusal codes, bounded by the column CHECK (<= 64 chars).
 *
 * Each code names the reason the server actually refused, because the console
 * shows this string to an operator: a provider-support sync refused because the
 * grant is read-only must not be displayed as "workspace suspended" when the
 * workspace is ACTIVE.
 */
export const SYNC_REFUSAL_CODES = {
  tenantSuspended: "tenant_suspended",
  noMembership: "no_membership",
  supportReadOnly: "support_read_only",
} as const;

export type SyncRefusalCode =
  (typeof SYNC_REFUSAL_CODES)[keyof typeof SYNC_REFUSAL_CODES];

/**
 * Stamps `Tenant.lastActivityAt` for an authorized write.
 *
 * Called from the authorization layer at the moment a WRITE permission has been
 * granted, which is the event the column documents ("the workspace last
 * presented an authorized write request"). It never fails the business
 * operation: an indicator that could not be written is a reporting gap, not a
 * reason to refuse a customer's invoice. The refusal is logged so the gap is
 * visible to whoever reads the server log.
 */
export async function touchTenantActivity(tenantId: string): Promise<void> {
  try {
    await prisma.$executeRaw`SELECT public.touch_tenant_activity(${tenantId}::uuid)`;
  } catch (err) {
    console.error("[indicators] Failed to stamp tenant activity:", err);
  }
}

export type SyncAttempt =
  { accepted: true } | { accepted: false; code: SyncRefusalCode };

/**
 * Records the answer the server gave to a synchronization attempt.
 *
 * Both branches stamp `lastSyncAt` — a refusal is an event too — and a refusal
 * additionally carries its machine code, which `record_tenant_sync_attempt`
 * requires (it raises rather than storing a timestamp with no explanation).
 * Success clears the code, so the console never shows an old failure next to a
 * newer accepted sync.
 */
export async function recordSyncAttempt(
  tenantId: string,
  attempt: SyncAttempt,
): Promise<void> {
  const code = attempt.accepted ? null : attempt.code;

  try {
    await prisma.$executeRaw`
      SELECT public.record_tenant_sync_attempt(
        ${tenantId}::uuid,
        ${attempt.accepted}::boolean,
        ${code}::text
      )`;
  } catch (err) {
    console.error("[indicators] Failed to record sync attempt:", err);
  }
}

/**
 * Decides and records one synchronization request from an authorized context.
 *
 * The decision is the suspension rule the platform already enforces for writes:
 * a read-only context (suspended workspace, or a provider support grant) is
 * refused, and the refusal is written to the tenant's indicators and to the
 * audit trail. `context` is the already-authorized tenant context — this function
 * takes no tenant id from a caller — so the answer and the evidence cannot
 * disagree.
 */
export async function answerSyncRequest(
  context: TenantAuthzContext,
): Promise<SyncAttempt> {
  const attempt: SyncAttempt = context.readonly
    ? {
        accepted: false,
        code:
          context.via === "support_grant"
            ? SYNC_REFUSAL_CODES.supportReadOnly
            : SYNC_REFUSAL_CODES.tenantSuspended,
      }
    : { accepted: true };

  await recordSyncAttempt(context.tenantId, attempt);

  if (!attempt.accepted) {
    await recordAudit({
      action: AUDIT_ACTIONS.SYNC_REJECTED,
      userId: context.userId,
      tenantId: context.tenantId,
      resource: "Tenant",
      resourceId: context.tenantId,
      metadata: {
        code: attempt.code,
        tenantStatus: context.tenantStatus,
        via: context.via,
      },
    });
  }

  return attempt;
}
