import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { Badge } from "@amisibiz/ui/badge";
import { TableContainer, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@amisibiz/ui/table";
import { EmptyState } from "@amisibiz/ui/state";
import { Loader2Icon, AlertCircleIcon, CheckCircleIcon } from "@amisibiz/ui/icons";
import { SearchIcon, FilterIcon, SortIcon, ChevronDownIcon, RefreshCwIcon } from "@amisibiz/ui/icons";
import { useEffect, useState } from "react";
import { searchTenants, listPlanOptions } from "@/lib/admin/tenant-queries";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AdminBusinessDirectoryPage({
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

  const selectedStatus = raw.status ? raw.status as "PENDING" | "ACTIVE" | "SUSPENDED" : undefined;
  const selectedPlanId = raw.planId ?? "";
  const { q: search, page = "1", pageSize = "25" } = raw;

  // Debounced search
  const debouncedSearch = useDebounce(search, 300);

  const [filters, setFilters] = useState<{
    q: string;
    status: "PENDING" | "ACTIVE" | "SUSPENDED" | "";
    planId: string;
  }>({
    q: "",
    status: "",
    planId: "",
  });

  // Sync filters from URL on mount
  useEffect(() => {
    setFilters({
      q: debouncedSearch ?? "",
      status: selectedStatus ?? "",
      planId: selectedPlanId ?? "",
    });
  }, [debouncedSearch, selectedStatus, selectedPlanId]);

  const { rows, total, page: currentPage, pageSize: currentPageSize, pageCount } = await searchTenants({
    q: filters.q,
    status: filters.status,
    planId: filters.planId,
    page: parseInt(filters.page),
    pageSize: parseInt(filters.pageSize),
  });
  const plans = await listPlanOptions();

  const from = total === 0 ? 0 : (currentPage - 1) * currentPageSize + 1;
  const to = Math.min(currentPage * currentPageSize, total);

  // --- Filter Form ---
  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFilters({
      q: (e.target.querySelector('input[name="q"]') as HTMLInputElement).value ?? "",
      status: (e.target.querySelector('select[name="status"]') as HTMLSelectElement).value ?? "",
      planId: (e.target.querySelector('select[name="planId"]') as HTMLSelectElement).value ?? "",
    });
  };

  // --- Status badge for table ---
  function statusBadge(status: "PENDING" | "ACTIVE" | "SUSPENDED") {
    const labels: Record<"PENDING" | "ACTIVE" | "SUSPENDED", { title: string; bg: string; fg: string }> = {
      PENDING: { title: t("status.pending"), bg: "yellow", fg: "yellow-fg" },
      ACTIVE: { title: t("status.active"), bg: "green", fg: "green-fg" },
      SUSPENDED: { title: t("status.suspended"), bg: "red", fg: "red-fg" },
    };
    const { title, bg, fg } = labels[status];
    return (
      <Badge
        tone={bg === "green" ? "green" : bg === "red" ? "red" : "yellow"}
        className="text-xs"
      >
        {title}
      </Badge>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filter Form */}
      <Card>
        <CardHeader>
          <CardTitle>{t("businessDirectory")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleFilterSubmit}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label htmlFor="directory-search" className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("searchLabel")}
                </label>
                <input
                  id="directory-search"
                  name="q"
                  type="search"
                  defaultValue={filters.q}
                  placeholder={t("searchPlaceholder")}
                  className="input w-full"
                  disabled={true} {/* Handled by debounce */}
                />
              </div>

              <div>
                <label htmlFor="directory-status" className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("filterStatus")}
                </label>
                <select
                  id="directory-status"
                  name="status"
                  defaultValue={filters.status}
                  className="input"
                >
                  <option value="">{t("filterAll")}</option>
                  {["PENDING", "ACTIVE", "SUSPENDED"].map((status) => (
                    <option key={status} value={status}>
                      {t(`status.${status}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="directory-plan" className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("filterPlan")}
                </label>
                <select
                  id="directory-plan"
                  name="planId"
                  defaultValue={filters.planId}
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
                <label htmlFor="directory-page-size" className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("filterPageSize")}
                </label>
                <select
                  id="directory-page-size"
                  name="pageSize"
                  defaultValue={String(currentPageSize)}
                  className="input"
                >
                  {[10, 25, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-3">
              <button type="submit" className="btn btn-primary">
                {t("applyFilters")}
              </button>
              <Link
                href={`/${locale}/admin/tenants`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                {t("clearFilters")}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Business Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t("table.businesses")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.name")}</TableHead>
                  <TableHead>{t("table.identifier")}</TableHead>
                  <TableHead>{t("table.contact")}</TableHead>
                  <TableHead>{t("table.email")}</TableHead>
                  <TableHead>{t("table.registered")}</TableHead>
                  <TableHead>{t("table.plan")}</TableHead>
                  <TableHead>{t("table.status")}</TableHead>
                  <TableHead>{t("table.subdomain")}</TableHead>
                  <TableHead>{t("table.lastActivity")}</TableHead>
                  <TableHead className="text-right">{t("table.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={10} className="p-0">
                      <EmptyState
                        title={filters.q ? t("tenantsNoMatches") : t("tenantsEmpty")}
                        description={t("businessesNoMatchesDescription")}
                        icon={<AlertCircleIcon className="h-5 w-5 mx-2" />}
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((tenant) => (
                    <TableRow key={tenant.id}>
                      <TableCell className="font-medium text-foreground">
                        {tenant.name}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {t("counts.membersShort", { count: tenant.memberCount })}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tenant.slug}
                      </TableCell>
                      <TableCell>
                        {/* Show first member as primary contact */}
                        {tenant.members?.[0]?.user?.email
                          ? tenant.members[0].user.email
                          : t("noContact")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tenant.members?.[0]?.user?.email ?? t("noContact")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tenant.createdAt.toISOString().split("T")[0]}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tenant.plan?.name ?? t("detail.noPlan")}
                      </TableCell>
                      <TableCell>
                        {statusBadge(tenant.status as "PENDING" | "ACTIVE" | "SUSPENDED")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tenant.primaryHostname ?? t("noHostname")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatActivityTimestamp(tenant.lastActivityAt, tenant.lastRecordedActivityAt, t)}
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

          {/* Pagination */}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
            <p className="text-sm text-muted-foreground">
              {t("resultsRange", { from, to, total })}
            </p>
            {pageCount > 1 ? (
              <nav
                aria-label={t("paginationLabel")}
                className="flex items-center gap-2"
              >
                {currentPage > 1 ? (
                  <Link
                    href={`/${locale}/admin/tenants?q=${encodeURIComponent(filters.q ?? "")}&status=${filters.status}&planId=${filters.planId}&page=${currentPage - 1}`}
                    className="btn btn-secondary px-3 py-1.5 text-sm"
                  >
                    {t("previousPage")}
                  </Link>
                ) : null}
                <span className="text-sm text-muted-foreground">
                  {t("pageOf", { page: currentPage, pageCount })}
                </span>
                {currentPage < pageCount ? (
                  <Link
                    href={`/${locale}/admin/tenants?q=${encodeURIComponent(filters.q ?? "")}&status=${filters.status}&planId=${filters.planId}&page=${currentPage + 1}`}
                    className="btn btn-secondary px-3 py-1.5 text-sm"
                  >
                    {t("nextPage")}
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">{t("listFootnote")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Format the most relevant activity timestamp for display.
 */
function formatActivityTimestamp(
  lastActivityAt: Date | null,
  lastRecordedActivityAt: Date | null,
  t: (key: string) => string
) {
  if (lastActivityAt) {
    return lastActivityAt.toISOString().split("T")[0];
  }
  if (lastRecordedActivityAt) {
    return lastRecordedActivityAt.toISOString().split("T")[0];
  }
  return t("indicator.never");
}