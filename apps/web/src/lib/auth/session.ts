import { prisma } from "@amisibiz/database";
import { createAdminSupabase } from "@/lib/supabase/server";
import type { UserStatus } from "@prisma/client";

/**
 * Session-version guard and session revocation against Supabase Auth.
 *
 * Compatibility note: the function signatures here are intentionally unchanged
 * from the previous Auth.js era — `isSessionValid` is still the single
 * predicate the server uses to decide whether a session is live, and
 * `revokeUserSessions` is still the single entry point for killing sessions.
 * What changed is where the versions come from:
 *
 * - The authoritative version lives in `User.sessionVersion` (database).
 * - The version the *token* carries lives in the Supabase access token's
 *   `app_metadata.amisibiz_session_version` claim (embedded at issue time).
 * - A session is valid only while the two match. Revocation bumps the
 *   database version, so every previously issued token is rejected by this
 *   server even if Supabase Auth would still accept it until natural expiry.
 */

/**
 * Extracts the session-version claim from a Supabase access token.
 *
 * The signature is NOT verified here — callers only reach this after GoTrue
 * has validated the token (`getUser()`/`signInWithPassword`). Unreadable or
 * absent claims decode to 0, which only matches a user who never had their
 * version bumped (default 0).
 */
export function readSessionVersionClaim(accessToken: string): number {
  try {
    const payloadSegment = accessToken.split(".")[1];
    if (!payloadSegment) return 0;

    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as { app_metadata?: Record<string, unknown> } | null;

    const version = payload?.app_metadata?.amisibiz_session_version;
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
 * Pure predicate deciding whether a session is still valid. The session is
 * invalid when the user no longer exists, is not ACTIVE, or the token's
 * embedded version no longer matches the database (revoked).
 */
export function isSessionValid(
  user: { status: UserStatus; sessionVersion: number } | null | undefined,
  tokenVersion: number,
): boolean {
  if (!user) return false;
  return user.status === "ACTIVE" && user.sessionVersion === tokenVersion;
}

/**
 * Revokes every outstanding session for a user.
 *
 * Three ordered steps (semantics verified live against the project):
 *
 * 1. Bump `User.sessionVersion`. This alone is sufficient for OUR server:
 *    every request compares the token's embedded claim against this value and
 *    rejects mismatches (fail-closed), including tokens GoTrue still accepts.
 * 2. Kill the GoTrue sessions with a 1-second ban followed by an immediate
 *    unban. A ban deletes all sessions permanently (pre-ban refresh tokens
 *    stay dead even after the ban is lifted) and the unban restores sign-in.
 *    If this step fails we skip step 3 and return — the database bump above
 *    already guarantees fail-closed behaviour, and leaving the claim stale
 *    keeps the mismatch detectable so the login flow can repair it.
 * 3. Sync `app_metadata.amisibiz_session_version` to the new version so
 *    every token issued from now on carries a claim that matches the
 *    database.
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });

  const admin = createAdminSupabase();

  try {
    const banned = await admin.auth.admin.updateUserById(userId, {
      ban_duration: "1s",
    });
    if (banned.error) throw banned.error;

    const unbanned = await admin.auth.admin.updateUserById(userId, {
      ban_duration: "none",
    });
    if (unbanned.error) throw unbanned.error;
  } catch (error) {
    console.error(
      "[auth] Failed to kill Supabase sessions for user",
      userId,
      error,
    );
    return;
  }

  try {
    const synced = await admin.auth.admin.updateUserById(userId, {
      app_metadata: { amisibiz_session_version: user.sessionVersion },
    });
    if (synced.error) throw synced.error;
  } catch (error) {
    console.error(
      "[auth] Failed to sync the session-version claim for user",
      userId,
      error,
    );
  }
}
