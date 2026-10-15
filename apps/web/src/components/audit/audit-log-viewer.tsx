"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Label } from "@amisibiz/ui/label";
import { Select } from "@amisibiz/ui/select";
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@amisibiz/ui/table";
import { Pagination } from "@amisibiz/ui/pagination";
import { EmptyState } from "@amisibiz/ui/state";
import { Badge } from "@amisibiz/ui/badge";
import { Loader2, Search } from "lucide-react";
import {
  getAuditLogAction,
  getPlatformAuditLogAction,
  type AuditLogItem,
} from "@/server/actions/audit";

const PAGE_SIZE = 25;

type TenantOption = { id: string; name: string };

export type AuditLogViewerProps = {
  /** Which read path to call — and therefore which permission gates it. */
  source: "tenant" | "platform";
  /** Required for `source: "tenant"`; ignored for the platform view. */
  tenantId?: string;
  locale: string;
  /** Platform only: lets an operator narrow the cross-tenant trail. */
  tenants?: TenantOption[];
};

/**
 * Shared audit viewer.
 *
 * One component serves both audiences because the two differ only in the action
 * they call and whether a tenant selector is offered — the filters, the table and
 * the paging are identical. Which action (and so which permission) applies is a
 * prop, not a conditional inside the fetch, so a caller cannot render the tenant
 * view with platform data by mistake: the page decides, and the server
 * re-authorizes on every request anyway.
 */
export function AuditLogViewer({
  source,
  tenantId,
  locale,
  tenants,
}: AuditLogViewerProps) {
  const t = useTranslations("audit");

  const [entries, setEntries] = React.useState<AuditLogItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [page, setPage] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Draft filter state (what the inputs hold) is separate from the applied
  // filter state (what the request uses), so typing does not fire a request per
  // keystroke; the form's submit applies the draft.
  const [action, setAction] = React.useState("");
  const [resource, setResource] = React.useState("");
  const [tenantFilter, setTenantFilter] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [applied, setApplied] = React.useState<{
    action: string;
    resource: string;
    tenantId: string;
    from: string;
    to: string;
  }>({ action: "", resource: "", tenantId: "", from: "", to: "" });

  const fetchPage = React.useCallback(
    async (requestedPage: number) => {
      setIsLoading(true);
      setServerError(null);
      try {
        const base = {
          action: applied.action || undefined,
          resource: applied.resource || undefined,
          from: applied.from || undefined,
          to: applied.to || undefined,
          page: requestedPage,
          pageSize: PAGE_SIZE,
        };

        const result =
          source === "platform"
            ? await getPlatformAuditLogAction({
                ...base,
                tenantId: applied.tenantId || undefined,
              })
            : await getAuditLogAction({ ...base, tenantId });

        if (!result.success) {
          setServerError(result.error || t("loadFailed"));
          return;
        }
        if (result.data) {
          setEntries(result.data.entries);
          setTotal(result.data.total);
          setTotalPages(result.data.totalPages);
          setPage(result.data.page);
        }
      } catch {
        setServerError(t("loadFailed"));
      } finally {
        setIsLoading(false);
      }
    },
    [source, tenantId, applied, t],
  );

  React.useEffect(() => {
    void fetchPage(1);
    // Re-running on `applied` is the trigger; `fetchPage` already closes over it.
  }, [fetchPage]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setApplied({ action, resource, tenantId: tenantFilter, from, to });
  };

  const handleReset = () => {
    setAction("");
    setResource("");
    setTenantFilter("");
    setFrom("");
    setTo("");
    setApplied({ action: "", resource: "", tenantId: "", from: "", to: "" });
  };

  const columnCount = source === "platform" ? 5 : 4;

  return (
    <div className="space-y-4">
      <form
        onSubmit={handleSubmit}
        className="card grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div className="space-y-1">
          <Label htmlFor="audit-action">{t("filters.action")}</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="audit-action"
              className="pl-10"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder={t("filters.actionPlaceholder")}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="audit-resource">{t("filters.resource")}</Label>
          <Input
            id="audit-resource"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            placeholder={t("filters.resourcePlaceholder")}
          />
        </div>

        {source === "platform" ? (
          <div className="space-y-1">
            <Label htmlFor="audit-tenant">{t("filters.tenant")}</Label>
            <Select
              id="audit-tenant"
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
            >
              <option value="">{t("filters.allTenants")}</option>
              {(tenants ?? []).map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="audit-from">{t("filters.from")}</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="audit-to">{t("filters.to")}</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>

        <div className="flex items-end gap-2">
          <Button type="submit" size="sm" disabled={isLoading}>
            {t("filters.apply")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={isLoading}
          >
            {t("filters.reset")}
          </Button>
        </div>
      </form>

      {serverError ? (
        <div className="text-sm text-destructive" role="alert">
          {serverError}
        </div>
      ) : null}

      <div className="card">
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.when")}</TableHead>
                <TableHead>{t("columns.action")}</TableHead>
                <TableHead>{t("columns.actor")}</TableHead>
                {source === "platform" ? (
                  <TableHead>{t("columns.tenant")}</TableHead>
                ) : null}
                <TableHead>{t("columns.resource")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={columnCount}
                    className="py-12 text-center"
                  >
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columnCount} className="p-0">
                    <EmptyState
                      className="border-0 bg-transparent py-12"
                      title={t("empty.title")}
                      description={t("empty.description")}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString(locale)}
                    </TableCell>
                    <TableCell>
                      <Badge tone="neutral">{entry.action}</Badge>
                    </TableCell>
                    <TableCell>
                      {entry.actor ? (
                        <span className="truncate">
                          {entry.actor.name || entry.actor.email}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t("system")}
                        </span>
                      )}
                    </TableCell>
                    {source === "platform" ? (
                      <TableCell>
                        {entry.tenant ? (
                          entry.tenant.name
                        ) : (
                          <span className="text-muted-foreground">
                            {t("platform")}
                          </span>
                        )}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-muted-foreground">
                      {entry.resource
                        ? `${entry.resource}${entry.resourceId ? ` · ${entry.resourceId}` : ""}`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {totalPages > 1 ? (
          <div className="border-t border-border p-4">
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              onPageChange={(newPage) => void fetchPage(newPage)}
            />
            <p className="mt-2 text-center text-sm text-muted-foreground">
              {t("showing", {
                from: total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1,
                to: Math.min(page * PAGE_SIZE, total),
                total,
              })}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
