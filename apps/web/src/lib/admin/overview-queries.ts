import { prisma, runInScope } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS, type Permission } from "@amisibiz/auth";
import type { TenantStatus } from "@prisma/client";

/**
 * Runs a platform-console read model inside the administrator's RLS scope.
 *
 * Every read model below authorizes itself rather than trusting the admin
 * layout's earlier `authorizePlatform()`. A layout and its page render in
 * different async execution contexts, so the ambient RLS scope the layout
 * entered is not guaranteed to reach the page's queries — and the scoped client
 * would fail closed with a `ScopeNotSetError` instead of quietly reading.
 * Re-authorizing here also means a read model can never be reached by a caller
 * that skipped the guard.
 *
 * The work runs inside `runInScope` (i.e. `AsyncLocalStorage.run()`), not an
 * `enterScope()` call before it. `enterScope` uses `enterWith()`, which only
 * sets the store on the current async frame: called after an `await` — as
 * resolving a session and authorizing both are — it never reaches the caller,
 * so the query would run with no scope. `run()` scopes the whole callback and
 * is unaffected by how many awaits precede it.
 *
 * `permission` is a parameter because the console reads at two different
 * authorities: workspace administration (`platform.tenants.read`) and the audit
 * trail (`platform.audit.read`). A read model asks for the one it actually is,
 * so widening the console later cannot accidentally widen the audit view.
 */
async function withPlatformReadScope<T>(
  fn: () => Promise<T>,
  permission: Permission = PERMISSIONS.PLATFORM_TENANTS_READ,
): Promise<T> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error(
      "Platform read models require a signed-in platform administrator.",
    );
  }
  const context = await authorizePlatform(user.id, permission);
  return runInScope(context.scope, () => fn());
}

/**
 * Platform-admin read models.
 *
 * These deliberately expose ONLY tenant lifecycle/administration metadata.
 * Tenant business data (contacts, invoices, catalogue, documents) is never
 * selected here.
 */

/**
 * Overview counts for the admin dashboard.
 *
 * Derived from the `Tenant` table only — no business data is exposed.
 */
export type TenantOverviewCounts = Record<TenantStatus, number> & {
  total: number;
  trial: number; // PENDING tenants without a plan are considered trials
};

export async function getTenantOverviewCounts(): Promise<TenantOverviewCounts> {
  return withPlatformReadScope(async () => {
    const grouped = await prisma.tenant.groupBy({
      by: ["status", "planId"],
      _count: { _all: true },
    });

    const counts: TenantOverviewCounts = {
      PENDING: 0,
      ACTIVE: 0,
      SUSPENDED: 0,
      total: 0,
      trial: 0,
    };

    for (const row of grouped) {
      const status = row.status as TenantStatus;
      counts[status] = row._count._all;
      counts.total += row._count._all;

      // PENDING tenants without a plan are considered trials
      if (status === "PENDING" && !row.planId) {
        counts.trial += row._count._all;
      }
    }

    return counts;
  });
}

/**
 * Recently registered businesses (newest first).
 */
export type RecentRegistration = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: { id: string; code: string; name: string } | null;
  createdAt: Date;
};

export async function getRecentRegistrations(limit = 5): Promise<RecentRegistration[]> {
  return withPlatformReadScope(async () => {
    return prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        plan: {
          select: { id: true, code: true, name: true },
        },
        createdAt: true,
      },
    });
  });
}

/**
 * Recent administrator activity (status changes, activations, suspensions).
 */
export type AdminActivityEntry = {
  id: string;
  action: "tenant.activated" | "tenant.suspended" | "tenant.reactivated" | "user.invited" | "tenant.created";
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  changedAt: Date;
  changedBy: string | null;
};

export async function getRecentAdminActivity(limit = 5): Promise<AdminActivityEntry[]> {
  return withPlatformReadScope(async () => {
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        action: true,
        tenantId: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
      // Filter to tenant lifecycle events only
      where: {
        action: {
          in: ["tenant.created", "tenant.activated", "tenant.suspended", "tenant.reactivated"],
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      action: row.action as AdminActivityEntry["action"],
      tenantId: row.tenantId ?? "",
      tenantName: "", // will be populated below
      tenantSlug: "",
      changedAt: row.createdAt,
      changedBy: row.user?.email ?? null,
    }));
  });
}

/**
 * Security events that the current administrator may view.
 *
 * These are security-relevant events from the audit trail that the
 * `support.access_request` and `security_events.read` permissions cover.
 */
export type SecurityEvent = {
  id: string;
  action: string;
  resource: string | null;
  resourceId: string | null;
  createdAt: Date;
  actorLabel: string | null;
};

export async function getRecentSecurityEvents(limit = 5): Promise<SecurityEvent[]> {
  return withPlatformReadScope(async () => {
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        action: true,
        resource: true,
        resourceId: true,
        createdAt: true,
        user: { select: { email: true } },
        tenant: { select: { name: true } },
      },
      // Focus on security-relevant actions
      where: {
        action: {
          in: ["user.login", "user.logout", "user.password_changed",
            "user.role_changed", "tenant.suspended", "tenant.activated",
            "tenant.reactivated", "support.granted", "support.revoked"],
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      createdAt: row.createdAt,
      actorLabel: row.user?.email ?? null,
    }));
  }, PERMISSIONS.SECURITY_EVENTS_READ);
}