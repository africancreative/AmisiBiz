"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import {
  bootstrapScope,
  prisma,
  runInScope,
} from "@amisibiz/database";
import {
  registerSchema,
  forgotPasswordSchema,
  loginSchema,
  updatePasswordSchema,
} from "@/lib/validations/auth";
import { maskEmail } from "@/lib/utils";
import { getSessionUser } from "@/lib/auth/session-user";
import { findUserIdByEmail } from "@/lib/auth/user-lookup";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
} from "@/lib/auth/token";
import { appendAuditLog, recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  provisionTenant,
  recordTenantCreated,
} from "@/server/services/tenant-provisioning";
import type { ActionResult } from "@/lib/errors";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

async function enforceAuthRateLimit(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const ip = (await getClientIp()) ?? "unknown";
  const result = await rateLimit(`${bucket}:${ip}`, { limit, windowMs });
  return result.success;
}

async function setSessionCookie(
  userId: string,
  sessionVersion: number,
  platformRole?: string | null,
) {
  const token = await createSessionToken({ userId, sessionVersion, platformRole });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Server Action: Authenticate with email + password directly against PostgreSQL on Neon.
 */
export async function loginAction(
  rawInput: unknown,
): Promise<ActionResult<{ userId: string; platformRole?: string | null }>> {
  const ip = (await getClientIp()) ?? "unknown";

  const allowed = await enforceAuthRateLimit("login", 10, MINUTE_MS);
  if (!allowed) {
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

  const emailAllowed = await rateLimit(`login:email:${email.toLowerCase()}`, {
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

  // Look up user directly in Neon PostgreSQL
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      status: true,
      sessionVersion: true,
      passwordHash: true,
      platformRole: true,
    },
  });

  if (!user || !user.passwordHash) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
      metadata: { email: maskEmail(email) },
      ipAddress: ip,
    });
    return { success: false, error: "Invalid email or password." };
  }

  if (user.status !== "ACTIVE") {
    return {
      success: false,
      error: "Your account has been suspended. Contact support.",
    };
  }

  const passwordsMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordsMatch) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_SIGN_IN_FAILED,
      metadata: { email: maskEmail(email) },
      ipAddress: ip,
    });
    return { success: false, error: "Invalid email or password." };
  }

  // Set the authenticated session cookie
  await setSessionCookie(user.id, user.sessionVersion, user.platformRole);

  await recordAudit({
    action: AUDIT_ACTIONS.AUTH_SIGN_IN,
    userId: user.id,
    resource: "User",
    resourceId: user.id,
    ipAddress: ip,
  });

  return {
    success: true,
    data: { userId: user.id, platformRole: user.platformRole },
  };
}

/**
 * Server Action: Sign out of the current session.
 */
export async function logoutAction(): Promise<ActionResult> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  cookieStore.delete(SESSION_COOKIE_NAME);

  if (token) {
    try {
      const user = await getSessionUser();
      if (user) {
        await recordAudit({
          action: AUDIT_ACTIONS.AUTH_SIGN_OUT,
          userId: user.id,
          resource: "User",
          resourceId: user.id,
        });
      }
    } catch {
      // Best-effort audit logging on sign-out
    }
  }

  return { success: true };
}

/**
 * Server Action: Register a new user and create their initial tenant.
 */
export async function registerAction(
  rawInput: unknown,
  _locale = "en",
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
  const normalizedEmail = email.toLowerCase().trim();

  const existingUser = await findUserIdByEmail(normalizedEmail);
  if (existingUser) {
    return {
      success: false,
      error: "An account with this email already exists.",
      fieldErrors: { email: ["An account with this email already exists."] },
    };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const userId = crypto.randomUUID();

  try {
    const { tenantId } = await runInScope(
      bootstrapScope(userId),
      async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            name,
            email: normalizedEmail,
            passwordHash,
            status: "ACTIVE",
            sessionVersion: 0,
          },
        });

        const tenant = await provisionTenant(tx, {
          name: tenantName,
          ownerUserId: userId,
          createdById: userId,
        });

        await appendAuditLog(tx, {
          userId,
          tenantId: tenant.tenantId,
          action: AUDIT_ACTIONS.AUTH_REGISTER,
          resource: "User",
          resourceId: userId,
        });

        await recordTenantCreated(tx, {
          tenantId: tenant.tenantId,
          userId,
          slug: tenant.slug,
        });

        return { tenantId: tenant.tenantId };
      },
    );

    // Auto sign-in on registration
    await setSessionCookie(userId, 0);

    return {
      success: true,
      data: {
        userId,
        tenantId,
        emailConfirmationRequired: false,
      },
    };
  } catch (err) {
    console.error("[registerAction] Provisioning failed:", err);
    return {
      success: false,
      error: "Something went wrong. Please try again later.",
    };
  }
}

/**
 * Server Action: Request a password reset.
 */
export async function forgotPasswordAction(
  rawInput: unknown,
  _locale = "en",
): Promise<ActionResult> {
  const allowed = await enforceAuthRateLimit("forgot-password", 5, HOUR_MS);
  if (!allowed) {
    return { success: true };
  }

  const result = forgotPasswordSchema.safeParse(rawInput);
  if (!result.success) {
    return { success: false, error: "Invalid email address." };
  }

  const { email } = result.data;

  try {
    const user = await findUserIdByEmail(email.toLowerCase().trim());
    if (user && user.status === "ACTIVE") {
      await recordAudit({
        action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
        userId: user.id,
        metadata: { email: maskEmail(email) },
      });
    }
  } catch (err) {
    console.error("[forgotPasswordAction] error:", err);
  }

  return { success: true };
}

/**
 * Server Action: Set a new password for the signed-in user.
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

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return {
      success: false,
      error: "You must be signed in to change your password.",
      code: "UNAUTHENTICATED",
    };
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  await prisma.user.update({
    where: { id: sessionUser.id },
    data: {
      passwordHash,
      sessionVersion: { increment: 1 },
    },
  });

  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);

  await recordAudit({
    action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET,
    userId: sessionUser.id,
    resource: "User",
    resourceId: sessionUser.id,
  });

  return { success: true };
}
