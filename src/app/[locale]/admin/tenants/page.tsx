import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/page-header";
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/state";
import { TenantStatusBadge } from "@/components/platform/tenant-status-badge";
import { listTenants } from "@/lib/admin/tenant-queries";
import { PlusIcon } from "@/components/ui/icons";
import type { TenantStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const STATUSES: readonly TenantStatus[] = ["PENDING", "ACTIVE", "SUSPENDED"];

function parseStatus(value: string | undefined): TenantStatus | undefined {
  return STATUSES.find((status) => status === value);
}

export default async function AdminTenantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { locale } = await params;
  const { q, status } = await searchParams;
  const t = await getTranslations("admin");

  const selectedStatus = parseStatus(status);
  const tenants = await listTenants({ search: q, status: selectedStatus });

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
        <div className="flex-1">
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
            defaultValue={q ?? ""}
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
              <TableHead>{t("table.created")}</TableHead>
              <TableHead className="text-right">{t("table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    className="border-0 bg-transparent"
                    title={t("tenantsEmpty")}
                  />
                </TableCell>
              </TableRow>
            ) : (
              tenants.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell className="font-medium text-foreground">
                    {tenant.name}
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
                    {tenant.createdAt.toISOString().slice(0, 10)}
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
    </div>
  );
}
