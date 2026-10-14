"use server";

import { type TenantBranding } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/helpers";
import {
  authorizeTenant,
  assertWritableContext,
} from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import { updateTenantBrandingSchema } from "@/lib/validations/branding";
import {
  contrastProblemFor,
  toBrandingPatch,
} from "@/server/services/branding-patch";

const tenantLocatorSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
});

export async function updateTenantBrandingAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateTenantBrandingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateTenantBrandingAction");
  }

  // A provider-support context is read-only; the matrix never grants a support
  // grant this permission, and this refuses it independently of the matrix.
  try {
    await assertWritableContext(context);
  } catch (err) {
    return authorizationFailure(err, "updateTenantBrandingAction");
  }

  // Contrast is enforced server-side, not just in the form: a direct call with
  // unreadable colours must still be rejected.
  const contrast = contrastProblemFor(data);
  if (contrast) {
    return {
      success: false,
      error: contrast,
      code: "VALIDATION_ERROR",
      fieldErrors: { primaryForeground: ["Contrast ratio too low"] },
    };
  }

  const patch = toBrandingPatch(data);

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.tenantBranding.findUnique({
        where: { tenantId: context.tenantId },
        select: { id: true },
      });

      if (existing) {
        await tx.tenantBranding.update({
          where: { id: existing.id },
          data: patch,
        });
      } else {
        await tx.tenantBranding.create({
          data: { tenantId: context.tenantId, ...patch },
        });
      }
    });

    await recordAudit({
      action: AUDIT_ACTIONS.BRANDING_UPDATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "TenantBranding",
      resourceId: context.tenantId,
      // Which fields changed, never the address/PIN values themselves.
      metadata: { fields: Object.keys(patch), section: "branding" },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateTenantBrandingAction]", err);
    return fail("Failed to update branding.", { code: "INTERNAL" });
  }
}

export async function getTenantBrandingAction(tenantId: string): Promise<
  ActionResult<{
    branding: TenantBranding | null;
  }>
> {
  const session = await requireAuth();

  const parsed = tenantLocatorSchema.safeParse({ tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getTenantBrandingAction");
  }

  try {
    const branding = await prisma.tenantBranding.findUnique({
      where: { tenantId: context.tenantId },
    });

    return { success: true, data: { branding } };
  } catch (err) {
    console.error("[getTenantBrandingAction]", err);
    return fail("Failed to load branding.", { code: "INTERNAL" });
  }
}

export async function deleteLogoAction(
  tenantId: string,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = tenantLocatorSchema.safeParse({ tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "deleteLogoAction");
  }

  try {
    await assertWritableContext(context);
  } catch (err) {
    return authorizationFailure(err, "deleteLogoAction");
  }

  try {
    const branding = await prisma.tenantBranding.findUnique({
      where: { tenantId: context.tenantId },
      select: { id: true, logoUrl: true },
    });

    if (!branding?.logoUrl) {
      return fail("No logo is set.", { code: "NOT_FOUND" });
    }

    await prisma.tenantBranding.update({
      where: { id: branding.id },
      data: { logoUrl: null },
    });

    // The stored file lives under the tenant's private upload prefix; removing
    // the reference makes it unreachable through the serving route, which
    // re-checks membership on every read.
    await recordAudit({
      action: AUDIT_ACTIONS.BRANDING_LOGO_DELETED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "TenantBranding",
      resourceId: context.tenantId,
      metadata: { field: "logoUrl", removed: true },
    });

    return { success: true };
  } catch (err) {
    console.error("[deleteLogoAction]", err);
    return fail("Failed to remove logo.", { code: "INTERNAL" });
  }
}
