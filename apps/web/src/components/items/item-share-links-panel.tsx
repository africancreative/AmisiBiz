"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Textarea } from "@amisibiz/ui/textarea";
import { Field } from "@amisibiz/ui/field";
import { Badge } from "@amisibiz/ui/badge";
import { Alert } from "@amisibiz/ui/alert";
import { StatusIndicator } from "@amisibiz/ui/status-indicator";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { EmptyState, LoadingState, ErrorState } from "@amisibiz/ui/state";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@amisibiz/ui/table";
import { Copy, Loader2, Plus, ShieldOff } from "lucide-react";
import {
  createShareLinkAction,
  listShareLinksAction,
  revokeShareLinkAction,
  updateShareLinkExpiryAction,
} from "@/server/actions/share-link";

/**
 * Share-link manager for ONE product (`/app/items/[id]`).
 *
 * What is true about a link is what the Server Action said, nothing more:
 *  - the URL is this deployment's origin + `/s/<token>`; the token comes from
 *    the create response, never from a client-side guess;
 *  - a copy is only reported as copied when `clipboard.writeText` resolves;
 *  - revoking is described as the server implements it — the link stops
 *    resolving, and the row itself is KEPT along with its view count and
 *    attribution (there is no delete verb on this surface, and this panel does
 *    not pretend otherwise);
 *  - expiry is a future instant the server re-checks; clearing it is an
 *    explicit "runs until revoked".
 *
 * Kinds: this surface mints PRODUCT links (the item it is opened from).
 * ORDER_STATUS links address a document, so they are created from the document
 * page; `createShareLinkSchema` refuses a PRODUCT link without an item and an
 * ORDER_STATUS link without a document, so nothing here offers a kind it
 * cannot fill correctly.
 *
 * Gating mirrors the action wiring: listing needs `SHARE_LINKS_READ`, and
 * create / revoke / expiry all need `SHARE_LINKS_MANAGE`.
 */

const PAGE_SIZE = 25;

interface ShareLinkRow {
  id: string;
  kind: string;
  token: string;
  active: boolean;
  expiresAt: string | null;
  viewCount: number;
  message: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  createdAt: string;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function expiryInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // `datetime-local` wants local wall-clock time without a zone suffix.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface ItemShareLinksPanelProps {
  tenantId: string;
  itemId: string;
  itemName: string;
  locale: string;
  canRead: boolean;
  canManage: boolean;
}

export function ItemShareLinksPanel({
  tenantId,
  itemId,
  itemName,
  locale,
  canRead,
  canManage,
}: ItemShareLinksPanelProps) {
  const [rows, setRows] = React.useState<ShareLinkRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [page, setPage] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [isCreating, setIsCreating] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [expiry, setExpiry] = React.useState("");
  const [createErrors, setCreateErrors] = React.useState<{
    message?: string;
    expiry?: string;
  }>({});
  const [createdUrl, setCreatedUrl] = React.useState<string | null>(null);

  const [actionError, setActionError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [revoking, setRevoking] = React.useState<ShareLinkRow | null>(null);
  const [editingExpiry, setEditingExpiry] = React.useState<ShareLinkRow | null>(
    null,
  );
  const [expiryDraft, setExpiryDraft] = React.useState("");

  const shareUrl = React.useCallback(
    (token: string) =>
      typeof window === "undefined"
        ? `/s/${token}`
        : `${window.location.origin}/s/${token}`,
    [],
  );

  const load = React.useCallback(
    async (targetPage: number) => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const result = await listShareLinksAction({
          tenantId,
          itemId,
          page: targetPage,
          pageSize: PAGE_SIZE,
        });
        if (!result.success) {
          setLoadError(result.error || "Failed to load share links.");
          return;
        }
        if (!result.data) return;
        setRows(
          result.data.shareLinks.map((link) => ({
            id: link.id,
            kind: link.kind,
            token: link.token,
            active: link.active,
            expiresAt: toIso(link.expiresAt),
            viewCount: link.viewCount,
            message: link.message,
            utmSource: link.utmSource,
            utmMedium: link.utmMedium,
            utmCampaign: link.utmCampaign,
            createdAt: toIso(link.createdAt) ?? "",
          })),
        );
        setTotal(result.data.total);
        setTotalPages(result.data.totalPages);
      } catch {
        setLoadError("Failed to load share links.");
      } finally {
        setIsLoading(false);
      }
    },
    [itemId, tenantId],
  );

  React.useEffect(() => {
    if (canRead) void load(page);
  }, [canRead, load, page]);

  const copy = async (url: string) => {
    setActionError(null);
    setCopiedUrl(null);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      // Only claimed after the promise resolves.
      setCopiedUrl(url);
      setFlash("Link copied to your clipboard.");
    } catch {
      setActionError(
        "Your browser did not allow the copy. Select the link above and copy it manually.",
      );
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setActionError(null);
    setFlash(null);
    setCreatedUrl(null);
    setCopiedUrl(null);

    const errors: { message?: string; expiry?: string } = {};
    const trimmedExpiry = expiry.trim();
    let expiresAt: string | undefined;
    if (trimmedExpiry) {
      const when = new Date(trimmedExpiry);
      if (Number.isNaN(when.getTime())) {
        errors.expiry = "Choose a valid date and time.";
      } else if (!(when.getTime() > Date.now())) {
        errors.expiry = "Expiry must be in the future.";
      } else {
        expiresAt = when.toISOString();
      }
    }
    if (message.trim().length > 2000) {
      errors.message = "The note is limited to 2 000 characters.";
    }
    setCreateErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsSubmitting(true);
    try {
      const result = await createShareLinkAction({
        tenantId,
        kind: "PRODUCT",
        itemId,
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
      if (result.success && result.data) {
        setIsCreating(false);
        setMessage("");
        setExpiry("");
        setCreatedUrl(shareUrl(result.data.token));
        setFlash("Share link created.");
        void load(page);
        return;
      }
      if (!result.success) {
        const fieldError = result.fieldErrors?.expiresAt?.[0];
        if (fieldError) {
          setCreateErrors({ expiry: fieldError });
        }
        setActionError(result.error || "Failed to create the share link.");
      }
    } catch {
      setActionError("Something went wrong while creating the share link.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      const result = await revokeShareLinkAction({
        tenantId,
        shareLinkId: revoking.id,
      });
      if (result.success) {
        setRevoking(null);
        setFlash("Share link revoked. Its record and view count are kept.");
        void load(page);
        return;
      }
      setActionError(result.error || "Failed to revoke the share link.");
    } catch {
      setActionError("Something went wrong while revoking the share link.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const applyExpiry = React.useCallback(
    async (shareLinkId: string, expiresAt: string | null) => {
      setIsSubmitting(true);
      setActionError(null);
      try {
        const result = await updateShareLinkExpiryAction({
          tenantId,
          shareLinkId,
          expiresAt,
        });
        if (result.success) {
          setEditingExpiry(null);
          setFlash(
            expiresAt
              ? "Expiry updated."
              : "Expiry cleared — this link now runs until it is revoked.",
          );
          void load(page);
          return;
        }
        setActionError(result.error || "Failed to update the expiry.");
      } catch {
        setActionError("Something went wrong while updating the expiry.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [load, page, tenantId],
  );

  const saveExpiry = async () => {
    if (!editingExpiry) return;
    setActionError(null);
    setFlash(null);

    const trimmed = expiryDraft.trim();
    if (!trimmed) {
      await applyExpiry(editingExpiry.id, null);
      return;
    }
    const when = new Date(trimmed);
    if (Number.isNaN(when.getTime())) {
      setActionError("Choose a valid date and time.");
      return;
    }
    if (!(when.getTime() > Date.now())) {
      setActionError("Expiry must be in the future.");
      return;
    }
    await applyExpiry(editingExpiry.id, when.toISOString());
  };

  /** Explicit "no expiry": the server accepts `null` and the link runs on. */
  const clearExpiry = async (row: ShareLinkRow) => {
    setEditingExpiry(null);
    await applyExpiry(row.id, null);
  };

  if (!canRead) {
    return (
      <section aria-labelledby="share-links-heading" className="space-y-3">
        <h3 id="share-links-heading" className="text-sm font-semibold">
          Share links
        </h3>
        <Alert tone="info" title="Not available for your role">
          This workspace role cannot read share links, so the links for{" "}
          {itemName || "this item"} are not shown or managed here.
        </Alert>
      </section>
    );
  }

  return (
    <section aria-labelledby="share-links-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="share-links-heading" className="text-sm font-semibold">
          Share links
        </h3>
        <span className="text-xs text-muted-foreground">
          {total === 0
            ? "No links yet"
            : `${total} link${total === 1 ? "" : "s"}`}
        </span>
      </div>

      {actionError ? (
        <div className="text-sm text-destructive" role="alert">
          {actionError}
        </div>
      ) : null}
      {flash ? (
        <p className="text-sm text-success-foreground" role="status">
          {flash}
        </p>
      ) : null}

      {createdUrl ? (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <p className="text-sm font-medium">New public link</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              readOnly
              value={createdUrl}
              aria-label="New share link URL"
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void copy(createdUrl)}
              disabled={copiedUrl === createdUrl}
            >
              <Copy className="mr-2 h-4 w-4" />
              {copiedUrl === createdUrl ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Anyone with this address can see the item until the link expires or
            you revoke it. It does not sign anyone in and shows no other data.
          </p>
        </div>
      ) : null}

      {canManage ? (
        isCreating ? (
          <form
            onSubmit={create}
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <Field
              label="Note for the recipient"
              description="Optional text shown on the shared page."
              error={createErrors.message}
            >
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="e.g. Quoted as discussed — send us your quantities."
                disabled={isSubmitting}
              />
            </Field>

            <Field
              label="Expires"
              description="Local time. Leave empty for a link that runs until you revoke it."
              error={createErrors.expiry}
            >
              <Input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                disabled={isSubmitting}
              />
            </Field>

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                {isSubmitting ? "Creating…" : "Create link"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIsCreating(false);
                  setCreateErrors({});
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setIsCreating(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            New product link
          </Button>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          Your role can view share links for {itemName || "this item"} but not
          create, change or revoke them.
        </p>
      )}

      {isLoading ? (
        <LoadingState label="Loading share links…" />
      ) : loadError ? (
        <ErrorState
          title="Share links could not be loaded"
          description={loadError}
          action={
            <Button size="sm" variant="outline" onClick={() => void load(page)}>
              Try again
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No share links"
          description="Create a link to send this product to a customer without giving them an account."
        />
      ) : (
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Link</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Views</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created</TableHead>
                {canManage ? (
                  <TableHead className="text-right">Actions</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const url = shareUrl(row.token);
                const expired =
                  row.active &&
                  row.expiresAt !== null &&
                  new Date(row.expiresAt).getTime() <= Date.now();
                const state = !row.active
                  ? { tone: "danger" as const, label: "Revoked" }
                  : expired
                    ? { tone: "warning" as const, label: "Expired" }
                    : { tone: "success" as const, label: "Live" };

                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <Input
                          readOnly
                          value={url}
                          aria-label={`Public URL for the ${row.kind} link created ${new Date(row.createdAt).toLocaleString(locale)}`}
                          onFocus={(e) => e.currentTarget.select()}
                          className="h-7 max-w-xs font-mono text-xs"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void copy(url)}
                          >
                            <Copy className="mr-1 h-3.5 w-3.5" />
                            Copy
                          </Button>
                          {copiedUrl === url ? (
                            <Badge tone="success">Copied</Badge>
                          ) : null}
                        </div>
                        {row.message ? (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {row.message}
                          </p>
                        ) : null}
                        {row.utmSource || row.utmMedium || row.utmCampaign ? (
                          <p className="text-xs text-muted-foreground">
                            Attribution:{" "}
                            {[row.utmSource, row.utmMedium, row.utmCampaign]
                              .filter(Boolean)
                              .join(" / ")}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* Text plus dot: status never travels by colour alone. */}
                      <StatusIndicator tone={state.tone}>
                        {state.label}
                      </StatusIndicator>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {row.viewCount}
                    </TableCell>
                    <TableCell className="text-sm">
                      {editingExpiry?.id === row.id ? (
                        <div className="space-y-2">
                          <label
                            className="block text-xs font-medium"
                            htmlFor={`expiry-${row.id}`}
                          >
                            New expiry
                          </label>
                          <Input
                            id={`expiry-${row.id}`}
                            type="datetime-local"
                            value={expiryDraft}
                            onChange={(e) => setExpiryDraft(e.target.value)}
                            disabled={isSubmitting}
                            className="h-8"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void saveExpiry()}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              type="button"
                              onClick={() => setEditingExpiry(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => void clearExpiry(row)}
                            >
                              No expiry
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <p>
                            {row.expiresAt
                              ? new Date(row.expiresAt).toLocaleString(locale)
                              : "Never"}
                          </p>
                          {canManage ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setActionError(null);
                                setEditingExpiry(row);
                                setExpiryDraft(expiryInputValue(row.expiresAt));
                              }}
                            >
                              Set expiry
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(row.createdAt).toLocaleDateString(locale)}
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Revoke the link ${url}`}
                          disabled={!row.active}
                          onClick={() => {
                            setActionError(null);
                            setRevoking(row);
                          }}
                        >
                          <ShieldOff className="mr-1 h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isLoading || page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isLoading || page >= totalPages}
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title="Revoke share link"
          description={`Make “${shareUrl(revoking.token)}” stop resolving? The public page will show its neutral not-found state immediately. Revoking does not delete anything: the link's row, its ${revoking.viewCount} view(s) and its attribution are kept for your records.`}
          confirmLabel="Revoke link"
          variant="danger"
          isLoading={isSubmitting}
          onConfirm={confirmRevoke}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </section>
  );
}
