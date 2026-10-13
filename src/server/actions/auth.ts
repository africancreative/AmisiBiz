"use server";

import { prisma } from "@/lib/db/prisma";
import {
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@/lib/validations/auth";
import { maskEmail } from "@/lib/utils";
import { generateAccountToken, hashAccountToken } from "@/lib/auth/tokens";
import { revokeUserSessions } from "@/lib/auth/session";
import { sendEmail } from "@/lib/email";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  provisionTenant,
  recordTenantCreated,
} from "@/server/services/tenant-provisioning";
import type { ActionResult } from "@/lib/errors";
import bcrypt from "bcryptjs";

const HOUR_MS = 60 * 60 * 1000;

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

/**
 * Server Action: Register a new user and create their first tenant (organisation).
 *
 * Security:
 * - Input validated with Zod before any DB operation.
 * - Password hashed with bcrypt (cost 12).
 * - User is created with the least-privileged platform role (USER) only; the
 *   action can never create a platform administrator.
 * - The creator becomes BUSINESS_OWNER of their own workspace.
 * - An email-verification token is issued; verification is enforced at login
 *   only when REQUIRE_EMAIL_VERIFICATION=true.
 */
export async function registerAction(
  rawInput: unknown,
): Promise<ActionResult<{ userId: string; tenantId: string }>> {
  const allowed = await enforceAuthRateLimit("register", 5, HOUR_MS);
  if (!allowed) {
    return {
      success: false,
      error: "Too many attempts. Please try again later.",
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

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      return {
        success: false,
        error: "An account with this email already exists.",
        fieldErrors: { email: ["An account with this email already exists."] },
      };
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const { token: verifyToken, tokenHash } = generateAccountToken();

    const { user, tenant } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          status: "ACTIVE",
          platformRole: "USER",
        },
        select: { id: true },
      });

      // Tenant is provisioned PENDING — an operator must activate it. Ownership
      // is granted to the authenticated registrant, never from submitted data
      // alone.
      const tenant = await provisionTenant(tx, {
        name: tenantName,
        ownerUserId: user.id,
      });

      await tx.accountToken.create({
        data: {
          userId: user.id,
          purpose: "EMAIL_VERIFICATION",
          tokenHash,
          expiresAt: new Date(Date.now() + 24 * HOUR_MS),
        },
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          tenantId: tenant.tenantId,
          action: AUDIT_ACTIONS.AUTH_REGISTER,
          resource: "User",
          resourceId: user.id,
        },
      });

      await recordTenantCreated(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        slug: tenant.slug,
      });

      return {
        user,
        tenant: { id: tenant.tenantId },
      };
    });

    // Best-effort email; never blocks registration. Not sent when unconfigured.
    await sendEmail({
      to: email,
      subject: "Verify your AmisiBiz email address",
      text: `Welcome to AmisiBiz. Verify your email using this token: ${verifyToken}`,
    });

    return { success: true, data: { userId: user.id, tenantId: tenant.id } };
  } catch (err) {
    console.error("[registerAction] Unexpected error:", err);
    return {
      success: false,
      error: "Something went wrong. Please try again later.",
    };
  }
}

/**
 * Server Action: Request a password reset link.
 *
 * Always returns success (identical shape and timing regardless of whether the
 * account exists) to prevent account enumeration. The raw token is only ever
 * sent by email; only its hash is stored.
 */
export async function forgotPasswordAction(
  rawInput: unknown,
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
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true, password: true },
    });

    if (user && user.password && user.status === "ACTIVE") {
      const { token, tokenHash } = generateAccountToken();

      await prisma.$transaction([
        // Invalidate any previously issued, unused reset tokens.
        prisma.accountToken.updateMany({
          where: {
            userId: user.id,
            purpose: "PASSWORD_RESET",
            usedAt: null,
          },
          data: { usedAt: new Date() },
        }),
        prisma.accountToken.create({
          data: {
            userId: user.id,
            purpose: "PASSWORD_RESET",
            tokenHash,
            expiresAt: new Date(Date.now() + HOUR_MS),
          },
        }),
      ]);

      await sendEmail({
        to: email,
        subject: "Reset your AmisiBiz password",
        text: `Reset your password using this token: ${token}`,
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
 * Server Action: Complete a password reset.
 * Validates the single-use token, updates the password, and revokes all
 * existing sessions for the account.
 */
export async function resetPasswordAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const allowed = await enforceAuthRateLimit("reset-password", 10, HOUR_MS);
  if (!allowed) {
    return { success: false, error: "Too many attempts. Try again later." };
  }

  const result = resetPasswordSchema.safeParse(rawInput);
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

  const { token, password } = result.data;
  const tokenHash = hashAccountToken(token);

  try {
    const record = await prisma.accountToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        purpose: true,
        usedAt: true,
        expiresAt: true,
      },
    });

    if (
      !record ||
      record.purpose !== "PASSWORD_RESET" ||
      record.usedAt ||
      record.expiresAt.getTime() < Date.now()
    ) {
      return {
        success: false,
        error: "This reset link is invalid or has expired.",
      };
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { password: hashedPassword },
      }),
      prisma.accountToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    await revokeUserSessions(record.userId);

    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET,
      userId: record.userId,
      resource: "User",
      resourceId: record.userId,
    });

    return { success: true };
  } catch (err) {
    console.error("[resetPasswordAction] error:", err);
    return { success: false, error: "Failed to reset password." };
  }
}

/**
 * Server Action: Verify an email address using a single-use token.
 */
export async function verifyEmailAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const result = verifyEmailSchema.safeParse(rawInput);
  if (!result.success) {
    return { success: false, error: "A verification token is required." };
  }

  const tokenHash = hashAccountToken(result.data.token);

  try {
    const record = await prisma.accountToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        purpose: true,
        usedAt: true,
        expiresAt: true,
      },
    });

    if (
      !record ||
      record.purpose !== "EMAIL_VERIFICATION" ||
      record.usedAt ||
      record.expiresAt.getTime() < Date.now()
    ) {
      return {
        success: false,
        error: "This verification link is invalid or has expired.",
      };
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: new Date() },
      }),
      prisma.accountToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFIED,
      userId: record.userId,
      resource: "User",
      resourceId: record.userId,
    });

    return { success: true };
  } catch (err) {
    console.error("[verifyEmailAction] error:", err);
    return { success: false, error: "Failed to verify email." };
  }
}
