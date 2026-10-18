"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Label } from "@amisibiz/ui/label";
import { StatusIndicator } from "@amisibiz/ui/status-indicator";
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
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { ItemDialog } from "@/components/items/item-dialog";
import { ArchiveItemDialog } from "@/components/items/archive-item-dialog";
import { CategoryManageDialog } from "@/components/items/category-manage-dialog";
import {
  deleteItemAction,
  getCategoriesAction,
  getItemsAction,
  restoreItemAction,
} from "@/server/actions/item";
import type {
  ItemQueryInput,
  ItemStatus,
  ItemType,
} from "@/lib/validations/item";
import { formatMoney, formatPercent } from "@amisibiz/documents";
import {
  Archive,
  ArchiveRestore,
  Eye,
  FolderTree,
  Loader2,
  Search,
  ChevronUp,
  ChevronDown,
  Plus,
  Edit,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Items list (`/app/items`), AGENT 02 module A.
 *
 * Filters are URL-driven so a shareable/bookmarkable address reproduces the
 * view, and every value coming back out of the query string is whitelisted
 * before it can reach a Prisma `where`/`orderBy`.
 *
 * Two catalogue verbs live here besides CRUD: ARCHIVE and RESTORE. Archiving is
 * the state a workspace reaches for instead of deleting anything already used
 * by an issued document, so it is offered on every ACTIVE row a member may edit
 * (`ITEMS_UPDATE`, the same permission both actions demand) and a restored row
 * lands back in the active default view.
 *
 * ARCHIVED rows are hidden unless "Include archived" is on, exactly as
 * `itemQuerySchema` implements it; an explicit status filter always wins.
 */

type SortField = ItemQueryInput["sortBy"];
type SortOrder = ItemQueryInput["sortOrder"];

interface ItemsClientProps {
  locale: string;
  tenantId: string;
  initialPage: number;
  initialSearch: string;
  initialType: string;
  initialStatus: string;
  initialCategoryId: string;
  initialIncludeArchived: boolean;
  initialSortBy: string;
  initialSortOrder: string;
  readonly: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  title: string;
  description: string;
}

/** The list projection the Server Action returns, including its tax link. */
type ItemRow = Prisma.ItemGetPayload<{
  include: { taxRate: { include: { category: true } } };
}>;

interface CategoryOption {
  id: string;
  name: string;
}

const PAGE_SIZE = 25;
const CATEGORY_PAGE_SIZE = 100;

const SORT_FIELDS: readonly SortField[] = [
  "createdAt",
  "updatedAt",
  "name",
  "sku",
  "unitPrice",
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Query-string values are untrusted text; they are whitelisted against the same
 * enums the Server Action uses before they can reach a Prisma `orderBy`.
 */
function toSortField(value: string): SortField {
  return (SORT_FIELDS as readonly string[]).includes(value)
    ? (value as SortField)
    : "createdAt";
}

function toSortOrder(value: string): SortOrder {
  return value === "asc" ? "asc" : "desc";
}

function toItemType(value: string): ItemType | "" {
  return value === "PRODUCT" || value === "SERVICE" ? value : "";
}

function toItemStatus(value: string): ItemStatus | "" {
  return value === "ACTIVE" || value === "INACTIVE" ? value : "";
}

/** A category id that is not a uuid is dropped rather than sent to the action. */
function toCategoryId(value: string): string {
  return UUID_PATTERN.test(value) ? value : "";
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  ARCHIVED: "Archived",
};

export function ItemsClient({
  locale,
  tenantId,
  initialPage,
  initialSearch,
  initialType,
  initialStatus,
  initialCategoryId,
  initialIncludeArchived,
  initialSortBy,
  initialSortOrder,
  readonly,
  canCreate,
  canUpdate,
  canDelete,
  title,
  description,
}: ItemsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [items, setItems] = React.useState<ItemRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [showDialog, setShowDialog] = React.useState(false);
  const [editingItem, setEditingItem] = React.useState<ItemRow | null>(null);
  const [deletingItem, setDeletingItem] = React.useState<ItemRow | null>(null);
  const [archivingItem, setArchivingItem] = React.useState<ItemRow | null>(
    null,
  );
  const [restoringItem, setRestoringItem] = React.useState<ItemRow | null>(
    null,
  );
  const [showCategories, setShowCategories] = React.useState(false);

  const [categories, setCategories] = React.useState<CategoryOption[]>([]);
  const [categoriesNote, setCategoriesNote] = React.useState<string | null>(
    null,
  );

  const [page, setPage] = React.useState(initialPage);
  const [search, setSearch] = React.useState(initialSearch);
  const [type, setType] = React.useState<ItemType | "">(
    toItemType(initialType),
  );
  const [status, setStatus] = React.useState<ItemStatus | "">(
    toItemStatus(initialStatus),
  );
  const [categoryId, setCategoryId] = React.useState<string>(
    toCategoryId(initialCategoryId),
  );
  const [includeArchived, setIncludeArchived] = React.useState(
    initialIncludeArchived,
  );
  const [sortBy, setSortBy] = React.useState<SortField>(
    toSortField(initialSortBy),
  );
  const [sortOrder, setSortOrder] = React.useState<SortOrder>(
    toSortOrder(initialSortOrder),
  );

  const fetchItems = React.useCallback(async () => {
    setIsLoading(true);
    setServerError(null);
    try {
      const result = await getItemsAction({
        tenantId,
        search: search || undefined,
        type: type || undefined,
        status: status || undefined,
        categoryId: categoryId || undefined,
        includeArchived,
        page,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
      });
      if (!result.success) {
        setServerError(result.error || "Failed to load items");
        return;
      }
      if (result.data) {
        setItems(result.data.items);
        setTotal(result.data.total);
        setTotalPages(result.data.totalPages);
      }
    } catch {
      setServerError("Something went wrong while loading. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [
    tenantId,
    search,
    type,
    status,
    categoryId,
    includeArchived,
    page,
    sortBy,
    sortOrder,
  ]);

  React.useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  // Categories feed both the filter and the name shown in a row: the list
  // action returns the `categoryId` scalar only, so the label is looked up here.
  const fetchCategories = React.useCallback(async () => {
    try {
      const result = await getCategoriesAction({
        tenantId,
        page: 1,
        pageSize: CATEGORY_PAGE_SIZE,
      });
      if (!result.success || !result.data) {
        setCategoriesNote(
          result.success
            ? "Categories could not be loaded."
            : (result.error ?? "Categories could not be loaded."),
        );
        return;
      }
      setCategories(
        result.data.categories.map((category) => ({
          id: category.id,
          name: category.name,
        })),
      );
      setCategoriesNote(
        result.data.totalPages > 1
          ? `Only the first ${result.data.categories.length} of ${result.data.total} categories are listed here — open Manage categories to see the rest.`
          : null,
      );
    } catch {
      setCategoriesNote("Categories could not be loaded.");
    }
  }, [tenantId]);

  React.useEffect(() => {
    void fetchCategories();
  }, [fetchCategories]);

  // The URL drives the list: every search, filter, sort and page change is a
  // `router.push` that re-renders the server parent with new props, so the local
  // mirrors have to follow them.
  React.useEffect(() => {
    setPage(initialPage);
    setSearch(initialSearch);
    setType(toItemType(initialType));
    setStatus(toItemStatus(initialStatus));
    setCategoryId(toCategoryId(initialCategoryId));
    setIncludeArchived(initialIncludeArchived);
    setSortBy(toSortField(initialSortBy));
    setSortOrder(toSortOrder(initialSortOrder));
  }, [
    initialPage,
    initialSearch,
    initialType,
    initialStatus,
    initialCategoryId,
    initialIncludeArchived,
    initialSortBy,
    initialSortOrder,
  ]);

  const categoryNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories) map.set(category.id, category.name);
    return map;
  }, [categories]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (search) params.set("search", search);
    else params.delete("search");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handleFilterChange = (
    key: "type" | "status" | "category" | "archived",
    value: string,
  ) => {
    // Update the local mirror as well as the URL: the server re-render that
    // follows is asynchronous, and a controlled input that ignores the change
    // would snap back to the previous value.
    if (key === "type") setType(toItemType(value));
    else if (key === "status") setStatus(toItemStatus(value));
    else if (key === "category") setCategoryId(toCategoryId(value));
    else setIncludeArchived(value === "1");

    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handleSort = (column: SortField) => {
    const nextOrder: SortOrder =
      sortBy === column ? (sortOrder === "asc" ? "desc" : "asc") : "asc";
    setSortBy(column);
    setSortOrder(nextOrder);

    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", column);
    params.set("sortOrder", nextOrder);
    router.push(`?${params.toString()}`);
  };

  const handleCreate = () => {
    setEditingItem(null);
    setShowDialog(true);
  };

  const handleEdit = (item: ItemRow) => {
    setEditingItem(item);
    setShowDialog(true);
  };

  const handleDelete = (item: ItemRow) => {
    if (!canDelete) return;
    setDeletingItem(item);
  };

  const confirmDelete = async () => {
    if (!deletingItem) return;
    setIsSubmitting(true);
    setServerError(null);
    try {
      const result = await deleteItemAction(deletingItem.id, tenantId);
      if (result.success) {
        setDeletingItem(null);
        void fetchItems();
      } else {
        setServerError(result.error || "Failed to delete item");
      }
    } catch {
      setServerError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmRestore = async () => {
    if (!restoringItem) return;
    setIsSubmitting(true);
    setServerError(null);
    try {
      const result = await restoreItemAction({
        tenantId,
        itemId: restoringItem.id,
      });
      if (result.success) {
        setRestoringItem(null);
        void fetchItems();
        router.refresh();
      } else {
        setServerError(result.error || "Failed to restore the item.");
      }
    } catch {
      setServerError("Something went wrong while restoring the item.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDialogSuccess = () => {
    setShowDialog(false);
    setEditingItem(null);
    void fetchItems();
  };

  const canWrite = canCreate || canUpdate || canDelete;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setShowCategories(true)}>
            <FolderTree className="h-4 w-4 mr-2" />
            Manage categories
          </Button>
          {canCreate && !readonly && (
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-2" />
              New Item
            </Button>
          )}
        </div>
      </div>

      {serverError && (
        <div className="text-sm text-destructive" role="alert">
          {serverError}
        </div>
      )}

      {readonly ? (
        <p className="text-sm text-muted-foreground" role="status">
          This workspace is read-only right now, so items cannot be created,
          changed, archived or deleted.
        </p>
      ) : null}

      <div className="card">
        <div className="p-4 border-b border-border">
          <form
            onSubmit={handleSearch}
            className="flex flex-col sm:flex-row gap-4"
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search by name, SKU, description..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
                aria-label="Search items"
              />
            </div>
            <Select
              value={type}
              onChange={(e) => handleFilterChange("type", e.target.value)}
              className="w-full sm:w-48"
              aria-label="Filter by type"
            >
              <option value="">All Types</option>
              <option value="PRODUCT">Product</option>
              <option value="SERVICE">Service</option>
            </Select>
            <Select
              value={status}
              onChange={(e) => handleFilterChange("status", e.target.value)}
              className="w-full sm:w-48"
              aria-label="Filter by status"
            >
              <option value="">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
            <Select
              value={categoryId}
              onChange={(e) => handleFilterChange("category", e.target.value)}
              className="w-full sm:w-48"
              aria-label="Filter by category"
            >
              <option value="">All Categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </form>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <input
                id="include-archived"
                type="checkbox"
                checked={includeArchived}
                onChange={(e) =>
                  handleFilterChange("archived", e.target.checked ? "1" : "")
                }
                className="h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Label htmlFor="include-archived" className="text-sm font-normal">
                Include archived
              </Label>
            </div>
            {categoriesNote ? (
              <p className="text-xs text-muted-foreground">{categoriesNote}</p>
            ) : null}
          </div>
        </div>

        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("name")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    Name
                    {sortBy === "name" &&
                      (sortOrder === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      ))}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("sku")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    SKU
                    {sortBy === "sku" &&
                      (sortOrder === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      ))}
                  </button>
                </TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("unitPrice")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    Unit Price
                    {sortBy === "unitPrice" &&
                      (sortOrder === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      ))}
                  </button>
                </TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("createdAt")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    Created
                    {sortBy === "createdAt" &&
                      (sortOrder === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      ))}
                  </button>
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-12 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="p-0">
                    <EmptyState
                      className="border-0 bg-transparent py-12"
                      title="No items found"
                      description={
                        search || type || status || categoryId
                          ? "Try adjusting your search or filters."
                          : "Get started by adding your first product or service."
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/${locale}/app/items/${item.id}`}
                        className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      >
                        {item.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {item.sku || "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                          item.type === "PRODUCT"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-purple-100 text-purple-800",
                        )}
                      >
                        {item.type === "PRODUCT" ? "Product" : "Service"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {item.categoryId ? (
                        (categoryNames.get(item.categoryId) ?? (
                          <span className="text-muted-foreground">—</span>
                        ))
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">
                      {formatMoney(item.unitPrice.toString(), item.currency)}
                    </TableCell>
                    <TableCell>
                      {item.taxRate ? (
                        <>
                          <span className="font-mono text-sm">
                            {formatPercent(item.taxRate.rate.toString())}
                          </span>
                          {item.taxRate.category && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({item.taxRate.category.name})
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* Text label plus dot: state never travels by colour alone. */}
                      <StatusIndicator
                        tone={
                          item.status === "ACTIVE"
                            ? "success"
                            : item.status === "INACTIVE"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {STATUS_LABELS[item.status] ?? item.status}
                      </StatusIndicator>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(item.createdAt).toLocaleDateString(locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Open ${item.name}`}
                          onClick={() =>
                            router.push(`/${locale}/app/items/${item.id}`)
                          }
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {canUpdate && !readonly && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(item)}
                            aria-label="Edit item"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                        )}
                        {canUpdate && !readonly && item.status === "ACTIVE" ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setArchivingItem(item)}
                            aria-label={`Archive ${item.name}`}
                          >
                            <Archive className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canUpdate &&
                        !readonly &&
                        item.status === "ARCHIVED" ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setRestoringItem(item)}
                            aria-label={`Restore ${item.name}`}
                          >
                            <ArchiveRestore className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canDelete && !readonly && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(item)}
                            aria-label="Delete item"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {totalPages > 1 && (
          <div className="p-4 border-t border-border">
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              onPageChange={(newPage) => {
                const params = new URLSearchParams(searchParams.toString());
                params.set("page", newPage.toString());
                router.push(`?${params.toString()}`);
              }}
            />
            <p className="text-sm text-muted-foreground mt-2 text-center">
              Showing {(page - 1) * PAGE_SIZE + 1} to{" "}
              {Math.min(page * PAGE_SIZE, total)} of {total} items
            </p>
          </div>
        )}
      </div>

      {showDialog && editingItem && (
        <ItemDialog
          tenantId={tenantId}
          itemId={editingItem.id}
          onSuccess={handleDialogSuccess}
        />
      )}
      {showDialog && !editingItem && (
        <ItemDialog tenantId={tenantId} onSuccess={handleDialogSuccess} />
      )}

      {archivingItem && (
        <ArchiveItemDialog
          tenantId={tenantId}
          itemId={archivingItem.id}
          itemName={archivingItem.name}
          onClose={() => setArchivingItem(null)}
          onArchived={() => {
            setArchivingItem(null);
            void fetchItems();
            router.refresh();
          }}
        />
      )}

      {restoringItem && (
        <ConfirmDialog
          title="Restore item"
          description={`Restore “${restoringItem.name}” to the active catalogue? It becomes selectable for new documents again.`}
          confirmLabel="Restore"
          isLoading={isSubmitting}
          onConfirm={confirmRestore}
          onCancel={() => setRestoringItem(null)}
        />
      )}

      {deletingItem && (
        <ConfirmDialog
          title="Delete Item"
          description={`Are you sure you want to delete "${deletingItem.name}"? Items already used by an issued document cannot be deleted.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingItem(null)}
          isLoading={isSubmitting}
          confirmLabel="Delete"
          variant="danger"
        />
      )}

      {showCategories ? (
        <CategoryManageDialog
          tenantId={tenantId}
          canCreate={canCreate && !readonly}
          canUpdate={canUpdate && !readonly}
          canDelete={canDelete && !readonly}
          onClose={() => setShowCategories(false)}
          onCreated={(createdId) => {
            void fetchCategories();
            // Adopt the new category as the active filter so the member sees
            // the grouping they just made.
            handleFilterChange("category", createdId);
          }}
        />
      ) : null}

      {!canWrite ? (
        <p className="text-xs text-muted-foreground">
          Your role can browse the catalogue but not change it.
        </p>
      ) : null}
    </div>
  );
}
