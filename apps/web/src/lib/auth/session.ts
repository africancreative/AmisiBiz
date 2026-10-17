import { prisma } from "@amisibiz/database";
import type { UserStatus } from "@prisma/client";

/**
 * Extracts the session-version claim from a token payload for backward compatibility.
 */
export function readSessionVersionClaim(accessToken: string): number {
  try {
    const payloadSegment = accessToken.split(".")[1];
    if (!payloadSegment) return 0;

    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as {
      app_metadata?: Record<string, unknown>;
      sessionVersion?: unknown;
    } | null;

    const version =
      payload?.app_metadata?.amisibiz_session_version ??
      payload?.sessionVersion;
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 0
    ) {
      return 0;
    }
    return version;
  } catch {
    return 0;
  }
}

/**
 * Pure predicate deciding whether a session is still valid.
 */
export function isSessionValid(
  user: { status: UserStatus; sessionVersion: number } | null | undefined,
  tokenVersion: number,
): boolean {
  if (!user) return false;
  return user.status === "ACTIVE" && user.sessionVersion === tokenVersion;
}

/**
 * Revokes every outstanding session for a user by bumping their sessionVersion in the database.
 * All existing tokens become invalid immediately because verifySessionToken checks
 * that the token's sessionVersion matches the database value.
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
}
