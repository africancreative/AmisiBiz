"use server";

import { prisma, type ScopedTx } from "@amisibiz/database";
import { requireAuth } from "@/lib/auth/helpers";
import {
  authorizePlatform,
  authorizePlatformTenant,
} from "@/server/auth/authorization";
import { PERMISSIONS, type Permission } from "@amisibiz/auth";
import { appendAuditLog, AUDIT_ACTIONS, type AuditEvent } from "@/lib/audit";
import { platformCreateTenantSchema } from "@/lib/validations/tenant";
import {
  statusTransitionSchema,
  platformUpdateTenantSchema,
  assignTenantPlanSchema,
  updateDocumentNumberingSchema,
  addTenantDomainSchema,
  setPrimaryDomainSchema,
  removeTenantDomainSchema,
  updateTenantSlugSchema,
  assignTenantOwnerSchema,
} from "@/lib/validations/platform-tenant";
import { updateTenantBrandingSchema } from "@/lib/validations/branding";
import {
  contrastProblemFor,
  toBrandingPatch,
} from "@/server/services/branding-patch";
import {
  StatusTransitionError,
  transitionDescriptor,
  type TenantTransitionKey,
} from "@/server/services/tenant-lifecycle";
import {
  provisionTenant,
  recordTenantCreated,
} from "@/server/services/tenant-provisioning";
import { addDays } from "date-fns";
import { randomBytes } from "crypto";
import { hashAccountToken } from "@/lib/auth/tokens";
import { invalidInput } from "@/server/actions/_shared";
import { fail, type ActionErrorCode, type ActionResult } from "@/lib/errors";
import type { Prisma, TenantStatus } from "@prisma/client";

function platformAuthzError<T = void>(error: unknown): ActionResult<T> {
  if (error instanceof Error) {
    return { success: false, error: error.message, code: "FORBIDDEN" };
  }
  return {
    success: false,
    error: "You are not permitted to perform this action.",
    code: "FORBIDDEN",
  };
}

/**
 * A provider write that authorization alone cannot decide — the row is not
 * there, the hostname is taken, the plan is retired. Thrown inside the
 * transaction so nothing is written, and reported with the message the operator
 * needs instead of a stack trace.
 */
class ProviderRefusalError extends Error {
  readonly code: ActionErrorCode;

  constructor(message: string, code: ActionErrorCode = "CONFLICT") {
    super(message);
    this.name = "ProviderRefusalError";
    this.code = code;
  }
}

/** The audit row a provider write wants appended, in the same transaction. */
type ProviderAudit = Omit<AuditEvent, "tenantId" | "userId">;

type ProviderWrite = {
  tenantId: string;
  actorId: string;
  permission: Permission;
  logLabel: string;
  /** Fallback wording for an unexpected failure — never the error itself. */
  failureMessage: string;
  work: (tx: ScopedTx) => Promise<ProviderAudit>;
};

/**
 * The shape every Phase 2 provider write goes through:
 *
 *  1. `authorizePlatformTenant` — the acting administrator's platform permission
 *     is re-checked from the database on EVERY request, and the request scope is
 *     opened for exactly the addressed tenant.
 *  2. One `prisma.$transaction` — the write and its audit row commit together, so
 *     a change that happened is never missing from the trail and a trail entry is
 *     never written for a change that did not happen.
 *  3. Failures return a typed `ActionResult`; unexpected errors are logged
 *     server-side only.
 *
 * Nothing in here reads a tenant id, a role or a status from the payload beyond
 * the addressing `tenantId`, which is only ever used to scope authorization.
 */
async function executeProviderWrite({
  tenantId,
  actorId,
  permission,
  logLabel,
  failureMessage,
  work,
}: ProviderWrite): Promise<ActionResult> {
  try {
    await authorizePlatformTenant(actorId, tenantId, permission);
  } catch (err) {
    return platformAuthzError(err);
  }

  try {
    await prisma.$transaction(async (tx: ScopedTx) => {
      const audit = await work(tx);
      await appendAuditLog(tx, { ...audit, tenantId, userId: actorId });
    });

    return { success: true };
  } catch (err) {
    if (err instanceof ProviderRefusalError) {
      return fail(err.message, { code: err.code });
    }
    console.error(`[${logLabel}]`, err);
    return fail(failureMessage, { code: "INTERNAL" });
  }
}

/**
 * Read the addressed tenant or refuse. The platform scope can see every tenant,
 * so a missing row here genuinely means "no such workspace" — and the answer is
 * the same generic refusal either way.
 */
async function requireTenant(
  tx: ScopedTx,
  tenantId: string,
): Promise<{
  id: string;
  slug: string;
  status: TenantStatus;
  planId: string | null;
}> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, slug: true, status: true, planId: true },
  });

  if (!tenant) {
    throw new ProviderRefusalError(
      "No organisation matches that reference.",
      "NOT_FOUND",
    );
  }

  return tenant;
}

type StatusTransition = {
  key: TenantTransitionKey;
  tenantId: string;
  actorId: string;
  /** Always present: every transition carries a recorded reason. */
  reason: string;
  /**
   * Written through the foreign-key scalars (`activatedById`, `suspendedById`)
   * rather than `connect`, because the actor id is already an authorized session
   * value and the unchecked shape keeps the literal-type check honest.
   */
  data: Prisma.TenantUncheckedUpdateInput;
};

/**
 * One tenant lifecycle transition, written atomically.
 *
 * The `WHERE status = <expected>` update is the concurrency guard (a second
 * operator racing the first moves zero rows and gets a clear refusal), and the
 * same transaction appends the `TenantStatusHistory` row and the audit event.
 * Splitting these three is how a status history ends up disagreeing with the
 * tenant it describes, so they never get the chance.
 *
 * `tenant_status_guard` refuses any status change whose context is not an active
 * platform admin, so this path cannot be reached by a workspace role even if the
 * matrix above were bypassed. The from/to pair, the audit action, the permission
 * the operator must hold and the refusal wording all come from
 * `TENANT_STATUS_TRANSITIONS` — the table the UI and the administrator
 * documentation read too.
 *
 * The authorization step is inside this function rather than in its three
 * callers for the reason the constitution demands: a status transition is a
 * privileged write, and the one place that performs it is the one place that
 * must not be able to forget the check.
 */
async function transitionTenantStatus(
  transition: StatusTransition,
): Promise<ActionResult> {
  let descriptor: ReturnType<typeof transitionDescriptor>;

  try {
    descriptor = transitionDescriptor(transition.key);
  } catch (err) {
    if (err instanceof StatusTransitionError) {
      return fail(err.message, { code: "VALIDATION_ERROR" });
    }
    throw err;
  }

  try {
    await authorizePlatformTenant(
      transition.actorId,
      transition.tenantId,
      descriptor.permission,
    );
  } catch (err) {
    return platformAuthzError(err);
  }

  try {
    await prisma.$transaction(async (tx: ScopedTx) => {
      const result = await tx.tenant.updateMany({
        where: { id: transition.tenantId, status: descriptor.fromStatus },
        data: transition.data,
      });

      if (result.count !== 1) {
        throw new StatusTransitionError(descriptor.failureMessage);
      }

      await tx.tenantStatusHistory.create({
        data: {
          tenantId: transition.tenantId,
          fromStatus: descriptor.fromStatus,
          toStatus: descriptor.toStatus,
          changedById: transition.actorId,
          reason: transition.reason,
        },
      });

      await appendAuditLog(tx, {
        action: descriptor.action,
        userId: transition.actorId,
        tenantId: transition.tenantId,
        resource: "Tenant",
        resourceId: transition.tenantId,
        metadata: { reason: transition.reason },
      });
    });

    return { success: true };
  } catch (err) {
    if (err instanceof StatusTransitionError) {
      return fail(err.message, { code: "CONFLICT" });
    }
    console.error(`[${descriptor.logLabel}]`, err);
    return fail("Failed to update organisation status.", { code: "INTERNAL" });
  }
}

/**
 * Server Action: Provision a new tenant (platform operator only).
 *
 * The tenant is created PENDING and must be activated separately. When an owner
 * email is supplied, a TENANT_OWNER invitation is issued — the recipient must
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
    return platformAuthzError<{ tenantId: string; slug: string }>(err);
  }

  const parsed = platformCreateTenantSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid input.");
  }

  const { ownerEmail, ...tenantInput } = parsed.data;

  try {
    const provisioned = await prisma.$transaction(async (tx) => {
      const tenant = await provisionTenant(tx, {
        ...tenantInput,
        createdById: session.user.id,
      });

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
            role: "TENANT_OWNER",
            invitedBy: session.user.id,
            expiresAt: addDays(new Date(), 7),
            status: "PENDING",
            tokenHash,
          },
          update: {
            role: "TENANT_OWNER",
            invitedBy: session.user.id,
            expiresAt: addDays(new Date(), 7),
            status: "PENDING",
            tokenHash,
          },
          select: { id: true },
        });

        await appendAuditLog(tx, {
          userId: session.user.id,
          tenantId: tenant.tenantId,
          action: AUDIT_ACTIONS.PLATFORM_TENANT_OWNER_INVITED,
          resource: "Invitation",
          resourceId: invitation.id,
          metadata: { email: ownerEmail },
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
    return fail("Failed to create organisation.", { code: "INTERNAL" });
  }
}

/**
 * Server Action: Suspend an ACTIVE tenant (platform operator only).
 *
 * Requires a reason. Suspension changes the tenant's `status` and records who
 * suspended it and why — it never deletes a business row and never touches a
 * storage object, which is why nothing in this file cascades, archives or
 * removes anything. What suspension means to the workspace itself is enforced one
 * layer down: reads and downloads of issued documents keep working, writes and
 * synchronization are refused (`authorizeTenant` + the write-aware policy
 * family), and every refusal becomes a `tenant.writeDenied` / `sync.rejected`
 * audit row the console can show.
 */
export async function suspendTenantAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = statusTransitionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "A suspension reason is required.");
  }

  const { tenantId, reason } = parsed.data;

  return transitionTenantStatus({
    key: "suspend",
    tenantId,
    actorId: session.user.id,
    reason,
    data: {
      status: "SUSPENDED",
      suspendedAt: new Date(),
      suspendedById: session.user.id,
      suspensionReason: reason,
    },
  });
}

/**
 * Server Action: Activate a PENDING tenant (platform operator only).
 *
 * Activation is manual on the MVP — the platform decides when a business goes
 * live, and nothing in the schema suspends a tenant on its own: there is no job,
 * trigger or check anywhere that moves a status because a payment is overdue.
 * The reason is still required, because "why did this workspace go live today"
 * is the other half of the same record.
 */
export async function activateTenantAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = statusTransitionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "An activation reason is required.");
  }

  const { tenantId, reason } = parsed.data;

  // Only PENDING tenants go through this action; a suspended one reactivates.
  return transitionTenantStatus({
    key: "activate",
    tenantId,
    actorId: session.user.id,
    reason,
    data: {
      status: "ACTIVE",
      activatedAt: new Date(),
      activatedById: session.user.id,
    },
  });
}

/**
 * Server Action: Reactivate a SUSPENDED tenant (platform operator only).
 *
 * Clears the suspension metadata; data was preserved throughout suspension, so
 * there is nothing to restore — the workspace simply starts accepting writes and
 * synchronization again on its next request. An offline device is the exception,
 * and it stays one: it keeps its cached rows until it next connects, and the
 * server records the refusal (or the accepted sync) at that moment.
 */
export async function reactivateTenantAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = statusTransitionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "A reactivation reason is required.");
  }

  const { tenantId, reason } = parsed.data;

  return transitionTenantStatus({
    key: "reactivate",
    tenantId,
    actorId: session.user.id,
    reason,
    data: {
      status: "ACTIVE",
      suspendedAt: null,
      suspendedById: null,
      suspensionReason: null,
    },
  });
}

/**
 * Server Action: Edit a tenant's profile (platform operator only).
 *
 * The provider edits the same identity/settings columns the workspace's own
 * settings screen shows — never its business data. `currency` here is the
 * workspace default; a document reads the branding row's currency first
 * (`branding.currency || tenant.currency`), which is why the branding form has
 * its own currency field.
 */
export async function updateTenantProfileAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = platformUpdateTenantSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid profile details.");
  }

  const { tenantId, ...fields } = parsed.data;

  const data: Prisma.TenantUncheckedUpdateInput = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.country !== undefined) data.country = fields.country;
  if (fields.currency !== undefined) data.currency = fields.currency;
  if (fields.timezone !== undefined) data.timezone = fields.timezone;
  if (fields.locale !== undefined) data.locale = fields.locale;

  const changedFields = Object.keys(data);
  if (changedFields.length === 0) {
    return fail("Nothing to update.", { code: "VALIDATION_ERROR" });
  }

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_UPDATE,
    logLabel: "updateTenantProfileAction",
    failureMessage: "Failed to update organisation profile.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      const updated = await tx.tenant.update({
        where: { id: tenant.id },
        data,
        select: { id: true },
      });

      // Field NAMES only: an address or a PIN is not audit-trail material.
      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_UPDATED,
        resource: "Tenant",
        resourceId: updated.id,
        metadata: { fields: changedFields },
      };
    },
  });
}

/**
 * Server Action: Move a tenant's workspace slug (platform operator only).
 *
 * The slug is the `<slug>.<baseDomain>` route, so changing it repoints the
 * business's primary address — which is why it sits behind
 * `platform.tenants.domain.manage` and is audited with the old and new values
 * (a slug is a routing identifier, not personal data). A tenant actor cannot move
 * it at all: `tenant_provider_columns_guard_update` refuses the column change
 * outside platform authority, even for a workspace owner.
 */
export async function updateTenantSlugAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateTenantSlugSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid slug.");
  }

  const { tenantId, slug } = parsed.data;

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
    logLabel: "updateTenantSlugAction",
    failureMessage: "Failed to update workspace slug.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      if (tenant.slug === slug) {
        throw new ProviderRefusalError(
          "That is already the current slug.",
          "VALIDATION_ERROR",
        );
      }

      const taken = await tx.tenant.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (taken) {
        // Never say which workspace holds it: the operator can try another name.
        throw new ProviderRefusalError(
          "That slug is already in use by another organisation.",
          "CONFLICT",
        );
      }

      await tx.tenant.update({ where: { id: tenant.id }, data: { slug } });

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_DOMAIN_UPDATED,
        resource: "Tenant",
        resourceId: tenant.id,
        metadata: { field: "slug", from: tenant.slug, to: slug },
      };
    },
  });
}

/**
 * Server Action: Add a custom hostname for a tenant (platform operator only).
 *
 * The first hostname a workspace gets becomes its primary, because a tenant with
 * exactly one domain has no other candidate and the console lists "primary" as a
 * fact rather than an empty column.
 */
export async function addTenantDomainAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = addTenantDomainSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid hostname.");
  }

  const { tenantId, hostname, setAsPrimary } = parsed.data;

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
    logLabel: "addTenantDomainAction",
    failureMessage: "Failed to add hostname.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      const existing = await tx.tenantDomain.findUnique({
        where: { hostname },
        select: { id: true, tenantId: true },
      });

      if (existing) {
        throw new ProviderRefusalError(
          existing.tenantId === tenant.id
            ? "That hostname is already assigned to this organisation."
            : "That hostname is already assigned to another organisation.",
          "CONFLICT",
        );
      }

      const primaryCount = await tx.tenantDomain.count({
        where: { tenantId: tenant.id, isPrimary: true },
      });

      const makePrimary = setAsPrimary || primaryCount === 0;

      if (makePrimary) {
        await tx.tenantDomain.updateMany({
          where: { tenantId: tenant.id, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      await tx.tenantDomain.create({
        data: { tenantId: tenant.id, hostname, isPrimary: makePrimary },
      });

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_DOMAIN_UPDATED,
        resource: "TenantDomain",
        resourceId: tenant.id,
        metadata: {
          field: "hostname",
          added: hostname,
          isPrimary: makePrimary,
        },
      };
    },
  });
}

/**
 * Server Action: Choose which of a tenant's hostnames is primary.
 */
export async function setPrimaryDomainAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = setPrimaryDomainSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid hostname.");
  }

  const { tenantId, hostname } = parsed.data;

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
    logLabel: "setPrimaryDomainAction",
    failureMessage: "Failed to update primary hostname.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      const domain = await tx.tenantDomain.findFirst({
        where: { tenantId: tenant.id, hostname },
        select: { id: true, isPrimary: true },
      });

      if (!domain) {
        throw new ProviderRefusalError(
          "That hostname is not assigned to this organisation.",
          "NOT_FOUND",
        );
      }

      if (domain.isPrimary) {
        throw new ProviderRefusalError(
          "That hostname is already the primary one.",
          "VALIDATION_ERROR",
        );
      }

      // Both statements are one transaction: a workspace is never left with two
      // primaries (the routing layer picks the first it finds) or with none.
      await tx.tenantDomain.updateMany({
        where: { tenantId: tenant.id, isPrimary: true },
        data: { isPrimary: false },
      });

      await tx.tenantDomain.update({
        where: { id: domain.id },
        data: { isPrimary: true },
      });

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_DOMAIN_UPDATED,
        resource: "TenantDomain",
        resourceId: tenant.id,
        metadata: { field: "isPrimary", primary: hostname },
      };
    },
  });
}

/**
 * Server Action: Detach a hostname from a tenant (platform operator only).
 *
 * This removes a routing rule and nothing else — the workspace keeps its
 * `<slug>.<baseDomain>` address, its business records and its storage objects.
 * Deleting a hostname is how a provider takes a customer domain back when a
 * business moves off it, which is exactly why the policy gates it as a write:
 * a suspended workspace cannot remove its own hostname, the provider can.
 */
export async function removeTenantDomainAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = removeTenantDomainSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid hostname.");
  }

  const { tenantId, hostname } = parsed.data;

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
    logLabel: "removeTenantDomainAction",
    failureMessage: "Failed to remove hostname.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      const removed = await tx.tenantDomain.deleteMany({
        where: { tenantId: tenant.id, hostname },
      });

      if (removed.count !== 1) {
        throw new ProviderRefusalError(
          "That hostname is not assigned to this organisation.",
          "NOT_FOUND",
        );
      }

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_DOMAIN_UPDATED,
        resource: "TenantDomain",
        resourceId: tenant.id,
        metadata: { field: "hostname", removed: hostname },
      };
    },
  });
}

/**
 * Server Action: Assign the informational subscription plan label (platform
 * operator only).
 *
 * A plan records what the provider has agreed commercially. It is NOT an
 * entitlement: no feature, limit or permission in this product reads `planId`,
 * and nothing here can suspend a workspace for an overdue arrangement — that
 * stays a manual decision holding `platform.tenants.suspend`.
 *
 * Only an ACTIVE plan can be newly assigned, so a retired label cannot be pushed
 * onto a live workspace; a tenant already carrying a retired label keeps showing
 * it until the operator changes it, which is the honest history.
 */
export async function assignTenantPlanAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = assignTenantPlanSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid plan selection.");
  }

  const { tenantId, planId } = parsed.data;

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_PLAN_ASSIGN,
    logLabel: "assignTenantPlanAction",
    failureMessage: "Failed to assign subscription plan.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      let planCode: string | null = null;

      if (planId !== null) {
        // `plan_select` admits platform admins only, so this read is itself part
        // of the authorization: a tenant could never enumerate plans from here.
        const plan = await tx.plan.findUnique({
          where: { id: planId },
          select: { id: true, code: true, status: true },
        });

        if (!plan) {
          throw new ProviderRefusalError("Unknown plan.", "NOT_FOUND");
        }

        if (plan.status !== "ACTIVE") {
          throw new ProviderRefusalError(
            "That plan is no longer available for assignment.",
            "CONFLICT",
          );
        }

        planCode = plan.code;
      }

      if (tenant.planId === planId) {
        throw new ProviderRefusalError(
          "That is already the assigned plan.",
          "VALIDATION_ERROR",
        );
      }

      await tx.tenant.update({ where: { id: tenant.id }, data: { planId } });

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_PLAN_ASSIGNED,
        resource: "Tenant",
        resourceId: tenant.id,
        metadata: { planCode },
      };
    },
  });
}

/**
 * Server Action: Configure a tenant's branding (platform operator only).
 *
 * The provider edits exactly the fields a business admin may set, through the
 * same validated patch — one definition of "branding", so the two writers can
 * never produce different shapes of row, and so enabling tenant self-service
 * branding later is a permission change rather than a schema or template change.
 *
 * The logo is deliberately not part of this action: logo bytes travel through the
 * upload route with its file validation and tenant-scoped storage policies
 * (provider-side logo upload is still open work), and a colour/name/text patch
 * cannot move a `logoUrl`. Suspension does not block this write for the provider:
 * `has_tenant_admin_write_access()` keeps its platform-admin branch, because the
 * operator who suspended a workspace is the one who will set it up again.
 */
export async function updateTenantBrandingForTenantAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateTenantBrandingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid branding details.");
  }

  const { tenantId, ...fields } = parsed.data;

  const contrast = contrastProblemFor(fields);
  if (contrast) {
    return fail(contrast, {
      code: "VALIDATION_ERROR",
      fieldErrors: { primaryForeground: ["Contrast ratio too low"] },
    });
  }

  const patch = toBrandingPatch(fields);
  const changedFields = Object.keys(patch);
  if (changedFields.length === 0) {
    return fail("Nothing to update.", { code: "VALIDATION_ERROR" });
  }

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_UPDATE,
    logLabel: "updateTenantBrandingForTenantAction",
    failureMessage: "Failed to update organisation branding.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      const existing = await tx.tenantBranding.findUnique({
        where: { tenantId: tenant.id },
        select: { id: true },
      });

      if (existing) {
        await tx.tenantBranding.update({
          where: { id: existing.id },
          data: patch,
        });
      } else {
        await tx.tenantBranding.create({
          data: { tenantId: tenant.id, ...patch },
        });
      }

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_BRANDING_UPDATED,
        resource: "TenantBranding",
        resourceId: tenant.id,
        // Which fields changed — not the address, tax PIN or footer text.
        metadata: { fields: changedFields },
      };
    },
  });
}

/**
 * Server Action: Configure a tenant's document numbering series (platform
 * operator only).
 *
 * Only the series *configuration* is written. Existing documents keep the number
 * they were issued with — numbers are immutable snapshots, allocated from
 * `DocumentNumberSequence` through `allocate_document_number()` — so changing a
 * prefix here never renumbers anything already issued, and no counter is
 * incremented, reset or deleted by this path.
 */
export async function updateTenantNumberingAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateDocumentNumberingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid numbering configuration.");
  }

  const { tenantId, series } = parsed.data;

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_UPDATE,
    logLabel: "updateTenantNumberingAction",
    failureMessage: "Failed to update document numbering.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      for (const row of series) {
        await tx.documentNumbering.upsert({
          where: {
            tenantId_type: { tenantId: tenant.id, type: row.type },
          },
          create: {
            tenantId: tenant.id,
            type: row.type,
            prefix: row.prefix,
            padding: row.padding,
            separator: row.separator,
            periodStyle: row.periodStyle,
            fiscalStartMonth: row.fiscalStartMonth,
          },
          update: {
            prefix: row.prefix,
            padding: row.padding,
            separator: row.separator,
            periodStyle: row.periodStyle,
            fiscalStartMonth: row.fiscalStartMonth,
          },
        });
      }

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_NUMBERING_UPDATED,
        resource: "DocumentNumbering",
        resourceId: tenant.id,
        metadata: { types: series.map((row) => row.type) },
      };
    },
  });
}

/**
 * Server Action: Assign a tenant's initial owner (platform operator only).
 *
 * Like provisioning, this issues a TENANT_OWNER *invitation*; it never writes a
 * `TenantMember` row. Ownership lands only when a person signed in as that exact
 * address accepts the invitation, so an operator-submitted email can never mint
 * an owner account for someone who is not there. A still-PENDING workspace is
 * exactly where this is meant to be used: `app_tenant_accepts_writes()` admits
 * PENDING, which is what lets the first owner accept at all.
 *
 * Rides `platform.tenants.create` because it is part of provisioning a workspace,
 * not an edit of one that is already running.
 */
export async function assignTenantOwnerAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = assignTenantOwnerSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid owner email address.");
  }

  const { tenantId, email } = parsed.data;

  return executeProviderWrite({
    tenantId,
    actorId: session.user.id,
    permission: PERMISSIONS.PLATFORM_TENANTS_CREATE,
    logLabel: "assignTenantOwnerAction",
    failureMessage: "Failed to assign organisation owner.",
    work: async (tx) => {
      const tenant = await requireTenant(tx, tenantId);

      const owner = await tx.tenantMember.findFirst({
        where: { tenantId: tenant.id, role: "TENANT_OWNER" },
        select: { id: true },
      });

      if (owner) {
        throw new ProviderRefusalError(
          "This organisation already has an owner. Ownership moves through a role change inside the workspace.",
          "CONFLICT",
        );
      }

      const token = randomBytes(32).toString("hex");
      const invitation = await tx.invitation.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email } },
        create: {
          tenantId: tenant.id,
          email,
          role: "TENANT_OWNER",
          invitedBy: session.user.id,
          expiresAt: addDays(new Date(), 7),
          status: "PENDING",
          tokenHash: hashAccountToken(token),
        },
        update: {
          role: "TENANT_OWNER",
          invitedBy: session.user.id,
          expiresAt: addDays(new Date(), 7),
          status: "PENDING",
          tokenHash: hashAccountToken(token),
        },
        select: { id: true, status: true },
      });

      return {
        action: AUDIT_ACTIONS.PLATFORM_TENANT_OWNER_ASSIGNED,
        resource: "Invitation",
        resourceId: invitation.id,
        // The address is the subject of the record here (who was made owner), and
        // it is a business contact the operator just entered — not customer PII.
        metadata: { email, refreshed: invitation.status === "ACCEPTED" },
      };
    },
  });
}
