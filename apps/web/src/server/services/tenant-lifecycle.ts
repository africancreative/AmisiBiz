import { AUDIT_ACTIONS } from "@/lib/audit";
import { PERMISSIONS, type Permission } from "@amisibiz/auth";
import type { TenantStatus } from "@prisma/client";

/**
 * The tenant lifecycle the provider console can actually reach (Phase 2).
 *
 * This table is the single source for three things that must never disagree:
 * the buttons the administration UI renders, the refusals the Server Actions
 * return, and the list of implemented transitions in the administrator
 * documentation. It lives in a service module rather than the `"use server"`
 * action file because Next.js only allows functions to be exported from a
 * Server Action module — and the UI has to read the same data the server writes.
 *
 * Two pairs are deliberately absent, and that is a decision rather than an
 * oversight:
 *
 *  - PENDING → SUSPENDED: you cannot suspend a workspace that was never opened.
 *    Leave it PENDING and it still writes nothing (authorization refuses a
 *    PENDING tenant outright).
 *  - SUSPENDED → PENDING: sending a live business back to "not yet activated"
 *    would silently change what its activation date means for its own records,
 *    and its history would lose the fact that it ever went live.
 *
 * Suspension is only ever decided by a human operator holding
 * `platform.tenants.suspend`. There is no job, trigger, cron or scheduled check
 * anywhere in this repository that moves a tenant's status because a payment is
 * overdue — the MVP is manual by design.
 *
 * `permission` is part of the table for the same reason the audit action is: the
 * Server Action that performs a transition must authorize against the permission
 * belonging to THAT transition before it writes, so "activate" cannot borrow a
 * suspension operator's authority and a suspend-only operator cannot reactivate.
 */
export const TENANT_STATUS_TRANSITIONS = [
  {
    key: "activate",
    fromStatus: "PENDING",
    toStatus: "ACTIVE",
    permission: PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
    action: AUDIT_ACTIONS.PLATFORM_TENANT_ACTIVATED,
    failureMessage: "Only a pending organisation can be activated.",
    logLabel: "activateTenantAction",
  },
  {
    key: "suspend",
    fromStatus: "ACTIVE",
    toStatus: "SUSPENDED",
    permission: PERMISSIONS.PLATFORM_TENANTS_SUSPEND,
    action: AUDIT_ACTIONS.PLATFORM_TENANT_SUSPENDED,
    failureMessage: "Only an active organisation can be suspended.",
    logLabel: "suspendTenantAction",
  },
  {
    key: "reactivate",
    fromStatus: "SUSPENDED",
    toStatus: "ACTIVE",
    // Reactivation returns a workspace to life, so it belongs to the activation
    // permission ("Activate (or reactivate) a tenant"), not the suspension one:
    // an operator may be trusted to pause a business without being trusted to
    // bring it back.
    permission: PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
    action: AUDIT_ACTIONS.PLATFORM_TENANT_REACTIVATED,
    failureMessage: "Only a suspended organisation can be reactivated.",
    logLabel: "reactivateTenantAction",
  },
] as const satisfies readonly {
  key: string;
  fromStatus: TenantStatus;
  toStatus: TenantStatus;
  permission: Permission;
  action: string;
  failureMessage: string;
  logLabel: string;
}[];

export type TenantTransitionKey =
  (typeof TENANT_STATUS_TRANSITIONS)[number]["key"];

export type TenantTransitionDescriptor =
  (typeof TENANT_STATUS_TRANSITIONS)[number];

/** Raised when the tenant is not in the state the transition requires. */
export class StatusTransitionError extends Error {}

export function transitionDescriptor(
  key: TenantTransitionKey,
): TenantTransitionDescriptor {
  const descriptor = TENANT_STATUS_TRANSITIONS.find(
    (candidate) => candidate.key === key,
  );

  // Unreachable while the key type is respected; kept as a runtime refusal so a
  // caller cannot invent a transition by casting.
  if (!descriptor) {
    throw new StatusTransitionError("Unknown status transition.");
  }

  return descriptor;
}

/** The transitions a tenant in this status can be taken through, in order. */
export function availableTransitions(
  status: TenantStatus,
): TenantTransitionDescriptor[] {
  return TENANT_STATUS_TRANSITIONS.filter(
    (transition) => transition.fromStatus === status,
  );
}
