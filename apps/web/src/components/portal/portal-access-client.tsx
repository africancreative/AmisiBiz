"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Label } from "@amisibiz/ui/label";
import { Select } from "@amisibiz/ui/select";
import { Badge } from "@amisibiz/ui/badge";
import { Alert } from "@amisibiz/ui/alert";
import { EmptyState, LoadingState } from "@amisibiz/ui/state";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { Pagination } from "@amisibiz/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@amisibiz/ui/table";
import {
  getPortalAccessOverviewAction,
  grantPortalAccessAction,
  revokePortalAccessAction,
  type PortalAccessCustomer,
  type PortalAccessOverview,
} from "@/server/actions/portal-access";

/**
 * Customer portal access management.
 *
 * Three lists, because the three questions a business asks are different:
 * which accounts exist that COULD sign in, which customers CAN sign in now, and
 * which customers are still waiting for a link.
 *
 * Every write goes through a Server Action that re-authorization the caller,
 * re-reads the tenant, and re-checks the account's role — this component only
 * decides which buttons to show. Nothing here is a security control: the pending
 * state below stops a double submit, `authorizeTenant` stops everything else.
 */

interface PortalAccessClientProps {
  tenantId: string;
}

const PAGE_SIZE = 25;

export function PortalAccessClient({ tenantId }: PortalAccessClientProps) {
  const t = useTranslations("portalAccess");
  const tTeam = useTranslations("team");
  const locale = useLocale();

  const [overview, setOverview] = React.useState<PortalAccessOverview | null>(
    null,
  );
  // An empty string means "the load failed with no message from the server", so
  // the UI can supply the translated one without threading `t` through a
  // `useCallback` dependency list.
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  const [search, setSearch] = React.useState("");
  const [searchDraft, setSearchDraft] = React.useState("");
  const [page, setPage] = React.useState(1);

  const [selection, setSelection] = React.useState<Record<string, string>>({});
  const [rowError, setRowError] = React.useState<Record<string, string>>({});
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [pendingRow, setPendingRow] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [revoking, setRevoking] = React.useState<PortalAccessCustomer | null>(
    null,
  );

  const load = React.useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await getPortalAccessOverviewAction({
        tenantId,
        search: search || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      if (!result.success) {
        setOverview(null);
        setLoadError(result.error || "");
        return;
      }
      setOverview(result.data ?? null);
    } catch {
      setOverview(null);
      setLoadError("");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, search, page]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A search or a page change invalidates any per-row validation message.
  React.useEffect(() => {
    setRowError({});
    setActionError(null);
  }, [search, page]);

  const accountsToLink = overview?.accounts.filter(
    (account) => !account.linkedContactId,
  );

  const handleSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A search moves the result set, so page 1 is the only honest place to land.
    setPage(1);
    setSearch(searchDraft.trim());
  };

  const handleClearSearch = () => {
    setSearchDraft("");
    setSearch("");
    setPage(1);
  };

  const handleGrant = async (contact: PortalAccessCustomer) => {
    if (isSubmitting) return;
    const portalUserId = selection[contact.id];
    if (!portalUserId) {
      setRowError({ [contact.id]: t("chooseAccountFirst") });
      return;
    }

    setIsSubmitting(true);
    setPendingRow(contact.id);
    setActionError(null);
    try {
      const result = await grantPortalAccessAction({
        tenantId,
        contactId: contact.id,
        portalUserId,
      });
      if (!result.success) {
        // The server's message names the exact conflict (wrong role, already
        // linked, archived customer), so it is shown as it is.
        setActionError(result.error);
        return;
      }
      setSelection((previous) => ({ ...previous, [contact.id]: "" }));
      await load();
    } catch {
      setActionError(t("grantFailed"));
    } finally {
      setIsSubmitting(false);
      setPendingRow(null);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      const result = await revokePortalAccessAction({
        tenantId,
        contactId: revoking.id,
      });
      if (!result.success) {
        setActionError(result.error);
        // Keep the dialog open: the operator's intent was not carried out.
        return;
      }
      setRevoking(null);
      await load();
    } catch {
      setActionError(t("revokeFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const accountName = (account: {
    name: string | null;
    email: string | null;
  }) => account.name ?? account.email ?? t("unnamedAccount");

  // A link styled as a secondary button: `Button` renders a <button> element and
  // this control navigates, so it has to stay a real anchor.
  const teamLink = (
    <Link
      href={`/${locale}/team`}
      className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {t("openTeamPage")}
    </Link>
  );

  return (
    <div className="space-y-8">
      <Alert tone="info">{t("howItWorks")}</Alert>

      {loadError !== null ? (
        <Alert tone="danger" title={t("loadFailed")}>
          <div className="space-y-3">
            <p>{loadError || t("loadFailedDescription")}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("tryAgain")}
            </Button>
          </div>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert tone="danger" title={t("actionFailed")}>
          <div className="space-y-3">
            <p>{actionError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("reload")}
            </Button>
          </div>
        </Alert>
      ) : null}

      {isLoading && !overview ? <LoadingState label={t("loading")} /> : null}

      {overview ? (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">
              {t("accountsTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("accountsDescription", {
                role: tTeam("roles.CUSTOMER_PORTAL_USER"),
              })}
            </p>
            {overview.accounts.length === 0 ? (
              <EmptyState
                title={t("accountsEmpty")}
                description={t("accountsEmptyDescription")}
                action={teamLink}
              />
            ) : (
              <TableContainer>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columnAccount")}</TableHead>
                      <TableHead>{t("columnStatus")}</TableHead>
                      <TableHead>{t("columnCustomer")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.accounts.map((account) => (
                      <TableRow key={account.userId}>
                        <TableCell>
                          <p className="font-medium text-foreground">
                            {accountName(account)}
                          </p>
                          {account.email ? (
                            <p className="text-xs text-muted-foreground">
                              {account.email}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge
                            tone={
                              account.accountStatus === "ACTIVE"
                                ? "success"
                                : "warning"
                            }
                          >
                            {t(`status.${account.accountStatus}`)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {account.linkedContactName ? (
                            <span className="text-foreground">
                              {account.linkedContactName}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("notLinked")}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">
              {t("linkedTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("linkedDescription")}
            </p>
            {overview.linked.length === 0 ? (
              <EmptyState
                title={t("linkedEmpty")}
                description={t("linkedEmptyDescription")}
              />
            ) : (
              <TableContainer>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columnCustomer")}</TableHead>
                      <TableHead>{t("columnAccount")}</TableHead>
                      <TableHead className="text-right">
                        {t("columnActions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.linked.map((contact) => (
                      <TableRow key={contact.id}>
                        <TableCell>
                          <p className="font-medium text-foreground">
                            {contact.displayName}
                          </p>
                          {contact.email ? (
                            <p className="text-xs text-muted-foreground">
                              {contact.email}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {contact.portalUser ? (
                            <>
                              <p className="text-foreground">
                                {accountName(contact.portalUser)}
                              </p>
                              {contact.portalUser.email ? (
                                <p className="text-xs text-muted-foreground">
                                  {contact.portalUser.email}
                                </p>
                              ) : null}
                            </>
                          ) : (
                            <p className="text-foreground">
                              {t("unknownAccount")}
                            </p>
                          )}
                          {!contact.linkIsLive ? (
                            <p className="mt-1 text-xs text-warning-foreground">
                              {t("staleLink")}
                            </p>
                          ) : null}
                          {contact.status === "ARCHIVED" ? (
                            <Badge tone="neutral" className="mt-1">
                              {t("customerArchived")}
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isSubmitting}
                            onClick={() => {
                              setActionError(null);
                              setRevoking(contact);
                            }}
                          >
                            {t("revoke")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">
              {t("availableTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("availableDescription")}
            </p>

            <form onSubmit={handleSearch} className="flex flex-wrap gap-2">
              <div className="min-w-56 flex-1 space-y-1">
                <Label htmlFor="portal-search" className="sr-only">
                  {t("searchLabel")}
                </Label>
                <Input
                  id="portal-search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder={t("searchPlaceholder")}
                  maxLength={100}
                />
              </div>
              <Button type="submit" variant="outline" disabled={isLoading}>
                {t("search")}
              </Button>
              {search ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleClearSearch}
                  disabled={isLoading}
                >
                  {t("clearSearch")}
                </Button>
              ) : null}
            </form>

            {accountsToLink && accountsToLink.length === 0 ? (
              <Alert tone="warning" title={t("noAccountsHeading")}>
                <div className="space-y-3">
                  <p>
                    {t("noAccountsDescription", {
                      role: tTeam("roles.CUSTOMER_PORTAL_USER"),
                    })}
                  </p>
                  {teamLink}
                </div>
              </Alert>
            ) : null}

            {overview.candidates.length === 0 ? (
              <EmptyState
                title={search ? t("searchEmpty") : t("availableEmpty")}
                description={
                  search
                    ? t("searchEmptyDescription", { search })
                    : t("availableEmptyDescription")
                }
              />
            ) : (
              <>
                <TableContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("columnCustomer")}</TableHead>
                        <TableHead>{t("columnAccount")}</TableHead>
                        <TableHead className="text-right">
                          {t("columnActions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {overview.candidates.map((contact) => {
                        const selectId = `account-for-${contact.id}`;
                        return (
                          <TableRow key={contact.id}>
                            <TableCell>
                              <p className="font-medium text-foreground">
                                {contact.displayName}
                              </p>
                              {contact.email ? (
                                <p className="text-xs text-muted-foreground">
                                  {contact.email}
                                </p>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <Label htmlFor={selectId} className="sr-only">
                                {t("accountLabel", {
                                  customer: contact.displayName,
                                })}
                              </Label>
                              <Select
                                id={selectId}
                                aria-invalid={
                                  rowError[contact.id] ? true : undefined
                                }
                                disabled={isSubmitting}
                                value={selection[contact.id] ?? ""}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setSelection((previous) => ({
                                    ...previous,
                                    [contact.id]: value,
                                  }));
                                  if (rowError[contact.id]) {
                                    setRowError((previous) => {
                                      const next = { ...previous };
                                      delete next[contact.id];
                                      return next;
                                    });
                                  }
                                }}
                              >
                                <option value="">{t("selectAccount")}</option>
                                {accountsToLink?.map((account) => (
                                  <option
                                    key={account.userId}
                                    value={account.userId}
                                  >
                                    {account.email
                                      ? `${accountName(account)} · ${account.email}`
                                      : accountName(account)}
                                  </option>
                                ))}
                              </Select>
                              {rowError[contact.id] ? (
                                <p
                                  role="alert"
                                  className="mt-1 text-xs text-destructive"
                                >
                                  {rowError[contact.id]}
                                </p>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                disabled={isSubmitting}
                                loading={pendingRow === contact.id}
                                onClick={() => void handleGrant(contact)}
                              >
                                {t("grant")}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>

                <Pagination
                  currentPage={overview.page}
                  totalPages={overview.totalPages}
                  onPageChange={setPage}
                />
              </>
            )}
          </section>
        </>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title={t("revokeTitle")}
          description={t("revokeDescription", {
            customer: revoking.displayName,
          })}
          confirmLabel={t("revokeConfirm")}
          cancelLabel={t("cancel")}
          variant="danger"
          isLoading={isSubmitting}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </div>
  );
}
