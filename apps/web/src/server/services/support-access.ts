import { prisma, type ScopedTx } from "@amisibiz/database";
import { appendAuditLog, recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  DEFAULT_SUPPORT_GRANT_HOURS,
  MAX_SUPPORT_GRANT_HOURS,
} from "@/lib/validations/support";
import type { SupportAccessGrant } from "@prisma/client";

/**
 * Provider support access — the separately authorized, separately audited
 * mechanism the Phase 1 directive asks for.
 *
 * The model (design §5.6):
 *
 *  - `PlatformRole.SUPPORT` grants NOTHING on its own. `PLATFORM_ROLE_PERMISSIONS.SUPPORT`
 *    is the empty set in the matrix, and `has_tenant_write_access()` has no
 *    support branch at all.
 *  - Access to one tenant's data exists only while an unrevoked, unexpired
 *    `SupportAccessGrant` row names that (staff member, tenant) pair. Every read
 *    made under it is audited (`support.accessUsed`, written by the
 *    authorization service).
 *  - A grant is time-boxed and justified. Revocation never deletes: an
 *    accidentally erased grant would also erase the evidence of what was looked
 *    at under it.
 *
 * All of this is reachable only by an actor who has already passed
 * `authorizePlatform(..., PERMISSIONS.PLATFORM_SUPPORT_GRANT)`; these functions
 * re-check the grantee's own standing, because "who is this user id" is a
 * database fact, not a form field.
 */

export class SupportAccessError extends Error {
  readonly code: "GRANTEE_NOT_SUPPORT" | "GRANT_NOT_FOUND";

  constructor(code: SupportAccessError["code"], message: string) {
    super(message);
    this.name = "SupportAccessError";
    this.code = code;
  }
}

export type CreateSupportGrantInput = {
  /** The platform administrator issuing the grant. */
  actorId: string;
  tenantId: string;
  platformUserId: string;
  reason: string;
  durationHours?: number;
};

export type SupportGrant = Pick<
  SupportAccessGrant,
  "id" | "tenantId" | "platformUserId" | "reason" | "expiresAt" | "revokedAt"
>;

/**
 * Issues a grant. The grantee must be an ACTIVE account holding
 * `platformRole = SUPPORT` — read from the row, never assumed from the id the
 * caller supplied, so an ordinary customer account can be handed nothing.
 */
export async function createSupportGrant(
  input: CreateSupportGrantInput,
): Promise<SupportGrant> {
  const durationHours = clampDuration(input.durationHours);

  const grantee = await prisma.user.findUnique({
    where: { id: input.platformUserId },
    select: { id: true, platformRole: true, status: true },
  });

  if (
    !grantee ||
    grantee.platformRole !== "SUPPORT" ||
    grantee.status !== "ACTIVE"
  ) {
    // Not a support staff account: nothing to grant, and the attempt is worth a
    // record — it is either a mistake or somebody probing for a way in.
    await recordDeniedGrant(input);
    throw new SupportAccessError(
      "GRANTEE_NOT_SUPPORT",
      "Support access can only be granted to an active support account.",
    );
  }

  const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);

  const grant = await prisma.$transaction(async (tx: ScopedTx) => {
    const created = await tx.supportAccessGrant.create({
      data: {
        tenantId: input.tenantId,
        platformUserId: grantee.id,
        grantedById: input.actorId,
        reason: input.reason,
        expiresAt,
      },
      select: {
        id: true,
        tenantId: true,
        platformUserId: true,
        reason: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    await appendAuditLog(tx, {
      action: AUDIT_ACTIONS.SUPPORT_ACCESS_GRANTED,
      userId: input.actorId,
      tenantId: input.tenantId,
      resource: "SupportAccessGrant",
      resourceId: created.id,
      // Only the accountability fields: who, for whom, for how long, and the
      // justification. Never the tenant's business data.
      metadata: {
        granteeUserId: grantee.id,
        durationHours,
        expiresAt: created.expiresAt.toISOString(),
      },
    });

    return created;
  });

  return grant;
}

export type RevokeSupportGrantInput = {
  actorId: string;
  grantId: string;
  reason?: string | undefined;
};

/** Revokes a grant by setting `revokedAt`; history and evidence are kept. */
export async function revokeSupportGrant(
  input: RevokeSupportGrantInput,
): Promise<SupportGrant> {
  const existing = await prisma.supportAccessGrant.findUnique({
    where: { id: input.grantId },
    select: {
      id: true,
      tenantId: true,
      platformUserId: true,
      reason: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!existing) {
    throw new SupportAccessError("GRANT_NOT_FOUND", "Unknown support grant.");
  }

  const now = new Date();

  return prisma.$transaction(async (tx: ScopedTx) => {
    const updated = await tx.supportAccessGrant.update({
      where: { id: existing.id },
      data: { revokedAt: now },
      select: {
        id: true,
        tenantId: true,
        platformUserId: true,
        reason: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    await appendAuditLog(tx, {
      action: AUDIT_ACTIONS.SUPPORT_ACCESS_REVOKED,
      userId: input.actorId,
      tenantId: existing.tenantId,
      resource: "SupportAccessGrant",
      resourceId: existing.id,
      metadata: {
        granteeUserId: existing.platformUserId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });

    return updated;
  });
}

/** Every grant for one tenant, current first — the console's accountability view. */
export function listSupportGrantsForTenant(tenantId: string) {
  return prisma.supportAccessGrant.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      tenantId: true,
      platformUserId: true,
      grantedById: true,
      reason: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      platformUser: { select: { email: true, name: true, status: true } },
    },
  });
}

/** Grants a staff member holds right now (their own view; also RLS-visible). */
export function listActiveGrantsForUser(platformUserId: string) {
  return prisma.supportAccessGrant.findMany({
    where: {
      platformUserId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { expiresAt: "asc" },
    select: {
      id: true,
      tenantId: true,
      reason: true,
      expiresAt: true,
      tenant: { select: { name: true, slug: true, status: true } },
    },
  });
}

async function recordDeniedGrant(
  input: CreateSupportGrantInput,
): Promise<void> {
  // recordAudit appends without reading the row back and works in whatever
  // scope the request has — a denial has no tenant context to belong to.
  await recordAudit({
    action: AUDIT_ACTIONS.SUPPORT_ACCESS_DENIED,
    userId: input.actorId,
    tenantId: input.tenantId,
    resource: "SupportAccessGrant",
    metadata: {
      reason: "grantee_is_not_support",
      attemptedFor: input.platformUserId,
    },
  });
}

function clampDuration(hours: number | undefined): number {
  if (!hours || !Number.isFinite(hours) || hours < 1) {
    return DEFAULT_SUPPORT_GRANT_HOURS;
  }
  return Math.min(Math.floor(hours), MAX_SUPPORT_GRANT_HOURS);
}
