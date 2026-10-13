"use server";

import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { updateTenantBrandingSchema, logoUploadSchema, type UpdateTenantBrandingInput } from "@/lib/validations/branding";
import type { Prisma } from "@prisma/client";
import type { ActionResult } from "@/lib/errors";

function authzError<T = void>(error: unknown): ActionResult<T> {
  if (error instanceof Error && /not permitted|access/i.test(error.message)) {
    return { success: false, error: error.message };
  }
  return {
    success: false,
    error: "You are not permitted to perform this action.",
  };
}

function validateColourContrast(primary: string, foreground: string): boolean {
  const getLuminance = (hex: string) => {
    const rgb = parseInt(hex.replace("#", ""), 16);
    const r = ((rgb >> 16) & 255) / 255;
    const g = ((rgb >> 8) & 255) / 255;
    const b = (rgb & 255) / 255;
    const srgb = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  };
  const l1 = getLuminance(primary);
  const l2 = getLuminance(foreground);
  const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return contrast >= 4.5;
}

export async function updateTenantBrandingAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = updateTenantBrandingSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  if (data.primaryColor && data.primaryForeground) {
    if (!validateColourContrast(data.primaryColor, data.primaryForeground)) {
      return {
        success: false,
        error: "Insufficient contrast between primary colour and foreground. Minimum 4.5:1 required.",
        fieldErrors: { primaryForeground: ["Contrast ratio too low"] },
      };
    }
  }

  const updateData: Prisma.TenantBrandingUpdateInput = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== "") {
      updateData[key] = value;
    }
  }

  try {
    await prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, ...updateData },
      update: updateData,
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_UPDATED,
      userId: session.user.id,
      tenantId,
      resource: "TenantBranding",
      resourceId: tenantId,
      metadata: { fields: Object.keys(updateData) },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateTenantBrandingAction]", err);
    return { success: false, error: "Failed to update branding." };
  }
}

export async function getTenantBrandingAction(
  tenantId: string,
): Promise<ActionResult<{ branding: Prisma.TenantBrandingGetPayload<{}> | null }>> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  try {
    const branding = await prisma.tenantBranding.findUnique({
      where: { tenantId },
    });

    return { success: true, data: { branding } };
  } catch (err) {
    console.error("[getTenantBrandingAction]", err);
    return { success: false, error: "Failed to load branding." };
  }
}

export async function uploadLogoAction(
  rawInput: unknown,
): Promise<ActionResult<{ logoUrl: string }>> {
  const session = await requireAuth();

  const result = logoUploadSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid upload parameters.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, fileName, fileSize, fileType, width, height } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
  if (!allowedTypes.includes(fileType)) {
    return {
      success: false,
      error: "Invalid file type. Allowed: PNG, JPEG, WebP, SVG.",
      fieldErrors: { fileType: ["File type not allowed"] },
    };
  }

  if (fileSize > 5 * 1024 * 1024) {
    return {
      success: false,
      error: "File size must not exceed 5 MB.",
      fieldErrors: { fileSize: ["File too large"] },
    };
  }

  if (width > 2000 || height > 2000) {
    return {
      success: false,
      error: "Image dimensions must not exceed 2000x2000 pixels.",
      fieldErrors: { width: ["Dimensions too large"], height: ["Dimensions too large"] },
    };
  }

  const ext = fileType.split("/")[1];
  const storageKey = `tenants/${tenantId}/logo/${Date.now()}.${ext}`;
  const logoUrl = `/api/storage/${storageKey}`;

  try {
    await prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, logoUrl },
      update: { logoUrl },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_UPDATED,
      userId: session.user.id,
      tenantId,
      resource: "TenantBranding",
      resourceId: tenantId,
      metadata: { field: "logoUrl", storageKey },
    });

    return { success: true, data: { logoUrl } };
  } catch (err) {
    console.error("[uploadLogoAction]", err);
    return { success: false, error: "Failed to update logo." };
  }
}

export async function deleteLogoAction(
  tenantId: string,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  try {
    await prisma.tenantBranding.update({
      where: { tenantId },
      data: { logoUrl: null },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_UPDATED,
      userId: session.user.id,
      tenantId,
      resource: "TenantBranding",
      resourceId: tenantId,
      metadata: { field: "logoUrl", removed: true },
    });

    return { success: true };
  } catch (err) {
    console.error("[deleteLogoAction]", err);
    return { success: false, error: "Failed to remove logo." };
  }
}