import {
  prisma,
  enterScope,
  bootstrapScope,
  sessionScope,
} from "@amisibiz/database";
import { isSessionValid, readSessionVersionClaim } from "@/lib/auth/session";
import { currentRequestSessionUser } from "@/lib/auth/request-session";
import { createServerSupabase } from "@/lib/supabase/server";
import { emailVerificationRequired } from "@/lib/env";
import type { AppSessionUser } from "@amisibiz/auth";

export type { AppSessionUser };

/**
 * The facts about an already-verified Supabase user that the session trust chain
 * needs. Both entry points produce these: the cookie client for the web app, and
 * the bearer client for installed shells (`bearer-session.ts`).
 */
export type VerifiedAuthUser = {
  readonly id: string;
  readonly email?: string | null;
  readonly email_confirmed_at?: string | null;
};

/**
 * Steps 2 and 3 of the trust chain, shared by the cookie and bearer paths.
 *
 * Trust chain (the whole of it — see `getSessionUser` for step 1):
 * 2. The access token's embedded `amisibiz_session_version` claim must match
 *    `User.sessionVersion` in our database (revocation is enforced HERE, not
 *    by trusting the token alone — verified live: an access token issued
 *    before a metadata bump remains valid at Supabase Auth until natural
 *    expiry).
 * 3. The profile must exist and be ACTIVE.
 *
 * The parameter is deliberately the *verified* auth user plus the raw access
 * token, never a browser-supplied object: the id here comes from a token GoTrue
 * has just verified, which is why it — and nothing else — may become
 * `app.current_user_id`.
 *
 * Never trust a user id, role or status that only exists in the browser.
 */
export async function resolveVerifiedSession(
  authUser: VerifiedAuthUser,
  accessToken: string | null,
): Promise<AppSessionUser | null> {
  const claimVersion = accessToken ? readSessionVersionClaim(accessToken) : -1; // absent token can never satisfy the check

  // Open the RLS scope for the rest of this request. This is the one place an
  // identity enters the system, so every read after this point is filtered by
  // it, including the profile lookup below (the `User` SELECT policy admits
  // exactly one row for a plain session: the actor's own).
  enterScope(sessionScope(authUser.id));

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

  if (!user || !isSessionValid(user, claimVersion)) {
    // No verified identity: the ambient scope must not keep an id that failed
    // validation, or later statements in this request would run as that user.
    enterScope(bootstrapScope());
    return null;
  }

  // Optional policy gate: when REQUIRE_EMAIL_VERIFICATION=true, only
  // email-confirmed accounts may hold a session.
  if (emailVerificationRequired() && !authUser.email_confirmed_at) {
    enterScope(bootstrapScope());
    return null;
  }

  // Mirror the confirmation fact onto the profile once; best-effort — the
  // authoritative value lives in Supabase Auth. Self-update of a cosmetic
  // column, which both the `user_update` policy and `users_guard_update` allow.
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

  // Re-declare the scope with the platform standing read from the row. The
  // claims only describe the context; `is_platform_admin()` re-derives the fact
  // inside every policy, so this cannot promote anybody.
  enterScope(
    sessionScope(user.id, {
      isPlatformAdmin: user.platformRole === "SUPER_ADMIN",
      isPlatformSupport: user.platformRole === "SUPPORT",
    }),
  );

  return {
    id: user.id,
    email: user.email ?? authUser.email ?? null,
    name: user.name ?? null,
    platformRole: user.platformRole,
    status: user.status,
  };
}

/**
 * Resolves the signed-in user for Server Components, Server Actions and Route
 * Handlers, or null when the request is unauthenticated.
 *
 * Two sources, in order:
 * 1. A request-scoped bearer session, when the caller is running inside
 *    `runWithRequestSession` (the sync API — see `bearer-session.ts`).
 * 2. The Supabase auth cookie: `getUser()` validates the access token against
 *    Supabase Auth (network round trip; refreshes first when the token has
 *    expired), then `resolveVerifiedSession` applies the rest of the chain.
 */
export async function getSessionUser(): Promise<AppSessionUser | null> {
  const bearer = currentRequestSessionUser();
  if (bearer !== undefined) return bearer;

  const supabase = await createServerSupabase();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const authUser = userData?.user;
  if (userError || !authUser) return null;

  // The raw access token (not the decoded user) carries the claim we compare
  // against the authoritative database version.
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token ?? null;

  return resolveVerifiedSession(authUser, accessToken);
}
