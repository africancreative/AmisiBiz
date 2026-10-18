"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@amisibiz/ui/button";
import { Badge } from "@amisibiz/ui/badge";
import { StatusIndicator } from "@amisibiz/ui/status-indicator";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@amisibiz/ui/state";
import { ItemDialog } from "@/components/items/item-dialog";
import { ItemVariantsPanel } from "@/components/items/item-variants-panel";
import { ItemImagesPanel } from "@/components/items/item-images-panel";
import { ItemShareLinksPanel } from "@/components/items/item-share-links-panel";
import { ArchiveItemDialog } from "@/components/items/archive-item-dialog";
import {
  deleteItemAction,
  getItemAction,
  restoreItemAction,
} from "@/server/actions/item";
import { formatMoney, formatPercent } from "@amisibiz/documents";
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
} from "lucide-react";
import type { ItemDetailRow } from "@/components/items/types";

/**
 * Product detail (`/app/items/[id]`), AGENT 02 module B.
 *
 * Reads one item through `getItemAction`, which is the only door to its
 * category, images, variants and tax rate; nothing here re-derives a price or a
 * total. Money is `formatMoney(decimalString, currencyOnThatRow)` and tax is
 * `formatPercent(rate)` — the same rules the list uses.
 *
 * Data arrives the same way the list gets it (a Server Action call from the
 * client) so a mutation's reload and the first paint share one code path.
 *
 * Every control sits behind the permission the matching action demands:
 * edit/archive/restore/image verbs are `ITEMS_UPDATE` (create `ITEMS_CREATE`,
 * delete `ITEMS_DELETE`), share links are `SHARE_LINKS_READ` /
 * `SHARE_LINKS_MANAGE`, and a read-only workspace (suspended tenant or support
 * grant) loses all of them regardless of role.
 */

interface ItemDetailClientProps {
  locale: string;
  tenantId: string;
  itemId: string;
  readonly: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canShareRead: boolean;
  canShareManage: boolean;
}

function statusOf(item: ItemDetailRow): {
  tone: "success" | "warning" | "neutral";
  label: string;
} {
  if (item.status === "ACTIVE") return { tone: "success", label: "Active" };
  if (item.status === "ARCHIVED") return { tone: "neutral", label: "Archived" };
  return { tone: "warning", label: "Inactive" };
}

/** Definition-list row: label and value, never a colour-only signal. */
function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function ItemDetailClient({
  locale,
  tenantId,
  itemId,
  readonly,
  canCreate,
  canUpdate,
  canDelete,
  canShareRead,
  canShareManage,
}: ItemDetailClientProps) {
  const router = useRouter();

  const [item, setItem] = React.useState<ItemDetailRow | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [showEdit, setShowEdit] = React.useState(false);
  const [showArchive, setShowArchive] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await getItemAction(itemId, tenantId);
      if (!result.success) {
        setLoadError(result.error || "Failed to load the item.");
        return;
      }
      if (!result.data || !result.data.item) {
        setItem(null);
        return;
      }
      setItem(result.data.item);
    } catch {
      setLoadError("Failed to load the item.");
    } finally {
      setIsLoading(false);
    }
  }, [itemId, tenantId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const canWrite = !readonly;

  const restore = async () => {
    setIsSubmitting(true);
    setActionError(null);
    setFlash(null);
    try {
      const result = await restoreItemAction({ tenantId, itemId });
      if (result.success) {
        setRestoring(false);
        setFlash("Item restored to the active catalogue.");
        void load();
        router.refresh();
        return;
      }
      setActionError(result.error || "Failed to restore the item.");
    } catch {
      setActionError("Something went wrong while restoring the item.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    setIsSubmitting(true);
    setActionError(null);
    try {
      const result = await deleteItemAction(itemId, tenantId);
      if (result.success) {
        router.push(`/${locale}/app/items`);
        return;
      }
      // An item already used by an issued document refuses here; the action's
      // own message explains why, and the item stays.
      setActionError(result.error || "Failed to delete the item.");
      setDeleting(false);
    } catch {
      setActionError("Something went wrong while deleting the item.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return <LoadingState label="Loading item…" />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="This item could not be loaded"
        description={loadError}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/${locale}/app/items`)}
            >
              Back to items
            </Button>
          </div>
        }
      />
    );
  }

  if (!item) {
    return (
      <EmptyState
        title="Item not found"
        description="It may have been deleted from this workspace."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => router.push(`/${locale}/app/items`)}
          >
            Back to items
          </Button>
        }
      />
    );
  }

  const status = statusOf(item);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href={`/${locale}/app/items`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-4 w-4" />
          Items
        </Link>
        <h1 className="text-2xl font-semibold">{item.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={item.type === "PRODUCT" ? "primary" : "info"}>
            {item.type === "PRODUCT" ? "Product" : "Service"}
          </Badge>
          <StatusIndicator tone={status.tone}>{status.label}</StatusIndicator>
          {item.category ? (
            <Badge tone="neutral">{item.category.name}</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">No category</span>
          )}
        </div>
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

      <div className="flex flex-wrap items-center gap-2">
        {canUpdate && canWrite ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowEdit(true)}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </Button>
            {item.status === "ACTIVE" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActionError(null);
                  setShowArchive(true);
                }}
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </Button>
            ) : null}
            {item.status === "ARCHIVED" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActionError(null);
                  setRestoring(true);
                }}
              >
                <ArchiveRestore className="mr-2 h-4 w-4" />
                Restore
              </Button>
            ) : null}
          </>
        ) : null}
        {canDelete && canWrite ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setActionError(null);
              setDeleting(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        ) : null}
        {!canWrite ? (
          <p className="text-xs text-muted-foreground" role="status">
            This workspace is read-only right now, so the item cannot be edited
            here.
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="SKU">
          <span className="font-mono">{item.sku || "—"}</span>
        </Fact>
        <Fact label="Unit price">
          <span className="font-mono">
            {formatMoney(item.unitPrice.toString(), item.currency)}
          </span>
        </Fact>
        <Fact label="Unit of measure">{item.unitOfMeasure}</Fact>
        <Fact label="Tax">
          {item.taxRate ? (
            <>
              <span className="font-mono">
                {formatPercent(item.taxRate.rate.toString())}
              </span>
              <span className="ml-1 text-xs text-muted-foreground">
                {item.taxRate.name}
                {item.taxRate.category
                  ? ` (${item.taxRate.category.name})`
                  : ""}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Untaxed</span>
          )}
        </Fact>
        <Fact label="Created">
          {new Date(item.createdAt).toLocaleDateString(locale)}
        </Fact>
        <Fact label="Updated">
          {new Date(item.updatedAt).toLocaleDateString(locale)}
        </Fact>
        {item.description ? (
          <div className="sm:col-span-2 lg:col-span-3">
            <Fact label="Description">
              <p className="whitespace-pre-line">{item.description}</p>
            </Fact>
          </div>
        ) : null}
        {item.notes ? (
          <div className="sm:col-span-2 lg:col-span-3">
            <Fact label="Internal notes">
              <p className="whitespace-pre-line">{item.notes}</p>
            </Fact>
          </div>
        ) : null}
        {item.contactItems.length > 0 ? (
          <div className="sm:col-span-2 lg:col-span-3">
            <Fact label="Saved for contacts">
              {item.contactItems.length} price entr
              {item.contactItems.length === 1 ? "y" : "ies"} — the item is kept
              because documents and contacts still reference it.
            </Fact>
          </div>
        ) : null}
      </dl>

      <div className="space-y-6 rounded-lg border border-border bg-card p-4">
        <ItemImagesPanel
          tenantId={tenantId}
          itemId={item.id}
          itemName={item.name}
          images={item.images}
          canUpdate={canUpdate && canWrite}
          onChanged={() => void load()}
        />

        <ItemVariantsPanel
          tenantId={tenantId}
          itemId={item.id}
          variants={item.variants}
          canCreate={canCreate && canWrite}
          canUpdate={canUpdate && canWrite}
          canDelete={canDelete && canWrite}
          onChanged={() => void load()}
        />
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <ItemShareLinksPanel
          tenantId={tenantId}
          itemId={item.id}
          itemName={item.name}
          locale={locale}
          canRead={canShareRead}
          canManage={canShareManage && canWrite}
        />
      </div>

      {showEdit ? (
        <ItemDialog
          tenantId={tenantId}
          itemId={item.id}
          onSuccess={() => {
            setShowEdit(false);
            void load();
          }}
        />
      ) : null}

      {showArchive ? (
        <ArchiveItemDialog
          tenantId={tenantId}
          itemId={item.id}
          itemName={item.name}
          onClose={() => setShowArchive(false)}
          onArchived={() => {
            setShowArchive(false);
            setFlash("Item archived.");
            void load();
            router.refresh();
          }}
        />
      ) : null}

      {restoring ? (
        <ConfirmDialog
          title="Restore item"
          description={`Put “${item.name}” back in the active catalogue? It becomes selectable for new documents and visible on its share pages again.`}
          confirmLabel="Restore"
          isLoading={isSubmitting}
          onConfirm={restore}
          onCancel={() => setRestoring(false)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Delete item"
          description={`Delete “${item.name}”? Items already used by an issued document cannot be deleted — archive it instead, which keeps every historical document intact.`}
          confirmLabel="Delete"
          variant="danger"
          isLoading={isSubmitting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </div>
  );
}
