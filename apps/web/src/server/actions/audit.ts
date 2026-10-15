"use server";

import { prisma } from "@amisibiz/database";
import { requireAuth } from "@/lib/auth/helpers";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  authorizeTenant,
  authorizePlatform,
} from "@/server/auth/authorization";
import { toActionResult, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  tenantAuditQuerySchema,
  platformAuditQuerySchema,
} from "@/lib/validations/audit";
import type { Prisma } from "@prisma/client";

/**
 * Audit-trail read actions.
 *
 * Two entry points, one shape. The tenant action reads the caller's OWN
 * workspace; the platform action reads across workspaces. They differ only in
 * the permission that gates them and in whether a tenant filter is allowed —
 * never in what a filter can do, because a weaker filter on the platform path
 * would be a privilege leak dressed up as a query.
 *
 * Neither action writes an audit row for the read itself. That is deliberate and
 * matches the rest of the read surface (`getDocumentsAction` and friends do not
 * self-audit): walking the trail must not append to the trail it is walking, or
 * a viewer would grow the table every time it is opened. What IS audited is the
 * support path — `authorizeTenant` records `support.accessUsed` for a granted
 * provider read, which is the event that actually needs evidence.
 */

const auditSelect = {
  id: true,
  action: true,
  resource: true,
  resourceId: true,
  tenantId: true,
  userId: true,
  metadata: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } },
  tenant: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.AuditLogSelect;

type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>;

/**
 * The serialisable row a viewer renders. Prisma's `metadata` is already JSON;
 * the relation is renamed to `actor` so the UI does not imply the row is always
 * about a signed-in user (system events have none).
 */
export type AuditLogItem = {
  id: string;
  action: string;
  resource: string | null;
  resourceId: string | null;
  tenantId: string | null;
  actorId: string | null;
  actor: { id: string; name: string | null; email: string | null } | null;
  tenant: { id: string; name: string; slug: string } | null;
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
};

export type AuditLogPage = {
  entries: AuditLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function toItem(row: AuditLogRow): AuditLogItem {
  return {
    id: row.id,
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    tenantId: row.tenantId,
    actorId: row.userId,
    actor: row.user ?? null,
    tenant: row.tenant ?? null,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  };
}

/**
 * Build the shared `where`. `tenantId` is the ALREADY-AUTHORIZED tenant for the
 * tenant action, or the optional requested tenant for the platform action — the
 * caller chooses which value to pass, and that choice is the security decision.
 */
function buildWhere(filters: {
  tenantId?: string | undefined;
  action?: string | undefined;
  resource?: string | undefined;
  userId?: string | undefined;
  from?: Date | null | undefined;
  to?: Date | null | undefined;
}): Prisma.AuditLogWhereInput {
  const { tenantId, action, resource, userId, from, to } = filters;
  return {
    ...(tenantId ? { tenantId } : {}),
    ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
    ...(resource
      ? { resource: { contains: resource, mode: "insensitive" } }
      : {}),
    ...(userId ? { userId } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };
}

async function readPage(
  where: Prisma.AuditLogWhereInput,
  page: number,
  pageSize: number,
): Promise<AuditLogPage> {
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: auditSelect,
      // Newest first; `id` breaks ties so paging cannot repeat or skip a row
      // that shares a timestamp (the default is a coarse transaction time).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    entries: rows.map(toItem),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * The signed-in tenant administrator's view of their own workspace trail.
 *
 * `tenantId` from the request is used ONLY to locate the membership that
 * authorizes it; the query filter is `context.tenantId`, so a caller who
 * presents another workspace's id reads nothing (the membership lookup finds no
 * row and the request is denied before any audit read happens).
 */
export async function getAuditLogAction(
  rawInput: unknown,
): Promise<ActionResult<AuditLogPage>> {
  const session = await requireAuth();

  const parsed = tenantAuditQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, action, resource, userId, from, to, page, pageSize } =
    parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.AUDIT_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getAuditLogAction");
  }

  try {
    const data = await readPage(
      buildWhere({
        tenantId: context.tenantId,
        action,
        resource,
        userId,
        from,
        to,
      }),
      page,
      pageSize,
    );
    return { success: true, data };
  } catch (err) {
    return toActionResult(err, "Failed to load the audit trail.", "audit");
  }
}

/**
 * The provider's cross-workspace view. Requires `platform.audit.read`, which
 * only a SUPER_ADMIN holds: support holds the tenant-scoped `audit.read` through
 * an explicit grant, but is never given a global view.
 */
export async function getPlatformAuditLogAction(
  rawInput: unknown,
): Promise<ActionResult<AuditLogPage>> {
  const session = await requireAuth();

  const parsed = platformAuditQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, action, resource, userId, from, to, page, pageSize } =
    parsed.data;

  try {
    await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_AUDIT_READ);
  } catch (err) {
    return authorizationFailure(err, "getPlatformAuditLogAction");
  }

  try {
    const data = await readPage(
      buildWhere({ tenantId, action, resource, userId, from, to }),
      page,
      pageSize,
    );
    return { success: true, data };
  } catch (err) {
    return toActionResult(
      err,
      "Failed to load the audit trail.",
      "platform-audit",
    );
  }
}
