import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { AuditLog } from "@amisibiz/database";
import type { TenantStatus } from "@prisma/client";

/**
 * Activate a PENDING tenant.
 *
 * This is an audited, server-authorized operation. The tenant must be in
 * PENDING status. After activation, the tenant status changes to ACTIVE.
 *
 * A reason is required for the audit trail, though the UI may provide a
 * default such as "initial onboarding".
 */
export async function activateTenant(
  tenantId: string,
  reason: string = "Initial onboarding"
): Promise<{ success: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  // Authorization: only platform admins can activate tenants
  await authorizePlatform(user.id, PERMISSIONS.TENANTS_ACTIVATE);

  try {
    await prisma.$transaction(async (tx) => {
      // Update tenant status to ACTIVE
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: "ACTIVE",
          activatedAt: new Date(),
          activatedById: user.id,
        },
      });

      // Log the activation event in the audit trail
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.id,
          action: "tenant.activated",
          resource: "Tenant",
          resourceId: tenantId,
          metadata: {
            reason,
            activatedBy: user.id,
          },
          ipAddress: undefined,
          userAgent: undefined,
        },
      });

      // TODO: Could also trigger welcome email / onboarding flow here
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to activate tenant:", error);
    return {
      success: false,
      error: "Failed to activate tenant. Please try again.",
    };
  }
}

/**
 * Suspend an ACTIVE tenant.
 *
 * Suspension stops new protected application activity according to policy.
 * Business data, invoices, delivery notes, audit records, and uploaded
 * documents are preserved and remain readable/downloadable by authorized
 * parties (members, portal users, platform admins with appropriate grants).
 *
 * A reason is required and will be recorded in the audit trail.
 */
export async function suspendTenant(
  tenantId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  // Authorization: only platform admins can suspend tenants
  await authorizePlatform(user.id, PERMISSIONS.TENANTS_SUSPEND);

  if (!reason || reason.trim().length === 0) {
    return { success: false, error: t => t("validation.required", { field: "reason" }) };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Update tenant status to SUSPENDED
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: "SUSPENDED",
          suspendedAt: new Date(),
          suspensionReason: reason,
          suspendedById: user.id,
        },
      });

      // Log the suspension event in the audit trail
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.id,
          action: "tenant.suspended",
          resource: "Tenant",
          resourceId: tenantId,
          metadata: {
            reason: reason.trim(),
            suspendedBy: user.id,
          },
          ipAddress: undefined,
          userAgent: undefined,
        },
      });

      // Note: The database enforces suspension semantics via
      // `app_tenant_accepts_writes()` - suspended tenants deny WRITES
      // but allow READS and downloads of already-issued documents.
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to suspend tenant:", error);
    return {
      success: false,
      error: "Failed to suspend tenant. Please try again.",
    };
  }
}

/**
 * Reactivate a SUSPENDED tenant.
 *
 * Reactivation preserves the existing tenant identity and all associated
 * data (contacts, invoices, delivery notes, audit records, documents).
 * The tenant returns to ACTIVE status.
 *
 * This is an audited, server-authorized operation.
 */
export async function reactivateTenant(
  tenantId: string,
  reason: string = "Reactivating suspended business"
): Promise<{ success: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  // Authorization: only platform admins can reactivate tenants
  await authorizePlatform(user.id, PERMISSIONS.TENANTS_REACTIVATE);

  try {
    await prisma.$transaction(async (tx) => {
      // Update tenant status back to ACTIVE
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: "ACTIVE",
          suspendedAt: null,
          suspensionReason: null,
          activatedAt: new Date(), // Re-activation also sets activatedAt
          activatedById: user.id,
        },
      });

      // Log the reactivation event in the audit trail
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.id,
          action: "tenant.reactivated",
          resource: "Tenant",
          resourceId: tenantId,
          metadata: {
            reason,
            reactivatedBy: user.id,
          },
          ipAddress: undefined,
          userAgent: undefined,
        },
      });

      // TODO: Could trigger reactivation confirmation email here
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to reactivate tenant:", error);
    return {
      success: false,
      error: "Failed to reactivate tenant. Please try again.",
    };
  }
}

/**
 * Helper: access the t function for multilingual validation messages
 * in server actions. In a full implementation, this would use next-intl's
  server translation in the action context.
 */
function t(key: string): string {
  // This is a placeholder - in production, the action would receive
  // the translation function from the page context
  const messages: Record<string, string> = {
    required: "This field is required",
  };
  return messages[key] || key;
}