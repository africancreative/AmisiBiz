import { prisma } from "@/lib/db/prisma";
import type { UserStatus } from "@prisma/client";

/**
 * Pure predicate used by the Auth.js session callback to decide whether a
 * session is still valid. A session is invalid when the user no longer exists,
 * is not ACTIVE, or has a stale session version (revoked).
 */
export function isSessionValid(
  user: { status: UserStatus; sessionVersion: number } | null | undefined,
  tokenVersion: number,
): boolean {
  if (!user) return false;
  return user.status === "ACTIVE" && user.sessionVersion === tokenVersion;
}

/**
 * Revokes every outstanding session for a user by bumping their session
 * version. Call on password change, forced logout, or when a membership/role
 * change must invalidate existing tokens.
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
}
