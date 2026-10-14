import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@amisibiz/ui/page-header";
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@amisibiz/ui/table";
import { EmptyState } from "@amisibiz/ui/state";
import { TenantStatusBadge } from "@/components/platform/tenant-status-badge";
import { searchTenants, listPlanOptions } from "@/lib/admin/tenant-queries";
import { PlusIcon } from "@amisibiz/ui/icons";
import type { TenantStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const STATUSES: readonly TenantStatus[] = ["PENDING", "ACTIVE", "SUSPENDED"];

function parseStatus(value: string | undefined): TenantStatus | undefined {
  return STATUSES.find((status) => status === value);
}

function formatTimestamp(value: Date | null, fallback: string): string {
  return value ? value.toISOString().slice(0, 16).replace("T", " ") : fallback;
}

/**
 * Rebuilds the list URL for another page while keeping every filter the operator
 * already chose. A pagination control that silently dropped the status filter
 * would page through a different question than the one being asked.
 */
function pageHref(
  locale: string,
  filters: { q: string; status: string; planId: string },
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.planId) params.set("planId", filters.planId);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/${locale}/admin/tenants${query ? `?${query}` : ""}`;
}

export default async function AdminTenantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    q?: string;
    status?: string;
    planId?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const { locale } = await params;
  const raw = await searchParams;
  const t = await getTranslations("admin");

  const selectedStatus = parseStatus(raw.status);
  const { rows, total, page, pageSize, pageCount } = await searchTenants(raw);
  const plans = await listPlanOptions();

  const filters = {
    q: raw.q ?? "",
    status: selectedStatus ?? "",
    planId: raw.planId ?? "",
  };

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("tenantsTitle")}
        description={t("tenantsDescription")}
        actions={
          <Link
            href={`/${locale}/admin/tenants/new`}
            className="btn inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
          >
            <PlusIcon />
            {t("createTenant")}
          </Link>
        }
      />

      <form
        method="get"
        action={`/${locale}/admin/tenants`}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-56 flex-1">
          <label
            htmlFor="tenant-search"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("searchLabel")}
          </label>
          <input
            id="tenant-search"
            name="q"
            type="search"
            defaultValue={raw.q ?? ""}
            placeholder={t("searchPlaceholder")}
            className="input w-full"
          />
        </div>
        <div>
          <label
            htmlFor="tenant-status"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("filterStatus")}
          </label>
          <select
            id="tenant-status"
            name="status"
            defaultValue={selectedStatus ?? ""}
            className="input"
          >
            <option value="">{t("filterAll")}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="tenant-plan"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("filterPlan")}
          </label>
          <select
            id="tenant-plan"
            name="planId"
            defaultValue={raw.planId ?? ""}
            className="input"
          >
            <option value="">{t("filterAnyPlan")}</option>
            <option value="none">{t("filterNoPlan")}</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="tenant-page-size"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("filterPageSize")}
          </label>
          <select
            id="tenant-page-size"
            name="pageSize"
            defaultValue={String(pageSize)}
            className="input"
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-secondary px-4 py-2 text-sm">
          {t("applyFilters")}
        </button>
        <Link
          href={`/${locale}/admin/tenants`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {t("clearFilters")}
        </Link>
      </form>

      <TableContainer>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("table.name")}</TableHead>
              <TableHead>{t("table.slug")}</TableHead>
              <TableHead>{t("table.hostname")}</TableHead>
              <TableHead>{t("table.status")}</TableHead>
              <TableHead>{t("table.plan")}</TableHead>
              <TableHead>{t("table.lastActivity")}</TableHead>
              <TableHead>{t("table.lastSync")}</TableHead>
              <TableHead className="text-right">{t("table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent"
                    title={
                      filters.q || filters.status || filters.planId
                        ? t("tenantsNoMatches")
                        : t("tenantsEmpty")
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell className="font-medium text-foreground">
                    {tenant.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {t("counts.membersShort", {
                        count: tenant.memberCount,
                      })}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {tenant.slug}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {tenant.primaryHostname ?? t("noHostname")}
                  </TableCell>
                  <TableCell>
                    <TenantStatusBadge status={tenant.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {tenant.plan?.name ?? t("detail.noPlan")}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(
                      tenant.lastActivityAt ?? tenant.lastRecordedActivityAt,
                      t("indicator.never"),
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* "Where available": until a sync transport exists the honest
                        answer is that nothing has been recorded — not a timestamp
                        borrowed from a web request. */}
                    {tenant.lastSyncAt
                      ? formatTimestamp(tenant.lastSyncAt, t("indicator.never"))
                      : t("indicator.noSyncRecorded")}
                    {tenant.lastSyncErrorCode ? (
                      <span className="ml-2 text-xs text-destructive">
                        {t("indicator.syncRefused", {
                          code: tenant.lastSyncErrorCode,
                        })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/${locale}/admin/tenants/${tenant.id}`}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {t("view")}
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t("resultsRange", { from, to, total })}
        </p>
        {pageCount > 1 ? (
          <nav
            aria-label={t("paginationLabel")}
            className="flex items-center gap-2"
          >
            {page > 1 ? (
              <Link
                href={pageHref(locale, filters, page - 1)}
                className="btn btn-secondary px-3 py-1.5 text-sm"
              >
                {t("previousPage")}
              </Link>
            ) : null}
            <span className="text-sm text-muted-foreground">
              {t("pageOf", { page, pageCount })}
            </span>
            {page < pageCount ? (
              <Link
                href={pageHref(locale, filters, page + 1)}
                className="btn btn-secondary px-3 py-1.5 text-sm"
              >
                {t("nextPage")}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">{t("listFootnote")}</p>
    </div>
  );
}
