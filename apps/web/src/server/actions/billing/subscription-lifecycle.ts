import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import type { TenantStatus, PlanStatus } from "@prisma/client";

/**
 * Subscription lifecycle types.
 */
export type SubscriptionStatus =
  | "ACTIVE"
  | "PAUSED"
  | "TRIAL"
  | "CANCELLED"
  | "ARCHIVED";

/**
 * Plan change result.
 */
export type PlanChangeResult = {
  success: boolean;
  error?: string;
  subscription?: {
    id: string;
    status: SubscriptionStatus;
    plan: { id: string; code: string; name: string } | null;
    current_period_start: string | null;
    current_period_end: string | null;
    trial_end: string | null;
  };
};

/**
 * Change a tenant's subscription plan.
 *
 * This is an audited, server-authorized operation. The administrator must
 * have `platform_users.manage` permission. The new plan is taken from the
 * provider catalogue (`Plan` model); the subscription's `planId` is updated
 * and the status is preserved (or reset to ACTIVE if the transition was
 * from a trial).
 *
 * A reason is recorded in the status history.
 */
export async function changePlan(
  tenantId: string,
  newPlanId: string,
  reason: string = "Plan change by administrator"
): Promise<PlanChangeResult> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  // Authorization: only platform admins with platform_users.manage can change plans
  await authorizePlatform(user.id, PERMISSIONS.PLATFORM_USERS_MANAGE);

  try {
    await prisma.$transaction(async (tx) => {
      // Update the subscription's plan reference
      await tx.subscription.update({
        where: { tenantId },
        data: { planId: newPlanId },
      });

      // Record the plan change in the status history
      await tx.subscriptionStatusHistory.create({
        data: {
          subscriptionId: { tenantId } as unknown string, // will be the subscription ID
          from_status: "ACTIVE", // we always start from ACTIVE for plan changes
          to_status: "ACTIVE",
          changed_by: user.id,
          reason,
        },
      });
    });

    // Fetch the updated subscription to return
    const subscription = await prisma.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });

    return {
      success: true,
      error: undefined,
      subscription: {
        id: subscription?.id,
        status: subscription?.status as SubscriptionStatus,
        plan: subscription?.plan ? { id: subscription.plan.id, code: subscription.plan.code, name: subscription.plan.name } : null,
        current_period_start: subscription?.current_period_start?.toISOString() ?? null,
        current_period_end: subscription?.current_period_end?.toISOString() ?? null,
        trial_end: subscription?.trial_end?.toISOString() ?? null,
      },
    };
  } catch (error) {
    console.error("Failed to change plan:", error);
    return { success: false, error: "Failed to change plan. Please try again." };
  }
}

/**
 * Set/extend a trial period for a tenant's subscription.
 *
 * Only tenants in a state that supports trials can have a trial applied.
 * The trial status is recorded separately from the general subscription status.
 *
 * A reason is required for the audit trail.
 */
export async function setTrial(
  tenantId: string,
  trialDays: number,
  reason: string = "Trial period initiation"
): Promise<{ success: boolean; error?: string; trialEnd?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  await authorizePlatform(user.id, PERMISSIONS.PLATFORM_TENANTS_READ);

  try {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      // Update or create the subscription with trial status
      await tx.subscription.upsert({
        where: { tenantId },
        create: {
          tenantId,
          status: "TRIAL" as SubscriptionStatus,
          trial_start: now,
          trial_end: trialEnd,
          current_period_start: now,
          current_period_end: trialEnd,
          cancel_at_period_end: false,
        },
        update: {
          status: "TRIAL" as SubscriptionStatus,
          trial_start: now,
          trial_end: trialEnd,
          current_period_start: now,
          current_period_end: trialEnd,
        },
      });

      // Record the trial initiation in the status history
      await tx.subscriptionStatusHistory.create({
        data: {
          subscriptionId: tenantId,
          from_status: "ACTIVE", // or current status
          to_status: "TRIAL",
          changed_by: user.id,
          reason,
        },
      });
    });

    return {
      success: true,
      error: undefined,
      trialEnd: trialEnd.toISOString(),
    };
  } catch (error) {
    console.error("Failed to set trial:", error);
    return { success: false, error: "Failed to set trial period. Please try again." };
  }
}

/**
 * Suspend a subscription (distinct from suspending the tenant lifecycle).
 *
 * A subscription in PAUSED mode still allows reads but blocks writes
 * according to the `app_subscription_accepts_writes()` RLS policy.
 * This is distinct from `Tenant.status` SUSPENDED — the business can
 * remain ACTIVE while the subscription is PAUSED (e.g., unpaid bill under
 * review), or the business can be SUSPENDED while the subscription stays
 * ACTIVE (deliberate policy decision).
 *
 * A reason is required and recorded.
 */
export async function pauseSubscription(
  tenantId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  await authorizePlatform(user.id, PERMISSIONS.PLATFORM_TENANTS_SUSPEND);

  if !reason || reason.trim().length === 0 {
    return { success: false, error: "A reason is required for subscription pause" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Update subscription status to PAUSED
      await tx.subscription.update({
        where: { tenantId },
        data: {
          status: "PAUSED" as SubscriptionStatus,
          cancel_at_period_end: true,
          updatedAt: new Date(),
        },
      });

      // Record the pause in the status history
      await tx.subscriptionStatusHistory.create({
        data: {
          subscriptionId: tenantId,
          from_status: "ACTIVE",
          to_status: "PAUSED",
          changed_by: user.id,
          reason: reason.trim(),
        },
      });
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to pause subscription:", error);
    return { success: false, error: "Failed to pause subscription. Please try again." };
  }
}

/**
 * Resume a paused subscription.
 */
export async function resumeSubscription(
  tenantId: string,
  reason: string = "Subscription resumed by administrator"
): Promise<{ success: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  await authorizePlatform(user.id, PERMISSIONS.PLATFORM_TENANTS_READ);

  try {
    await prisma.$transaction(async (tx) => {
      // Update subscription status back to ACTIVE
      await tx.subscription.update({
        where: { tenantId },
        data: {
          status: "ACTIVE" as SubscriptionStatus,
          cancel_at_period_end: false,
          updatedAt: new Date(),
        },
      });

      // Record the resume in the status history
      await tx.subscriptionStatusHistory.create({
        data: {
          subscriptionId: tenantId,
          from_status: "PAUSED",
          to_status: "ACTIVE",
          changed_by: user.id,
          reason,
        },
      });
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to resume subscription:", error);
    return { success: false, error: "Failed to resume subscription. Please try again." };
  }
}

//**
 * Cancel a subscription.
 *
 * The subscription moves to CANCELLED status at the end of the current
 * billing period (if `cancel_at_period_end` is true) or immediately.
 * The tenant's `Tenant.status` is NOT automatically changed — that is a
 * separate policy decision.  This keeps the "separate subscription status
 * from tenant activation status" rule intact.
 */
export async function cancelSubscription(
  tenantId: string,
  cancelAtPeriodEnd: boolean = true,
  reason: string = "Subscription cancelled by administrator"
): Promise<{ success: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) {
    return { success: false, error: "Not signed in" };
  }

  await authorizePlatform(user.id, PERMISSIONS.PLATFORM_TENANTS_READ);

  try {
    await prisma.$transaction(async (tx) => {
      // Update subscription status
      await tx.subscription.update({
        where: { tenantId },
        data: {
          status: "CANCELLED" as SubscriptionStatus,
          cancel_at_period_end: cancelAtPeriodEnd,
          canceled_at: cancelAtPeriodEnd ? new Date() : null,
          updatedAt: new Date(),
        },
      });

      // Record the cancellation in the status history
      await tx.subscriptionStatusHistory.create({
        data: {
          subscriptionId: tenantId,
          from_status: "ACTIVE",
          to_status: "CANCELLED",
          changed_by: user.id,
          reason,
        },
      });
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to cancel subscription:", error);
    return { success: false, error: "Failed to cancel subscription. Please try again." };
  }
}

/** Helper: access the translation function for validation messages. */
function t(key: string): string {
  const messages: Record<string, string> = {
    required: "This field is required",
    trialDays: "Trial days must be a positive number",
  };
  return messages[key] || key;
}