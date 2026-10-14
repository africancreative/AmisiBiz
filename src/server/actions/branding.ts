"use server";

import { type TenantBranding } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  updateTenantBrandingSchema,
  brandingFieldsSchema,
} from "@/lib/validations/branding";
import { meetsContrastMinimum } from "@/lib/branding/contrast";
import { z } from "zod";

const tenantLocatorSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
});

/**
 * Build the write payload from the validated fields only.
 *
 * Free-text fields treat an empty string as "clear this value" — that is the
 * only way a business can remove a website or footer it previously saved.
 * Colour, currency and layout fields are never nullable (the row keeps a
 * documented default), so an empty value there is a validation failure rather
 * than a silent reset.
 */
type BrandingPatch = {
  displayName?: string | null;
  registeredName?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  primaryForeground?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  postalAddress?: string | null;
  physicalAddress?: string | null;
  website?: string | null;
  taxPin?: string | null;
  currency?: string;
  defaultFooter?: string | null;
  paymentInstructions?: string | null;
  documentLayout?: "standard" | "compact" | "detailed";
};

function toBrandingPatch(
  data: z.infer<typeof brandingFieldsSchema>,
): BrandingPatch {
  const clearable = (value: string | undefined): string | null =>
    value === undefined ? null : value.trim() || null;

  const patch: BrandingPatch = {};

  if (data.displayName !== undefined)
    patch.displayName = clearable(data.displayName);
  if (data.registeredName !== undefined)
    patch.registeredName = clearable(data.registeredName);
  if (data.primaryColor !== undefined) patch.primaryColor = data.primaryColor;
  if (data.secondaryColor !== undefined)
    patch.secondaryColor = data.secondaryColor;
  if (data.accentColor !== undefined) patch.accentColor = data.accentColor;
  if (data.primaryForeground !== undefined)
    patch.primaryForeground = data.primaryForeground;
  if (data.contactEmail !== undefined)
    patch.contactEmail = clearable(data.contactEmail?.toLowerCase());
  if (data.contactPhone !== undefined)
    patch.contactPhone = clearable(data.contactPhone);
  if (data.postalAddress !== undefined)
    patch.postalAddress = clearable(data.postalAddress);
  if (data.physicalAddress !== undefined)
    patch.physicalAddress = clearable(data.physicalAddress);
  if (data.website !== undefined) {
    // Only an absolute http(s) URL survived validation; anything else (e.g.
    // `javascript:`) was rejected by the schema.
    patch.website = data.website.trim() || null;
  }
  if (data.taxPin !== undefined) patch.taxPin = clearable(data.taxPin);
  if (data.currency !== undefined) patch.currency = data.currency;
  if (data.defaultFooter !== undefined)
    patch.defaultFooter = clearable(data.defaultFooter);
  if (data.paymentInstructions !== undefined)
    patch.paymentInstructions = clearable(data.paymentInstructions);
  if (data.documentLayout !== undefined)
    patch.documentLayout = data.documentLayout;

  return patch;
}

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

  // Contrast is enforced server-side, not just in the form: a direct call with
  // unreadable colours must still be rejected.
  if (data.primaryColor && data.primaryForeground) {
    if (!meetsContrastMinimum(data.primaryColor, data.primaryForeground)) {
      return {
        success: false,
        error:
          "Insufficient contrast between primary colour and foreground. Minimum 4.5:1 required.",
        code: "VALIDATION_ERROR",
        fieldErrors: { primaryForeground: ["Contrast ratio too low"] },
      };
    }
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
