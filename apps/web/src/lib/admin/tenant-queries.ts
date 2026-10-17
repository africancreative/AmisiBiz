import { prisma, runInScope } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS, type Permission } from "@amisibiz/auth";
import { tenantSearchSchema } from "@/lib/validations/platform-tenant";
import type {
  DocumentPeriodStyle,
  DocumentType,
  PlanStatus,
  Prisma,
  TenantStatus,
} from "@prisma/client";

/**
 * Platform-admin read models.
 *
 * These deliberately expose ONLY tenant lifecycle/administration metadata.
 * Tenant business data (contacts, invoices, catalogue, documents) is never
 * selected here.
 */

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

export type TenantOverviewCounts = Record<TenantStatus, number> & {
  total: number;
};

export async function getTenantOverviewCounts(): Promise<TenantOverviewCounts> {
  return withPlatformReadScope(async () => {
    const grouped = await prisma.tenant.groupBy({
      by: ["status"],
      _count: { _all: true },
    });

    const counts: TenantOverviewCounts = {
      PENDING: 0,
      ACTIVE: 0,
      SUSPENDED: 0,
      total: 0,
    };

    for (const row of grouped) {
      counts[row.status] = row._count._all;
      counts.total += row._count._all;
    }

    return counts;
  });
}

export type RecentTenantChange = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  updatedAt: Date;
};

export async function getRecentTenantChanges(
  limit = 5,
): Promise<RecentTenantChange[]> {
  return withPlatformReadScope(async () => {
    return prisma.tenant.findMany({
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        updatedAt: true,
      },
    });
  });
}

export type TenantListRow = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  createdAt: Date;
  primaryHostname: string | null;
  plan: { id: string; code: string; name: string } | null;
  memberCount: number;
  /**
   * Operational indicators (Phase 2 requirement 10). Each one is a derived fact
   * written only through the narrow definer functions, so `null` is a real answer
   * rather than a missing join: it means "nothing has been recorded for this
   * workspace yet". `lastSyncAt` is null for every tenant today because the MVP
   * has no sync transport, and the console has to say that instead of implying a
   * freshness it never measured.
   */
  lastActivityAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncErrorCode: string | null;
  /** Newest row in this workspace's audit trail — the last thing we can evidence. */
  lastRecordedActivityAt: Date | null;
};

export type TenantListResult = {
  rows: TenantListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/**
 * Tenant search with filters and pagination (Phase 2 requirement 3).
 *
 * Raw query-string values go through `tenantSearchSchema` here rather than in the
 * page, so an out-of-range `page` or a malformed `planId` is clamped or rejected
 * before it reaches Prisma — and so this read model cannot be coaxed into an
 * unbounded `take`.
 */
export async function searchTenants(
  raw: {
    q?: string | undefined;
    status?: string | undefined;
    planId?: string | undefined;
    page?: string | undefined;
    pageSize?: string | undefined;
  } = {},
): Promise<TenantListResult> {
  return withPlatformReadScope(async () => {
    const parsed = tenantSearchSchema.safeParse({
      ...(raw.q ? { q: raw.q } : {}),
      ...(raw.status ? { status: raw.status } : {}),
      ...(raw.planId !== undefined && raw.planId !== ""
        ? { planId: raw.planId }
        : {}),
      ...(raw.page ? { page: raw.page } : {}),
      ...(raw.pageSize ? { pageSize: raw.pageSize } : {}),
    });

    // An unparseable filter (a forged status, a non-uuid plan) reads as "no filter"
    // rather than throwing: the console still renders, and the form re-shows the
    // submitted value so the operator can correct it.
    const { q, status, planId, page, pageSize } = parsed.success
      ? parsed.data
      : tenantSearchSchema.parse({});

    const search = q?.trim();

    const where: Prisma.TenantWhereInput = {
      ...(status ? { status } : {}),
      ...(planId === undefined
        ? {}
        : { planId: planId === "none" ? null : planId }),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { slug: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, tenants] = await Promise.all([
      prisma.tenant.count({ where }),
      prisma.tenant.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          createdAt: true,
          lastActivityAt: true,
          lastSyncAt: true,
          lastSyncErrorCode: true,
          plan: { select: { id: true, code: true, name: true } },
          domains: {
            where: { isPrimary: true },
            select: { hostname: true },
            take: 1,
          },
          _count: { select: { members: true } },
        },
      }),
    ]);

    // One aggregate over exactly the ids on this page, using the
    // (tenantId, createdAt DESC) index migration 11 added for it.
    const ids = tenants.map((tenant) => tenant.id);

    const latestAudit =
      ids.length === 0
        ? []
        : await prisma.auditLog.groupBy({
            by: ["tenantId"],
            where: { tenantId: { in: ids } },
            _max: { createdAt: true },
          });

    const lastAuditByTenant = new Map(
      latestAudit.map((row) => [
        row.tenantId ?? "",
        row._max.createdAt ?? null,
      ]),
    );

    return {
      rows: tenants.map((tenant) => ({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        createdAt: tenant.createdAt,
        primaryHostname: tenant.domains[0]?.hostname ?? null,
        plan: tenant.plan
          ? {
              id: tenant.plan.id,
              code: tenant.plan.code,
              name: tenant.plan.name,
            }
          : null,
        memberCount: tenant._count.members,
        lastActivityAt: tenant.lastActivityAt,
        lastSyncAt: tenant.lastSyncAt,
        lastSyncErrorCode: tenant.lastSyncErrorCode,
        lastRecordedActivityAt: lastAuditByTenant.get(tenant.id) ?? null,
      })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  });
}

export type TenantPlanOption = {
  id: string;
  code: string;
  name: string;
  description: string;
  status: PlanStatus;
};

/**
 * The plan catalogue for the assignment control.
 *
 * Reads come through the platform scope because `plan_select` admits platform
 * admins only — a workspace can never enumerate plans, pick its own, or tell a
 * plan from a feature it does or does not have. Plans carry no entitlement: this
 * list is a label the provider records, with prices and limits deliberately
 * absent from the table.
 */
export async function listPlanOptions(): Promise<TenantPlanOption[]> {
  return withPlatformReadScope(async () => {
    return prisma.plan.findMany({
      orderBy: [{ status: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        status: true,
      },
    });
  });
}

export type TenantStatusHistoryEntry = {
  id: string;
  fromStatus: TenantStatus | null;
  toStatus: TenantStatus;
  reason: string | null;
  createdAt: Date;
  changedByLabel: string | null;
};

/**
 * The lifecycle trail (Phase 2 requirement 9). Append-only in the database —
 * `tenant_status_history_is_append_only` refuses UPDATE and DELETE for every
 * context including the owner — so what is read here is everything that ever
 * happened to this workspace, oldest refusal to newest.
 */
export async function getTenantStatusHistory(
  tenantId: string,
  limit = 50,
): Promise<TenantStatusHistoryEntry[]> {
  return withPlatformReadScope(async () => {
    const rows = await prisma.tenantStatusHistory.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        reason: true,
        createdAt: true,
        changedBy: { select: { email: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      reason: row.reason,
      createdAt: row.createdAt,
      changedByLabel: row.changedBy?.email ?? null,
    }));
  });
}

export type TenantAuditEntry = {
  id: string;
  action: string;
  resource: string | null;
  resourceId: string | null;
  createdAt: Date;
  actorLabel: string | null;
  metadata: Record<string, unknown> | null;
};

/**
 * One workspace's audit trail for the provider console.
 *
 * `metadata` is passed through as stored — the writers already keep secrets and
 * business content out of it (`appendAuditLog` strips credential-shaped keys, and
 * the Phase 2 events record field names, hostnames and plan codes rather than
 * addresses, PINs or prices). Reads are gated by `audit_log_select`, which admits
 * a workspace's own owner/admin, a platform admin, and a support agent holding an
 * active grant — and nothing else, including for a suspended tenant, because
 * reading the trail of a workspace you suspended is how you evidence the decision.
 */
export async function getTenantAuditEvents(
  tenantId: string,
  options: { limit?: number; actions?: readonly string[] } = {},
): Promise<TenantAuditEntry[]> {
  return withPlatformReadScope(async () => {
    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId,
        ...(options.actions?.length
          ? { action: { in: [...options.actions] } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
      select: {
        id: true,
        action: true,
        resource: true,
        resourceId: true,
        createdAt: true,
        metadata: true,
        user: { select: { email: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      createdAt: row.createdAt,
      actorLabel: row.user?.email ?? null,
      metadata:
        row.metadata &&
        typeof row.metadata === "object" &&
        !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
    }));
  }, PERMISSIONS.PLATFORM_AUDIT_READ);
}

export type TenantDetail = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  country: string | null;
  currency: string;
  timezone: string;
  locale: string;
  planId: string | null;
  plan: { id: string; code: string; name: string; status: PlanStatus } | null;
  createdAt: Date;
  updatedAt: Date;
  activatedAt: Date | null;
  activatedBy: string | null;
  suspendedAt: Date | null;
  suspendedBy: string | null;
  suspensionReason: string | null;
  /**
   * Every hostname assigned to the workspace, primary first. `hostnames` stays as
   * the flat list the existing console view renders, so the detail page does not
   * have to be rewritten in the same change that adds ordering.
   */
  domains: Array<{ hostname: string; isPrimary: boolean }>;
  hostnames: string[];
  memberCount: number;
  lastActivityAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncErrorCode: string | null;
  /**
   * Document numbering series configuration. Phase 03 carried this on
   * `TenantSettings` as `documentPrefix`/`quotationPrefix`; the document engine
   * keeps one row per tenant per document type, so the console reads the series
   * instead. It is the one piece of tenant business configuration the platform
   * console has always shown, and it contains no customer data.
   */
  numbering: Array<{
    type: DocumentType;
    prefix: string;
    padding: number;
    separator: string;
    periodStyle: DocumentPeriodStyle;
    fiscalStartMonth: number;
  }>;
  /**
   * The editable branding row, in full. The console form posts the same
   * validated patch a business admin uses, so it has to be able to show every
   * field that patch can set — a partial read would make a provider save silently
   * blank fields the form never displayed.
   */
  branding: TenantBrandingDetail | null;
  /** Present when the workspace has an owner seat filled. */
  ownerEmail: string | null;
  pendingOwnerInvitationEmail: string | null;
};

export type TenantBrandingDetail = {
  displayName: string | null;
  registeredName: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  primaryForeground: string;
  logoUrl: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  postalAddress: string | null;
  physicalAddress: string | null;
  website: string | null;
  taxPin: string | null;
  currency: string;
  defaultFooter: string | null;
  paymentInstructions: string | null;
  documentLayout: string;
};

export async function getTenantDetail(
  tenantId: string,
): Promise<TenantDetail | null> {
  return withPlatformReadScope(async () => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        country: true,
        currency: true,
        timezone: true,
        locale: true,
        planId: true,
        plan: { select: { id: true, code: true, name: true, status: true } },
        createdAt: true,
        updatedAt: true,
        activatedAt: true,
        activatedById: true,
        suspendedAt: true,
        suspendedById: true,
        suspensionReason: true,
        lastActivityAt: true,
        lastSyncAt: true,
        lastSyncErrorCode: true,
        domains: {
          select: { hostname: true, isPrimary: true },
          orderBy: [{ isPrimary: "desc" }, { hostname: "asc" }],
        },
        _count: { select: { members: true } },
        documentNumberings: {
          orderBy: { type: "asc" },
          select: {
            type: true,
            prefix: true,
            padding: true,
            separator: true,
            periodStyle: true,
            fiscalStartMonth: true,
          },
        },
        branding: {
          select: {
            displayName: true,
            registeredName: true,
            primaryColor: true,
            secondaryColor: true,
            accentColor: true,
            primaryForeground: true,
            logoUrl: true,
            contactEmail: true,
            contactPhone: true,
            postalAddress: true,
            physicalAddress: true,
            website: true,
            taxPin: true,
            currency: true,
            defaultFooter: true,
            paymentInstructions: true,
            documentLayout: true,
          },
        },
        // Owner status for the "assign an initial tenant owner" panel: whether the
        // seat is filled, and whether an invitation is already waiting. Both are
        // read here so the console can tell the operator the truth instead of
        // letting them issue a second invitation that overwrites the first.
        members: {
          where: { role: "TENANT_OWNER" },
          select: { user: { select: { email: true } } },
          take: 1,
        },
        invitations: {
          where: { role: "TENANT_OWNER", status: "PENDING" },
          select: { email: true },
          take: 1,
        },
      },
    });

    if (!tenant) return null;

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      country: tenant.country,
      currency: tenant.currency,
      timezone: tenant.timezone,
      locale: tenant.locale,
      planId: tenant.planId,
      plan: tenant.plan
        ? {
            id: tenant.plan.id,
            code: tenant.plan.code,
            name: tenant.plan.name,
            status: tenant.plan.status,
          }
        : null,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
      activatedAt: tenant.activatedAt,
      activatedBy: tenant.activatedById,
      suspendedAt: tenant.suspendedAt,
      suspendedBy: tenant.suspendedById,
      suspensionReason: tenant.suspensionReason,
      domains: tenant.domains,
      hostnames: tenant.domains.map((domain) => domain.hostname),
      memberCount: tenant._count.members,
      lastActivityAt: tenant.lastActivityAt,
      lastSyncAt: tenant.lastSyncAt,
      lastSyncErrorCode: tenant.lastSyncErrorCode,
      numbering: tenant.documentNumberings,
      branding: tenant.branding,
      ownerEmail: tenant.members[0]?.user.email ?? null,
      pendingOwnerInvitationEmail: tenant.invitations[0]?.email ?? null,
    };
  });
}
