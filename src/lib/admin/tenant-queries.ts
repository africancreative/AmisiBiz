import { prisma } from "@/lib/db/prisma";
import type {
  DocumentPeriodStyle,
  DocumentType,
  TenantStatus,
} from "@prisma/client";

/**
 * Platform-admin read models.
 *
 * These deliberately expose ONLY tenant lifecycle/administration metadata.
 * Tenant business data (contacts, invoices, catalogue, documents) is never
 * selected here.
 */

export type TenantOverviewCounts = Record<TenantStatus, number> & {
  total: number;
};

export async function getTenantOverviewCounts(): Promise<TenantOverviewCounts> {
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
}

export type TenantListItem = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  createdAt: Date;
  primaryHostname: string | null;
};

export async function listTenants(filters: {
  search?: string | undefined;
  status?: TenantStatus | undefined;
}): Promise<TenantListItem[]> {
  const search = filters.search?.trim();

  const tenants = await prisma.tenant.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { slug: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      createdAt: true,
      domains: {
        where: { isPrimary: true },
        select: { hostname: true },
        take: 1,
      },
    },
  });

  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    createdAt: tenant.createdAt,
    primaryHostname: tenant.domains[0]?.hostname ?? null,
  }));
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
  createdAt: Date;
  updatedAt: Date;
  activatedAt: Date | null;
  activatedBy: string | null;
  suspendedAt: Date | null;
  suspendedBy: string | null;
  suspensionReason: string | null;
  hostnames: string[];
  memberCount: number;
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
  branding: {
    displayName: string | null;
    primaryColor: string;
    accentColor: string;
    logoUrl: string | null;
  } | null;
};

export async function getTenantDetail(
  tenantId: string,
): Promise<TenantDetail | null> {
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
      createdAt: true,
      updatedAt: true,
      activatedAt: true,
      activatedById: true,
      suspendedAt: true,
      suspendedById: true,
      suspensionReason: true,
      domains: { select: { hostname: true }, orderBy: { isPrimary: "desc" } },
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
          primaryColor: true,
          accentColor: true,
          logoUrl: true,
        },
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
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    activatedAt: tenant.activatedAt,
    activatedBy: tenant.activatedById,
    suspendedAt: tenant.suspendedAt,
    suspendedBy: tenant.suspendedById,
    suspensionReason: tenant.suspensionReason,
    hostnames: tenant.domains.map((d) => d.hostname),
    memberCount: tenant._count.members,
    numbering: tenant.documentNumberings,
    branding: tenant.branding,
  };
}
