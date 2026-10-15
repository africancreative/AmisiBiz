"use server";

import { Prisma } from "@prisma/client";
import type { DocumentStatus, DocumentType } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure } from "@/server/actions/_shared";

/**
 * Business dashboard read model.
 *
 * One Server Action, one authorization: every figure below is counted from rows
 * that carry the authorized `tenantId`, so a dashboard can never be assembled
 * from a tenant the caller was not just authorized for. The action re-runs
 * `authorizeTenant` on each call instead of trusting a role or tenant id handed
 * to it by the page.
 *
 * Grouped counts are used instead of a fan-out of `count()` calls: a single
 * `groupBy` over `(type, status)` returns the whole status matrix, which keeps
 * the query count small and makes "total issued invoices" a pure reduction
 * rather than one round-trip per status.
 */

const RECENT_DOCUMENT_LIMIT = 5;
const OUTSTANDING_INVOICE_LIMIT = 5;

/**
 * The invoice statuses that still owe money. Payment application is a later
 * phase, so the dashboard reports "invoiced and not yet settled" rather than a
 * net balance it cannot yet compute; the total is labelled as such in the UI.
 */
const OUTSTANDING_INVOICE_STATUSES: readonly DocumentStatus[] = [
  "ISSUED",
  "OVERDUE",
  "PARTIALLY_PAID",
];

/** Grouped-count row shape shared by every `_count: { _all: true }` query. */
type GroupedCount = { _count: { _all: number } };

function sumCounts<T extends GroupedCount>(
  rows: readonly T[],
  predicate: (row: T) => boolean,
): number {
  let total = 0;
  for (const row of rows) {
    if (predicate(row)) total += row._count._all;
  }
  return total;
}

/**
 * Document list projection for the dashboard feed. Declared once so the Prisma
 * payload and the exported type cannot drift, and exported as a TYPE ONLY so
 * the page renders the real shape instead of casting it.
 */
const dashboardDocumentInclude = {
  contact: {
    select: {
      id: true,
      type: true,
      firstName: true,
      lastName: true,
      companyName: true,
    },
  },
} satisfies Prisma.DocumentInclude;

export type DashboardDocument = Prisma.DocumentGetPayload<{
  include: typeof dashboardDocumentInclude;
}>;

export type DashboardOverview = {
  branding: {
    displayName: string | null;
    logoUrl: string | null;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    currency: string;
  } | null;
  companyName: string;
  currency: string;
  contacts: { total: number; active: number; archived: number };
  items: {
    total: number;
    active: number;
    inactive: number;
    products: number;
    services: number;
  };
  documents: {
    quotations: { total: number; draft: number; open: number };
    invoices: {
      total: number;
      draft: number;
      outstanding: number;
      paid: number;
    };
    deliveryNotes: { total: number; draft: number; delivered: number };
  };
  outstanding: { total: string; currency: string; count: number };
  overdue: { total: string; currency: string; count: number };
  recentDocuments: DashboardDocument[];
  outstandingInvoices: DashboardDocument[];
};

export async function getDashboardOverviewAction(
  tenantId: string,
): Promise<ActionResult<DashboardOverview>> {
  const session = await requireAuth();

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getDashboardOverviewAction");
  }

  const tid = context.tenantId;

  try {
    const [
      contactGroups,
      itemGroups,
      documentGroups,
      outstandingAggregate,
      overdueAggregate,
      recentDocuments,
      outstandingInvoices,
      tenant,
      branding,
    ] = await Promise.all([
      prisma.contact.groupBy({
        by: ["status"],
        where: { tenantId: tid },
        _count: { _all: true },
      }),
      prisma.item.groupBy({
        by: ["type", "status"],
        where: { tenantId: tid },
        _count: { _all: true },
      }),
      prisma.document.groupBy({
        by: ["type", "status"],
        where: { tenantId: tid },
        _count: { _all: true },
      }),
      prisma.document.aggregate({
        where: {
          tenantId: tid,
          type: "INVOICE",
          status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
        },
        _sum: { total: true },
      }),
      prisma.document.aggregate({
        where: { tenantId: tid, type: "INVOICE", status: "OVERDUE" },
        _sum: { total: true },
      }),
      prisma.document.findMany({
        where: { tenantId: tid },
        include: dashboardDocumentInclude,
        orderBy: { createdAt: "desc" },
        take: RECENT_DOCUMENT_LIMIT,
      }),
      prisma.document.findMany({
        where: {
          tenantId: tid,
          type: "INVOICE",
          status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
        },
        include: dashboardDocumentInclude,
        orderBy: { dueDate: "asc" },
        take: OUTSTANDING_INVOICE_LIMIT,
      }),
      prisma.tenant.findUnique({
        where: { id: tid },
        select: { name: true, currency: true },
      }),
      prisma.tenantBranding.findUnique({
        where: { tenantId: tid },
        select: {
          displayName: true,
          logoUrl: true,
          primaryColor: true,
          secondaryColor: true,
          accentColor: true,
          currency: true,
        },
      }),
    ]);

    const currency = branding?.currency || tenant?.currency || "KES";

    const contactsTotal = sumCounts(contactGroups, () => true);
    const contactsActive = sumCounts(
      contactGroups,
      (row) => row.status === "ACTIVE",
    );
    const contactsArchived = sumCounts(
      contactGroups,
      (row) => row.status === "ARCHIVED",
    );

    const itemsTotal = sumCounts(itemGroups, () => true);
    const itemsActive = sumCounts(itemGroups, (row) => row.status === "ACTIVE");
    const itemsInactive = sumCounts(
      itemGroups,
      (row) => row.status === "INACTIVE",
    );

    const numberOf = (type: DocumentType, status?: DocumentStatus): number =>
      sumCounts(
        documentGroups,
        (row) =>
          row.type === type && (status === undefined || row.status === status),
      );

    const outstandingStatusSet = new Set<DocumentStatus>(
      OUTSTANDING_INVOICE_STATUSES,
    );
    const outstandingInvoiceCount = sumCounts(
      documentGroups,
      (row) =>
        row.type === "INVOICE" &&
        outstandingStatusSet.has(row.status as DocumentStatus),
    );

    return {
      success: true,
      data: {
        branding: branding ?? null,
        companyName: tenant?.name ?? branding?.displayName ?? "",
        currency,
        contacts: {
          total: contactsTotal,
          active: contactsActive,
          archived: contactsArchived,
        },
        items: {
          total: itemsTotal,
          active: itemsActive,
          inactive: itemsInactive,
          products: sumCounts(itemGroups, (row) => row.type === "PRODUCT"),
          services: sumCounts(itemGroups, (row) => row.type === "SERVICE"),
        },
        documents: {
          quotations: {
            total: numberOf("QUOTATION"),
            draft: numberOf("QUOTATION", "DRAFT"),
            // A quotation is "open" once issued and before it is accepted,
            // rejected, expired or cancelled.
            open:
              numberOf("QUOTATION", "ISSUED") +
              numberOf("QUOTATION", "ACCEPTED"),
          },
          invoices: {
            total: numberOf("INVOICE"),
            draft: numberOf("INVOICE", "DRAFT"),
            outstanding: outstandingInvoiceCount,
            paid: numberOf("INVOICE", "PAID"),
          },
          deliveryNotes: {
            total: numberOf("DELIVERY_NOTE"),
            draft: numberOf("DELIVERY_NOTE", "DRAFT"),
            delivered: numberOf("DELIVERY_NOTE", "DELIVERED"),
          },
        },
        outstanding: {
          total: (
            outstandingAggregate._sum.total ?? new Prisma.Decimal(0)
          ).toFixed(),
          currency,
          count: outstandingInvoiceCount,
        },
        overdue: {
          total: (
            overdueAggregate._sum.total ?? new Prisma.Decimal(0)
          ).toFixed(),
          currency,
          count: numberOf("INVOICE", "OVERDUE"),
        },
        recentDocuments,
        outstandingInvoices,
      },
    };
  } catch (err) {
    console.error("[getDashboardOverviewAction]", err);
    return fail("Failed to load the dashboard.", { code: "INTERNAL" });
  }
}
