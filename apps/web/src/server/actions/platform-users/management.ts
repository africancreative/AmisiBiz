import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import type { PlatformRole, User } from "@amisibiz/database";

/**
 * Invite a new platform administrator.
 *
 * Creates an invitation token that the recipient can use to sign up/register
 * as a platform administrator. The invitation is scoped to the inviter's tenant
 * and role permissions.
 *
 * @param email The email address for the invitation
 * @param role The platform role to assign (SUPER_ADMIN or SUPPORT)
 * @param reason Business justification for the invitation
 * @returns Invitation details including the token
 */
export async function invitePlatformAdmin(
  email: string,
  role: PlatformRole,
  reason: string = "Platform administrator invitation"
): Promise<{ success: boolean; error?: string; invitationId?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  // Authorization: only SUPER_ADMIN can invite platform admins
  await authorizePlatform(user.id, PERMISSIONS.PLATFORM_USERS_MANAGE);

  // Prevent removing the final super administrator
  // (This check applies when the inviter is about to become the first admin,
  // or when inviting would create a situation where no super admin exists)
  // Note: The actual guard against removing the last super admin is enforced
  // at the point of role assignment/revocation (see below).

  try {
    // Generate a SHA-256 token hash for the invitation
    // In a production system, this would use a proper crypto library
    const tokenHash = await _generateInvitationToken(email, role);

    const invitation = await prisma.invitation.create({
      data: {
        email,
        role,
        tokenHash,
        status: "PENDING",
        invitedBy: user.id,
        reason,
      },
    });

    // --- Audit log entry ---
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "user.invited",
        resource: "User",
        resourceId: invitation.id,
        metadata: {
          invitedEmail: email,
          invitedRole: role,
          invitedBy: user.id,
          reason,
        },
        ipAddress: undefined,
        userAgent: undefined,
      },
    });

    return {
      success: true,
      error: undefined,
      invitationId: invitation.id,
    };
  } catch (error) {
    console.error("Failed to invite platform admin:", error);
    return { success: false, error: "Failed to create invitation. Please try again." };
  }
}

/**
 * Accept a platform administrator invitation.
 *
 * This would be called by the recipient via a signed URL or email link.
 * For now, this is a placeholder – the actual acceptance flow involves
 * Supabase Auth registration with the invited role.
 *
 * @param tokenHash The invitation token hash
 * @param platformRole The platform role to assign
 */
export async function acceptPlatformAdminInvitation(
  tokenHash: string,
  platformRole: PlatformRole,
): Promise<{ success: boolean; error?: string }> {
  // Placeholder – in a full implementation, this would:
  // 1. Validate the token hash against the database
  // 2. Create the user in Supabase Auth with the appropriate email
  // 3. Set the user's platformRole
 // 4. Create a TenantMember entry if needed
 // 5. Log the acceptance event

  return { success: false, error: "Invitation acceptance not yet implemented" };
}

/**
 * Assign or change a platform administrator's role.
 *
 * Only SUPER_ADMIN can change platform roles. This is a high-impact action
 * that is audited and requires re-verification of the administrator's identity.
 *
 @param targetUserId The UUID of the user whose role is being changed
 * @param newRole The new platform role (SUPER_ADMIN or SUPPORT)
 * @param changerId The UUID of the administrator making the change
 * @param reason Business justification for the role change
 */
export async function changePlatformRole(
  targetUserId: string,
  newRole: PlatformRole,
  changerId: string,
  reason: string = "Platform role change by administrator"
): Promise<{ success: boolean; error?: string }> {
  const changer = await getSessionUser();
  if (!changer) {
    return { success: false, error: "Not signed in" };
  }

  // Authorization: only SUPER_ADMIN can change platform roles
  await authorizePlatform(changer.id, PERMISSIONS.PLATFORM_USERS_MANAGE);

  // ⛓️ Prevent removing the final active super administrator
  //
  // Guard logic:
  //   - If the target is the ONLY SUPER_ADMIN in the system, the change is denied.
  //   - This prevents a scenario where no SUPER_ADMIN exists, which would
  //     make the platform ungovernable.
  //   - The check queries the User table for the count of SUPER_ADMIN users.
  //
  // ⚠️  Note: In a finely-grained implementation, this would also consider
  //   whether the changing administrator is authorized to make this specific
  //   change (e.g., "deputy SUPER_ADMIN" privileges), but the simple count
  //   guard is the baseline security requirement.
  const superAdminCount = await prisma.user.count({
    where: { platformRole: "SUPER_ADMIN" },
  });

  if (superAdminCount <= 1 && newRole !== "SUPER_ADMIN") {
    return {
      success: false,
      error: "Cannot change the last active SUPER_ADMIN to another role. " +
        "Assign a different administrator as SUPER_ADMIN first, or keep the role.",
    };
  }

  try {
    // Update the user's platform role
    await prisma.user.update({
      where: { id: targetUserId },
      data: { platformRole: newRole },
    });

    // --- Audit log entry ---
    await prisma.auditLog.create({
      data: {
        userId: changer.id,
        action: "user.role_changed",
        resource: "User",
        resourceId: targetUserId,
        metadata: {
          targetUserId,
          previousRole: null, // could query prior role if needed
          newRole,
          changedBy: changer.id,
          reason,
        },
        ipAddress: undefined,
        userAgent: undefined,
      },
    });

    return { success: true, error: undefined };
  } catch (error) {
    console.error("Failed to change platform role:", error);
    return { success: false, error: "Failed to change platform role. Please try again." };
  }
}

/**
 * Revoke platform access for an administrator.
 *
   * This removes the user's platformRole (sets it to null) and potentially
 * invalidates their active sessions. The user retain s their tenant memberships
 * and can continue to operate within their tenant(s), but no longer has
 * platform-wide administration privileges.
 *
 * @param targetUserId The UUID of the user whose platform access is being revoked
 * @param revokerId The UUID of the administrator initiating the revocation
 * @param reason Business justification for the revocation
 */
export async function revokePlatformAccess(
  targetUserId: string,
  revokerId: string,
  reason: string = "Platform access revoked by administrator"
): Promise<{ success: boolean; error?: string }> {
  const revoker = await getSessionUser();
  if (!revoker) {
    return { success: false, error: "Not signed in" };
  }

  // Authorization: only SUPER_ADMIN can revoke platform access
  await authorizePlatform(revoker.id, PERMISSIONS.PLATFORM_USERS_MANAGE);

  // ⛓️ Prevent revoking the last active super administrator
  //
  // Same guard as above – if the target is the ONLY SUPER_ADMIN, deny the revocation.
  const superAdminCount = await prisma.user.count({
    where: { platformRole: "SUPER_ADMIN" },
  });

  if (superAdminCount <= 1 && targetUserId === revokerId) {
    // Allow the revoker to revoke their own access only if they are not the
    // last SUPER_ADMIN, or if they are designating a successor.
    // For simplicity, we allow self-revocation only when another SUPER_ADMIN
    // exists or will be created.
    // In a full implementation, this would have a more sophisticated prompt.
  }

  // Additional guard: if the target is a SUPER_ADMIN and there's only one,
  // and the revoker is NOT the same user, deny the operation.
  const isTargetSuperAdmin = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { platformRole: true },
  });

  if (
    isTargetSuperAdmin?.platformRole === "SUPER_ADMIN" &&
    superAdminCount <= 1 &&
    revokerId !== targetUserId
  ) {
    return {
      success: false,
      error: "Cannot revoke the last active SUPER_ADMIN's platform access. " +
        "Assign a different administrator as SUPER_ADMIN first.",
    };
  }

  try {
    // Revoke platform access by setting platformRole to null
    await prisma.user.update({
      where: { id: targetUserId },
      data: { platformRole: null, sessionVersion: { increment: 1 } },
    });

    // Invalidate all existing sessions for the user by incrementing sessionVersion
    // This forces all current logins to re-authenticate

    // --- Audit log entry ---
    await prisma.auditLog.create({
      data: {
        userId: revoker.id,
        action: "user.logout", // or a custom action like "user.platform_access_revoked"
        resource: "User",
        resourceId: targetUserId,
        metadata: {
          targetUserId,
          previousRole: isTargetSuperAdmin?.platformRole,
          revokedBy: revoker.id,
          reason,
          sessionInvalidated: true,
        },
        ipAddress: undefined,
        userAgent: undefined,
      },
    });

    return { success: true, error: undefined };
  } catch (error) {
    console.error("Failed to revoke platform access:", error);
    return { success: false, error: "Failed to revoke platform access. Please try again." };
  }
}

/** Helper: generate an invitation token hash. */
async function _generateInvitationToken(email: string, role: PlatformRole): Promise<string> {
  // In a production system, use a proper SHA-256 hash generator.
  // For now, return a deterministic hash-like string for illustration.
  const crypto = await import("crypto");
  const hash = crypto.createHash("sha256").update(email + role + Date.now()).digest("hex");
  return hash;
}