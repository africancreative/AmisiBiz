"use server";

import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  platformCreateTenantSchema,
  suspendTenantSchema,
  tenantIdSchema,
} from "@/lib/validations/tenant";
import {
  provisionTenant,
  recordTenantCreated,
} from "@/server/services/tenant-provisioning";
import { addDays } from "date-fns";
import { randomBytes } from "crypto";
import { hashAccountToken } from "@/lib/auth/tokens";
import type { ActionResult } from "@/lib/errors";

function platformAuthzError<T = void>(error: unknown): ActionResult<T> {
  if (error instanceof Error) {
    return { success: false, error: error.message };
  }
  return {
    success: false,
    error: "You are not permitted to perform this action.",
  };
}

/**
 * Server Action: Provision a new tenant (platform operator only).
 *
 * The tenant is created PENDING and must be activated separately. When an owner
 * email is supplied, a BUSINESS_OWNER invitation is issued — the recipient must
 * accept it while signed in with the matching address, so ownership is never
 * granted from a submitted email alone.
 */
export async function createTenantAction(
  rawInput: unknown,
): Promise<ActionResult<{ tenantId: string; slug: string }>> {
  const session = await requireAuth();

  try {
    await authorizePlatform(
      session.user.id,
      PERMISSIONS.PLATFORM_TENANTS_CREATE,
    );
  } catch (err) {
    return platformAuthzError(err);
  }

  const parsed = platformCreateTenantSchema.safeParse(rawInput);
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

  const { ownerEmail, ...tenantInput } = parsed.data;

  try {
    const provisioned = await prisma.$transaction(async (tx) => {
      const tenant = await provisionTenant(tx, tenantInput);

      await recordTenantCreated(tx, {
        tenantId: tenant.tenantId,
        userId: session.user.id,
        slug: tenant.slug,
      });

      if (ownerEmail) {
        const token = randomBytes(32).toString("hex");
        const tokenHash = hashAccountToken(token);
        const invitation = await tx.invitation.upsert({
          where: {
            tenantId_email: { tenantId: tenant.tenantId, email: ownerEmail },
          },
          create: {
            tenantId: tenant.tenantId,
            email: ownerEmail,
            role: "BUSINESS_OWNER",
            invitedBy: session.user.id,
            expiresAt: addDays(new Date(), 7),
            status: "PENDING",
            tokenHash,
          },
          update: {
            role: "BUSINESS_OWNER",
            invitedBy: session.user.id,
            expiresAt: addDays(new Date(), 7),
            status: "PENDING",
            tokenHash,
          },
          select: { id: true },
        });

        await tx.auditLog.create({
          data: {
            userId: session.user.id,
            tenantId: tenant.tenantId,
            action: AUDIT_ACTIONS.PLATFORM_TENANT_OWNER_INVITED,
            resource: "Invitation",
            resourceId: invitation.id,
            metadata: { email: ownerEmail },
          },
        });
      }

      return tenant;
    });

    return {
      success: true,
      data: { tenantId: provisioned.tenantId, slug: provisioned.slug },
    };
  } catch (err) {
    console.error("[createTenantAction]", err);
    return { success: false, error: "Failed to create organisation." };
  }
}

/**
 * Server Action: Suspend an ACTIVE tenant (platform operator only).
 * Requires a reason. Data is preserved; all workspace access is blocked.
 */
export async function suspendTenantAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizePlatform(
      session.user.id,
      PERMISSIONS.PLATFORM_TENANTS_SUSPEND,
    );
  } catch (err) {
    return platformAuthzError(err);
  }

  const parsed = suspendTenantSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      error: "A suspension reason is required.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  const { tenantId, reason } = parsed.data;

  try {
    // Atomic transition guard: only an ACTIVE tenant may be suspended.
    const result = await prisma.tenant.updateMany({
      where: { id: tenantId, status: "ACTIVE" },
      data: {
        status: "SUSPENDED",
        suspendedAt: new Date(),
        suspendedById: session.user.id,
        suspensionReason: reason,
      },
    });

    if (result.count !== 1) {
      return {
        success: false,
        error: "Only an active organisation can be suspended.",
      };
    }

    await recordAudit({
      action: AUDIT_ACTIONS.PLATFORM_TENANT_SUSPENDED,
      userId: session.user.id,
      tenantId,
      resource: "Tenant",
      resourceId: tenantId,
      metadata: { reason },
    });

    return { success: true };
  } catch (err) {
    console.error("[suspendTenantAction]", err);
    return { success: false, error: "Failed to suspend organisation." };
  }
}

/**
 * Server Action: Activate a PENDING tenant (platform operator only).
 */
export async function activateTenantAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizePlatform(
      session.user.id,
      PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
    );
  } catch (err) {
    return platformAuthzError(err);
  }

  const parsed = tenantIdSchema.safeParse(
    typeof rawInput === "string" ? { tenantId: rawInput } : rawInput,
  );
  if (!parsed.success) {
    return { success: false, error: "Invalid tenant ID." };
  }

  const { tenantId } = parsed.data;

  try {
    // Only PENDING tenants may be activated; reactivation is a separate action.
    const result = await prisma.tenant.updateMany({
      where: { id: tenantId, status: "PENDING" },
      data: {
        status: "ACTIVE",
        activatedAt: new Date(),
        activatedById: session.user.id,
      },
    });

    if (result.count !== 1) {
      return {
        success: false,
        error: "Only a pending organisation can be activated.",
      };
    }

    await recordAudit({
      action: AUDIT_ACTIONS.PLATFORM_TENANT_ACTIVATED,
      userId: session.user.id,
      tenantId,
      resource: "Tenant",
      resourceId: tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("[activateTenantAction]", err);
    return { success: false, error: "Failed to activate organisation." };
  }
}

/**
 * Server Action: Reactivate a SUSPENDED tenant (platform operator only).
 * Clears the suspension metadata; data was preserved throughout suspension.
 */
export async function reactivateTenantAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizePlatform(
      session.user.id,
      PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
    );
  } catch (err) {
    return platformAuthzError(err);
  }

  const parsed = tenantIdSchema.safeParse(
    typeof rawInput === "string" ? { tenantId: rawInput } : rawInput,
  );
  if (!parsed.success) {
    return { success: false, error: "Invalid tenant ID." };
  }

  const { tenantId } = parsed.data;

  try {
    const result = await prisma.tenant.updateMany({
      where: { id: tenantId, status: "SUSPENDED" },
      data: {
        status: "ACTIVE",
        suspendedAt: null,
        suspendedById: null,
        suspensionReason: null,
      },
    });

    if (result.count !== 1) {
      return {
        success: false,
        error: "Only a suspended organisation can be reactivated.",
      };
    }

    await recordAudit({
      action: AUDIT_ACTIONS.PLATFORM_TENANT_REACTIVATED,
      userId: session.user.id,
      tenantId,
      resource: "Tenant",
      resourceId: tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("[reactivateTenantAction]", err);
    return { success: false, error: "Failed to reactivate organisation." };
  }
}
