"use server";

import { requireAuth } from "@/lib/auth/helpers";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  grantSupportAccessSchema,
  revokeSupportAccessSchema,
} from "@/lib/validations/support";
import {
  createSupportGrant,
  revokeSupportGrant,
  SupportAccessError,
} from "@/server/services/support-access";
import { invalidInput } from "@/server/actions/_shared";
import type { ActionResult } from "@/lib/errors";

/**
 * Provider support access actions (platform super admin only).
 *
 * `platform.support.grant` is the single permission that opens this door, and it
 * belongs to the platform domain — no tenant role, however senior, can reach it.
 * Each call writes a `SupportAccessGrant` row plus an audit event; the reads a
 * grant then makes possible are audited one by one by the authorization service.
 */

function supportAuthzError<T = void>(error: unknown): ActionResult<T> {
  if (error instanceof Error) {
    return { success: false, error: error.message, code: "FORBIDDEN" };
  }
  return {
    success: false,
    error: "You are not permitted to perform this action.",
    code: "FORBIDDEN",
  };
}

export async function grantSupportAccessAction(
  rawInput: unknown,
): Promise<ActionResult<{ grantId: string }>> {
  const session = await requireAuth();

  try {
    await authorizePlatform(
      session.user.id,
      PERMISSIONS.PLATFORM_SUPPORT_GRANT,
    );
  } catch (err) {
    return supportAuthzError(err);
  }

  const parsed = grantSupportAccessSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid support grant request.");
  }

  try {
    const grant = await createSupportGrant({
      actorId: session.user.id,
      tenantId: parsed.data.tenantId,
      platformUserId: parsed.data.platformUserId,
      reason: parsed.data.reason,
      durationHours: parsed.data.durationHours,
    });

    return { success: true, data: { grantId: grant.id } };
  } catch (err) {
    if (err instanceof SupportAccessError) {
      return { success: false, error: err.message, code: "FORBIDDEN" };
    }
    console.error("[grantSupportAccessAction]", err);
    return {
      success: false,
      error: "Failed to record the support grant.",
      code: "INTERNAL",
    };
  }
}

export async function revokeSupportAccessAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizePlatform(
      session.user.id,
      PERMISSIONS.PLATFORM_SUPPORT_GRANT,
    );
  } catch (err) {
    return supportAuthzError(err);
  }

  const parsed = revokeSupportAccessSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid revocation request.");
  }

  try {
    await revokeSupportGrant({
      actorId: session.user.id,
      grantId: parsed.data.grantId,
      reason: parsed.data.reason,
    });

    return { success: true };
  } catch (err) {
    if (err instanceof SupportAccessError) {
      return { success: false, error: err.message, code: "NOT_FOUND" };
    }
    console.error("[revokeSupportAccessAction]", err);
    return {
      success: false,
      error: "Failed to revoke support access.",
      code: "INTERNAL",
    };
  }
}
