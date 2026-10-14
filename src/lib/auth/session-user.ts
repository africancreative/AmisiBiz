import { prisma } from "@/lib/db/prisma";
import { isSessionValid, readSessionVersionClaim } from "@/lib/auth/session";
import { createServerSupabase } from "@/lib/supabase/server";
import type { PlatformRole, UserStatus } from "@prisma/client";

/**
 * The application's view of the signed-in user. This is the ONLY identity
 * shape server code may rely on — it always originates from a token that
 * Supabase Auth validated AND a session-version check against our database.
 */
export type AppSessionUser = {
  id: string;
  email: string | null;
  name: string | null;
  platformRole: PlatformRole;
  status: UserStatus;
};

function emailVerificationRequired(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
}

/**
 * Resolves the signed-in user for Server Components, Server Actions and Route
 * Handlers, or null when the request is unauthenticated.
 *
 * Trust chain:
 * 1. `getUser()` validates the access token against Supabase Auth (network
 *    round trip; refreshes first when the token has expired).
 * 2. The access token's embedded `amisibiz_session_version` claim must match
 *    `User.sessionVersion` in our database (revocation is enforced HERE, not
 *    by trusting the token alone — verified live: an access token issued
 *    before a metadata bump remains valid at Supabase Auth until natural
 *    expiry).
 * 3. The profile must exist and be ACTIVE.
 *
 * Never trust a user id, role or status that only exists in the browser.
 */
export async function getSessionUser(): Promise<AppSessionUser | null> {
  const supabase = await createServerSupabase();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const authUser = userData?.user;
  if (userError || !authUser) return null;

  // The raw access token (not the decoded user) carries the claim we compare
  // against the authoritative database version.
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  const claimVersion = accessToken ? readSessionVersionClaim(accessToken) : -1; // absent token can never satisfy the check

  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: {
      id: true,
      email: true,
      name: true,
      platformRole: true,
      status: true,
      sessionVersion: true,
      emailVerified: true,
    },
  });

  if (!user || !isSessionValid(user, claimVersion)) return null;

  // Optional policy gate: when REQUIRE_EMAIL_VERIFICATION=true, only
  // email-confirmed accounts may hold a session.
  if (emailVerificationRequired() && !authUser.email_confirmed_at) {
    return null;
  }

  // Mirror the confirmation fact onto the profile once; best-effort — the
  // authoritative value lives in Supabase Auth.
  if (!user.emailVerified && authUser.email_confirmed_at) {
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date(authUser.email_confirmed_at) },
      });
    } catch (error) {
      console.error(
        "[auth] Failed to mirror email verification for user",
        user.id,
        error,
      );
    }
  }

  return {
    id: user.id,
    email: user.email ?? authUser.email ?? null,
    name: user.name ?? null,
    platformRole: user.platformRole,
    status: user.status,
  };
}
