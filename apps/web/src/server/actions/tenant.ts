"use server";

import { prisma } from "@amisibiz/database";
import { requireAuth, TENANT_ROLE_RANK } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { revokeUserSessions } from "@/lib/auth/session";
import { appendAuditLog, recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  updateTenantSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  revokeInvitationSchema,
} from "@/lib/validations/tenant";
import { addDays } from "date-fns";
import { randomBytes } from "crypto";
import { hashAccountToken } from "@/lib/auth/tokens";
import type { Prisma, TenantRole } from "@prisma/client";
import type { ActionResult } from "@/lib/errors";

function authzError<T = void>(error: unknown): ActionResult<T> {
  if (error instanceof Error && /not permitted|access/i.test(error.message)) {
    return { success: false, error: error.message };
  }
  return {
    success: false,
    error: "You are not permitted to perform this action.",
  };
}

/**
 * Server Action: Update the current user's active tenant settings.
 * Requires the `business.settings.update` permission.
 */
export async function updateTenantAction(
  tenantId: string,
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  const result = updateTenantSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  const data: Prisma.TenantUpdateInput = {};
  if (result.data.name !== undefined) data.name = result.data.name;
  if (result.data.country !== undefined) data.country = result.data.country;
  if (result.data.currency !== undefined) data.currency = result.data.currency;
  if (result.data.timezone !== undefined) data.timezone = result.data.timezone;

  try {
    await prisma.tenant.update({ where: { id: tenantId }, data });

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_UPDATED,
      userId: session.user.id,
      tenantId,
      resource: "Tenant",
      resourceId: tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("[updateTenantAction]", err);
    return { success: false, error: "Failed to update organisation settings." };
  }
}

/**
 * Server Action: Invite a new member to the tenant.
 * Requires `business.members.manage`. A member may never grant a role equal to
 * or higher than their own (privilege-escalation guard).
 */
export async function inviteMemberAction(
  rawInput: unknown,
): Promise<ActionResult<{ invitationId: string }>> {
  const session = await requireAuth();

  const result = inviteMemberSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid invitation data.",
      fieldErrors: result.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  const { email, role, tenantId } = result.data;

  let actorRole: TenantRole;
  try {
    const ctx = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
    );
    actorRole = ctx.role;
  } catch (err) {
    return authzError<{ invitationId: string }>(err);
  }

  const inviterLevel = TENANT_ROLE_RANK[actorRole];
  const targetLevel = TENANT_ROLE_RANK[role];
  if (targetLevel >= inviterLevel) {
    return {
      success: false,
      error:
        "You cannot invite someone to a role equal to or higher than your own.",
    };
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      const existingMembership = await prisma.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId, userId: existingUser.id } },
        select: { id: true },
      });
      if (existingMembership) {
        return { success: false, error: "This user is already a member." };
      }
    }

    const expiresAt = addDays(new Date(), 7);

    // Invitation tokens are bearer credentials — generate a cryptographically
    // random token, store only its SHA-256 hash at rest.
    const token = randomBytes(32).toString("hex");
    const tokenHash = hashAccountToken(token);

    const invitation = await prisma.invitation.upsert({
      where: { tenantId_email: { tenantId, email } },
      create: {
        tenantId,
        email,
        role,
        invitedBy: session.user.id,
        expiresAt,
        status: "PENDING",
        tokenHash,
      },
      update: {
        role,
        invitedBy: session.user.id,
        expiresAt,
        status: "PENDING",
        tokenHash,
      },
      select: { id: true },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_INVITED,
      userId: session.user.id,
      tenantId,
      resource: "Invitation",
      resourceId: invitation.id,
      metadata: { email, role },
    });

    // NOTE: invitation delivery is not implemented (no email transport).
    return { success: true, data: { invitationId: invitation.id } };
  } catch (err) {
    console.error("[inviteMemberAction]", err);
    return { success: false, error: "Failed to send invitation." };
  }
}

/**
 * Server Action: Update a team member's role.
 * Requires `business.members.manage` plus delegation guards.
 */
export async function updateMemberRoleAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = updateMemberRoleSchema.safeParse(rawInput);
  if (!result.success) {
    return { success: false, error: "Invalid input." };
  }

  const { memberId, role, tenantId } = result.data;

  let actorRole: TenantRole;
  try {
    const ctx = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
    );
    actorRole = ctx.role;
  } catch (err) {
    return authzError(err);
  }

  const targetMember = await prisma.tenantMember.findUnique({
    where: { id: memberId },
    select: { id: true, userId: true, tenantId: true, role: true },
  });

  if (!targetMember || targetMember.tenantId !== tenantId) {
    return { success: false, error: "Member not found." };
  }

  if (targetMember.userId === session.user.id) {
    return { success: false, error: "You cannot change your own role." };
  }

  if (TENANT_ROLE_RANK[targetMember.role] > TENANT_ROLE_RANK[actorRole]) {
    return {
      success: false,
      error: "You cannot modify a member with a higher role than your own.",
    };
  }

  if (TENANT_ROLE_RANK[role] >= TENANT_ROLE_RANK[actorRole]) {
    return {
      success: false,
      error: "You cannot assign a role equal to or higher than your own.",
    };
  }

  try {
    await prisma.tenantMember.update({
      where: { id: memberId },
      data: { role },
    });

    // Role changes must not leave the affected user with a stale session.
    await revokeUserSessions(targetMember.userId);

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_ROLE_UPDATED,
      userId: session.user.id,
      tenantId,
      resource: "TenantMember",
      resourceId: memberId,
      metadata: { newRole: role, targetUserId: targetMember.userId },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateMemberRoleAction]", err);
    return { success: false, error: "Failed to update member role." };
  }
}

/**
 * Server Action: Remove a team member.
 * Requires `business.members.manage`. Cannot remove the last owner.
 */
export async function removeMemberAction(
  memberId: string,
  tenantId: string,
): Promise<ActionResult> {
  const session = await requireAuth();

  let actorRole: TenantRole;
  try {
    const ctx = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
    );
    actorRole = ctx.role;
  } catch (err) {
    return authzError(err);
  }

  const targetMember = await prisma.tenantMember.findUnique({
    where: { id: memberId },
    select: { id: true, userId: true, tenantId: true, role: true },
  });

  if (!targetMember || targetMember.tenantId !== tenantId) {
    return { success: false, error: "Member not found." };
  }

  if (targetMember.userId === session.user.id) {
    return { success: false, error: "You cannot remove yourself." };
  }

  if (TENANT_ROLE_RANK[targetMember.role] > TENANT_ROLE_RANK[actorRole]) {
    return {
      success: false,
      error: "You cannot remove a member with a higher role than your own.",
    };
  }

  if (targetMember.role === "TENANT_OWNER") {
    const ownerCount = await prisma.tenantMember.count({
      where: { tenantId, role: "TENANT_OWNER" },
    });
    if (ownerCount <= 1) {
      return {
        success: false,
        error: "Cannot remove the last owner of an organisation.",
      };
    }
  }

  try {
    await prisma.tenantMember.delete({ where: { id: memberId } });

    // Removing a member immediately invalidates their sessions so any cached
    // tenant context cannot be reused.
    await revokeUserSessions(targetMember.userId);

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_MEMBER_REMOVED,
      userId: session.user.id,
      tenantId,
      resource: "TenantMember",
      resourceId: memberId,
    });

    return { success: true };
  } catch (err) {
    console.error("[removeMemberAction]", err);
    return { success: false, error: "Failed to remove member." };
  }
}

/**
 * Server Action: Accept a pending invitation for the signed-in user.
 * Acceptance is a membership operation, not a tenant-permission operation:
 * the invitation itself is the authorization, and the signed-in email must
 * match the invited address.
 */
export async function acceptInvitationAction(
  token: string,
): Promise<ActionResult<{ tenantId: string }>> {
  const session = await requireAuth();

  const tokenHash = hashAccountToken(token);

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tenantId: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
    },
  });

  if (!invitation) {
    return { success: false, error: "Invitation not found or already used." };
  }

  if (invitation.status !== "PENDING") {
    return { success: false, error: "This invitation has already been used." };
  }

  if (new Date() > invitation.expiresAt) {
    // Expiry is a lifecycle fact: flip the row and leave the same kind of
    // evidence an acceptance would. Without this the only record that an
    // invitation ever existed and lapsed would be its absence from ACCEPTED.
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_INVITATION_EXPIRED,
      userId: session.user.id,
      tenantId: invitation.tenantId,
      resource: "Invitation",
      resourceId: invitation.id,
      metadata: { email: invitation.email },
    });
    return { success: false, error: "This invitation has expired." };
  }

  if (session.user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    return {
      success: false,
      error: "This invitation was sent to a different email address.",
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Order matters, and it is the policy that says so: `tenant_member_insert`
      // admits a self-join only while a matching invitation row already reads
      // ACCEPTED for this email and role. Marking the invitation accepted first
      // is therefore not a cosmetic choice — the membership row cannot exist
      // before it, and the same transaction makes the pair atomic.
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });

      await tx.tenantMember.create({
        data: {
          userId: session.user.id,
          tenantId: invitation.tenantId,
          role: invitation.role,
          isDefault: false,
        },
      });

      await appendAuditLog(tx, {
        userId: session.user.id,
        tenantId: invitation.tenantId,
        action: AUDIT_ACTIONS.TENANT_INVITATION_ACCEPTED,
        resource: "Invitation",
        resourceId: invitation.id,
      });
    });

    return { success: true, data: { tenantId: invitation.tenantId } };
  } catch (err) {
    console.error("[acceptInvitationAction]", err);
    return { success: false, error: "Failed to accept invitation." };
  }
}

/**
 * Server Action: Revoke a pending member invitation.
 *
 * Requires `business.members.manage`. The invitation is addressed by id but is
 * still scoped to the actor's tenant — a caller cannot revoke an invitation that
 * belongs to a workspace they were not authorized for, and an invitation that is
 * no longer PENDING (already accepted, expired or revoked) cannot be revoked.
 *
 * This is the counterpart to `inviteMemberAction`'s upsert: reissuing refreshes
 * the token and expiry, revoking retires it, and both leave an audit row so the
 * brief's "issuance, acceptance, expiry and revocation" are all evidenced.
 */
export async function revokeInvitationAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = revokeInvitationSchema.safeParse(rawInput);
  if (!result.success) {
    return { success: false, error: "Invalid invitation reference." };
  }

  const { tenantId, invitationId } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
    );
  } catch (err) {
    return authzError(err);
  }

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: { id: true, tenantId: true, email: true, status: true },
  });

  // A missing row and a row belonging to another tenant read the same, so the
  // refusal never confirms that an invitation exists elsewhere.
  if (!invitation || invitation.tenantId !== tenantId) {
    return { success: false, error: "Invitation not found." };
  }

  if (invitation.status !== "PENDING") {
    return {
      success: false,
      error: "Only a pending invitation can be revoked.",
    };
  }

  try {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "REVOKED" },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_INVITATION_REVOKED,
      userId: session.user.id,
      tenantId,
      resource: "Invitation",
      resourceId: invitation.id,
      metadata: { email: invitation.email },
    });

    return { success: true };
  } catch (err) {
    console.error("[revokeInvitationAction]", err);
    return { success: false, error: "Failed to revoke invitation." };
  }
}
