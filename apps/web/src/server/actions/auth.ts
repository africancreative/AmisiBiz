"use server";

import {
  bootstrapScope,
  enterScope,
  prisma,
  runInScope,
  sessionScope,
} from "@amisibiz/database";
import {
  registerSchema,
  forgotPasswordSchema,
  loginSchema,
  updatePasswordSchema,
} from "@/lib/validations/auth";
import { maskEmail } from "@/lib/utils";
import {
  readSessionVersionClaim,
  revokeUserSessions,
} from "@/lib/auth/session";
import { getSessionUser } from "@/lib/auth/session-user";
import { findUserIdByEmail } from "@/lib/auth/user-lookup";
import {
  createAdminSupabase,
  createServerSupabase,
} from "@/lib/supabase/server";
import { appendAuditLog, recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  provisionTenant,
  recordTenantCreated,
} from "@/server/services/tenant-provisioning";
import type { ActionResult } from "@/lib/errors";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Authentication actions, backed by Supabase Auth (GoTrue).
 *
 * Security invariants (see project constitution):
 * - Credentials are only ever submitted server-side; the browser never holds
 *   a Supabase client or token (cookies are httpOnly).
 * - Authorization decisions never trust client-supplied ids, roles or status.
 * - Handlers stay silent about account existence except where the user already
 *   proved knowledge of the address (registration).
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function appUrl(): string | undefined {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  return url && url.length > 0 ? url.replace(/\/+$/, "") : undefined;
}

// Throttle sensitive auth operations by client IP.
async function enforceAuthRateLimit(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const ip = (await getClientIp()) ?? "unknown";
  const result = await rateLimit(`${bucket}:${ip}`, { limit, windowMs });
  return result.success;
}

type ServerSupabase = SupabaseClient;

/**
 * Repairs drift between the access token's embedded session-version claim and
 * the authoritative `User.sessionVersion` (possible when a revocation's
 * GoTrue metadata sync failed). Writes the current version into app_metadata
 * and rotates the session so the new token carries it.
 */
async function repairSessionVersionClaim(
  supabase: ServerSupabase,
  userId: string,
  expectedVersion: number,
  refreshToken: string,
): Promise<boolean> {
  try {
    const admin = createAdminSupabase();
    const { error: syncError } = await admin.auth.admin.updateUserById(userId, {
      app_metadata: { amisibiz_session_version: expectedVersion },
    });
    if (syncError) throw syncError;

    const { data, error: refreshError } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (refreshError || !data.session) {
      throw refreshError ?? new Error("Refresh returned no session");
    }

    return (
      readSessionVersionClaim(data.session.access_token) === expectedVersion
    );
  } catch (error) {
    console.error(
      "[auth] Failed to repair the session-version claim for user",
      userId,
      error,
    );
    return false;
  }
}

/**
 * Server Action: Sign in with email and password.
 *
 * After Supabase Auth accepts the credentials we re-check the app profile
 * (status, session version) against our database — a token is never trusted
 * on its own. Suspended accounts and revoked sessions are rejected here.
 */
export async function loginAction(
  rawInput: unknown,
): Promise<ActionResult<{ userId: string }>> {
  const ip = (await getClientIp()) ?? "unknown";

  const ipAllowed = await rateLimit(`login:ip:${ip}`, {
    limit: 10,
    windowMs: 10 * MINUTE_MS,
  });
  if (!ipAllowed.success) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_LOGIN_RATE_LIMITED,
      ipAddress: ip,
    });
    return {
      success: false,
      error: "Too many attempts. Please try again later.",
      code: "RATE_LIMITED",
    };
  }

  const parsed = loginSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { success: false, error: "Invalid email or password." };
  }
  const { email, password } = parsed.data;

  const emailAllowed = await rateLimit(`login:email:${email}`, {
    limit: 5,
    windowMs: 10 * MINUTE_MS,
  });
  if (!emailAllowed.success) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_LOGIN_RATE_LIMITED,
      metadata: { email: maskEmail(email) },
      ipAddress: ip,
    });
    return {
      success: false,
      error: "Too many attempts. Please try again later.",
      code: "RATE_LIMITED",
    };
  }

  const supabase = await createServerSupabase();

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.session || !data.user) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
      metadata: { email: maskEmail(email) },
      ipAddress: ip,
    });
    if (error?.code === "email_not_confirmed") {
      return {
        success: false,
        error:
          "Please confirm your email address first — check your inbox for the verification link.",
      };
    }
    return { success: false, error: "Invalid email or password." };
  }

  const userId = data.user.id;

  // GoTrue has accepted the credentials, so this id may now anchor the request's
  // RLS context. The profile read below is the actor's own row, which is exactly
  // the one row the `User` policy admits for a session context — a token for a
  // user with no profile simply reads nothing.
  enterScope(sessionScope(userId));

  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, sessionVersion: true },
  });

  if (!profile) {
    // GoTrue user without an app profile: never grant access to a half-made
    // account. Compensating cleanup happens at registration time, not here.
    enterScope(bootstrapScope());
    await supabase.auth.signOut({ scope: "local" });
    return { success: false, error: "Invalid email or password." };
  }

  if (profile.status !== "ACTIVE") {
    enterScope(bootstrapScope());
    await supabase.auth.signOut({ scope: "local" });
    return {
      success: false,
      error: "Your account has been suspended. Contact support.",
    };
  }

  const claimVersion = readSessionVersionClaim(data.session.access_token);
  if (claimVersion !== profile.sessionVersion) {
    const repaired = await repairSessionVersionClaim(
      supabase,
      userId,
      profile.sessionVersion,
      data.session.refresh_token,
    );
    if (!repaired) {
      enterScope(bootstrapScope());
      await supabase.auth.signOut({ scope: "local" });
      return { success: false, error: "Sign in failed. Please try again." };
    }
  }

  await recordAudit({
    action: AUDIT_ACTIONS.AUTH_SIGN_IN,
    userId,
    resource: "User",
    resourceId: userId,
    ipAddress: ip,
  });

  return { success: true, data: { userId } };
}

/**
 * Server Action: Sign out of the current browser session. Only this device's
 * session is ended (other devices are untouched by design).
 */
export async function logoutAction(): Promise<ActionResult> {
  const supabase = await createServerSupabase();

  const { data } = await supabase.auth.getUser();
  const userId = data?.user?.id ?? null;

  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    // An expired/missing session can make signOut throw; clearing cookies is
    // still attempted by the client, and the middleware will not resurrect a
    // dead token.
    console.error("[logoutAction] local sign-out failed:", error);
  }

  if (userId) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_SIGN_OUT,
      userId,
      resource: "User",
      resourceId: userId,
    });
  }

  return { success: true };
}

/**
 * Server Action: Register a new user (Supabase Auth) and create their first
 * tenant (organisation) in one logical flow.
 *
 * - Identity is created by Supabase Auth; the app profile row mirrors it with
 *   `id = <Supabase user UUID>` — never a client-supplied value.
 * - When email confirmation is enabled, no session exists yet; the user must
 *   confirm before signing in.
 * - If provisioning fails after the Auth user was created, the Auth user is
 *   deleted (compensating action) so the address can be retried.
 */
export async function registerAction(
  rawInput: unknown,
  locale = "en",
): Promise<
  ActionResult<{
    userId: string;
    tenantId: string;
    emailConfirmationRequired: boolean;
  }>
> {
  const allowed = await enforceAuthRateLimit("register", 5, HOUR_MS);
  if (!allowed) {
    return {
      success: false,
      error: "Too many attempts. Please try again later.",
      code: "RATE_LIMITED",
    };
  }

  const result = registerSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input. Please check the form.",
      fieldErrors: result.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  const { name, email, password, tenantName } = result.data;

  const duplicateEmail = (): ActionResult<never> => ({
    success: false,
    error: "An account with this email already exists.",
    fieldErrors: { email: ["An account with this email already exists."] },
  });

  // Fast duplicate check against the mirror; Supabase Auth remains the
  // authority and is re-checked below. This is the only pre-session lookup the
  // design allows (see lib/auth/user-lookup).
  const existingUser = await findUserIdByEmail(email);
  if (existingUser) {
    return duplicateEmail();
  }

  const supabase = await createServerSupabase();
  const baseUrl = appUrl();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name },
      ...(baseUrl
        ? {
            emailRedirectTo: `${baseUrl}/auth/callback?next=/${locale}/dashboard`,
          }
        : {}),
    },
  });

  if (error) {
    if (error.code === "user_already_exists" || error.status === 422) {
      return duplicateEmail();
    }
    console.error("[registerAction] Supabase sign-up failed:", error.message);
    return {
      success: false,
      error: "Something went wrong. Please try again later.",
    };
  }

  const authUser = data.user;

  // With email confirmation enabled, Supabase Auth obfuscates duplicate
  // sign-ups: it returns a fake user with an EMPTY identities array instead
  // of an error, to prevent account enumeration.
  if (!authUser || (authUser.identities?.length ?? 0) === 0) {
    return duplicateEmail();
  }

  try {
    // One transaction, one context. `user_registration_insert` admits a `User`
    // row only when its id IS the context user, so the bootstrap scope is opened
    // with the id Supabase Auth just created — the only id in this flow that
    // came from a verified source rather than from the form.
    const { tenantId } = await runInScope(
      bootstrapScope(authUser.id),
      async (tx) => {
        await tx.user.create({
          data: {
            id: authUser.id,
            name,
            email,
            status: "ACTIVE",
          },
        });

        // Tenant is provisioned PENDING — an operator must activate it. The
        // creator becomes TENANT_OWNER of their own workspace.
        const tenant = await provisionTenant(tx, {
          name: tenantName,
          ownerUserId: authUser.id,
          createdById: authUser.id,
        });

        await appendAuditLog(tx, {
          userId: authUser.id,
          tenantId: tenant.tenantId,
          action: AUDIT_ACTIONS.AUTH_REGISTER,
          resource: "User",
          resourceId: authUser.id,
        });

        await recordTenantCreated(tx, {
          tenantId: tenant.tenantId,
          userId: authUser.id,
          slug: tenant.slug,
        });

        return { tenantId: tenant.tenantId };
      },
    );

    return {
      success: true,
      data: {
        userId: authUser.id,
        tenantId,
        emailConfirmationRequired: !data.session,
      },
    };
  } catch (err) {
    // Compensating action: remove the Auth user so the address is not stuck
    // in a half-registered state.
    try {
      const admin = createAdminSupabase();
      await admin.auth.admin.deleteUser(authUser.id);
    } catch (cleanupError) {
      console.error(
        "[registerAction] Failed to compensate Auth user",
        authUser.id,
        cleanupError,
      );
    }
    console.error("[registerAction] Provisioning failed:", err);
    return {
      success: false,
      error: "Something went wrong. Please try again later.",
    };
  }
}

/**
 * Server Action: Request a password reset email.
 *
 * Always returns success (identical shape regardless of whether the account
 * exists) to prevent account enumeration. The reset link is delivered by
 * Supabase Auth and lands on our callback route.
 */
export async function forgotPasswordAction(
  rawInput: unknown,
  locale = "en",
): Promise<ActionResult> {
  const allowed = await enforceAuthRateLimit("forgot-password", 5, HOUR_MS);
  if (!allowed) {
    // Still return success to avoid leaking that the caller was throttled.
    return { success: true };
  }

  const result = forgotPasswordSchema.safeParse(rawInput);
  if (!result.success) {
    return { success: false, error: "Invalid email address." };
  }

  const { email } = result.data;

  try {
    // Pre-session lookup again: the reset link is requested by somebody who has
    // no identity in this request yet.
    const user = await findUserIdByEmail(email);

    if (user && user.status === "ACTIVE") {
      const supabase = await createServerSupabase();
      const baseUrl = appUrl();

      await supabase.auth.resetPasswordForEmail(email, {
        ...(baseUrl
          ? {
              redirectTo: `${baseUrl}/auth/callback?next=/${locale}/reset-password`,
            }
          : {}),
      });

      await recordAudit({
        action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
        userId: user.id,
        metadata: { email: maskEmail(email) },
      });
    }
  } catch (err) {
    // Swallow — never reveal internal errors or account existence.
    console.error("[forgotPasswordAction] error:", err);
  }

  return { success: true };
}

/**
 * Server Action: Set a new password for the signed-in user.
 *
 * The recovery link establishes a session through `/auth/callback` first, so
 * this action only accepts a new password — never a token. On success every
 * session (including this one) is revoked and must sign in again.
 */
export async function updatePasswordAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const allowed = await enforceAuthRateLimit("reset-password", 10, HOUR_MS);
  if (!allowed) {
    return {
      success: false,
      error: "Too many attempts. Try again later.",
      code: "RATE_LIMITED",
    };
  }

  const parsed = updatePasswordSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  // The caller must hold a live session (e.g. the recovery session created by
  // the email link). Revoked or suspended accounts cannot set passwords.
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return {
      success: false,
      error:
        "Your reset link is invalid or has expired. Request a new one and try again.",
      code: "UNAUTHENTICATED",
    };
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    console.error("[updatePasswordAction] update failed:", error.message);
    return {
      success: false,
      error: "Failed to update password. Please try again.",
    };
  }

  // Clear THIS browser's cookies first, then kill every session for the
  // account — the credential just changed, so nothing issued before now may
  // remain usable (the ban also signs out every other device).
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Best effort: even if cookie clearing fails, the revocation below makes
    // the remaining cookie unusable.
  }

  await revokeUserSessions(sessionUser.id);

  await recordAudit({
    action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET,
    userId: sessionUser.id,
    resource: "User",
    resourceId: sessionUser.id,
  });

  return { success: true };
}
