"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
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
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { ItemDialog } from "@/components/items/item-dialog";
import { getItemsAction, deleteItemAction } from "@/server/actions/item";
import type {
  ItemQueryInput,
  ItemStatus,
  ItemType,
} from "@/lib/validations/item";
import { formatMoney, formatPercent } from "@amisibiz/documents";
import {
  Loader2,
  Search,
  ChevronUp,
  ChevronDown,
  Plus,
  Edit,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SortField = ItemQueryInput["sortBy"];
type SortOrder = ItemQueryInput["sortOrder"];

interface ItemsClientProps {
  locale: string;
  tenantId: string;
  initialPage: number;
  initialSearch: string;
  initialType: string;
  initialStatus: string;
  initialSortBy: string;
  initialSortOrder: string;
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

const PAGE_SIZE = 25;

const SORT_FIELDS: readonly SortField[] = [
  "createdAt",
  "updatedAt",
  "name",
  "sku",
  "unitPrice",
];

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

export function ItemsClient({
  locale,
  tenantId,
  initialPage,
  initialSearch,
  initialType,
  initialStatus,
  initialSortBy,
  initialSortOrder,
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

  const [page, setPage] = React.useState(initialPage);
  const [search, setSearch] = React.useState(initialSearch);
  const [type, setType] = React.useState<ItemType | "">(
    toItemType(initialType),
  );
  const [status, setStatus] = React.useState<ItemStatus | "">(
    toItemStatus(initialStatus),
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
  }, [tenantId, search, type, status, page, sortBy, sortOrder]);

  React.useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  // The URL drives the list: every search, filter, sort and page change is a
  // `router.push` that re-renders the server parent with new props, so the local
  // mirrors have to follow them.
  React.useEffect(() => {
    setPage(initialPage);
    setSearch(initialSearch);
    setType(toItemType(initialType));
    setStatus(toItemStatus(initialStatus));
    setSortBy(toSortField(initialSortBy));
    setSortOrder(toSortOrder(initialSortOrder));
  }, [
    initialPage,
    initialSearch,
    initialType,
    initialStatus,
    initialSortBy,
    initialSortOrder,
  ]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (search) params.set("search", search);
    else params.delete("search");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handleFilterChange = (key: "type" | "status", value: string) => {
    // Update the local mirror as well as the URL: the server re-render that
    // follows is asynchronous, and a controlled `<select>` that ignores the
    // change would snap back to the previous value.
    if (key === "type") setType(toItemType(value));
    else setStatus(toItemStatus(value));
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

  const handleDialogSuccess = () => {
    setShowDialog(false);
    setEditingItem(null);
    void fetchItems();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        {canCreate && (
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4 mr-2" />
            New Item
          </Button>
        )}
      </div>

      {serverError && (
        <div className="text-sm text-destructive" role="alert">
          {serverError}
        </div>
      )}

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
              />
            </div>
            <Select
              value={type}
              onChange={(e) => handleFilterChange("type", e.target.value)}
              className="w-full sm:w-48"
            >
              <option value="">All Types</option>
              <option value="PRODUCT">Product</option>
              <option value="SERVICE">Service</option>
            </Select>
            <Select
              value={status}
              onChange={(e) => handleFilterChange("status", e.target.value)}
              className="w-full sm:w-48"
            >
              <option value="">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
          </form>
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
                  <TableCell colSpan={8} className="py-12 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
                    <EmptyState
                      className="border-0 bg-transparent py-12"
                      title="No items found"
                      description={
                        search || type || status
                          ? "Try adjusting your search or filters."
                          : "Get started by adding your first product or service."
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
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
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                          item.status === "ACTIVE"
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-800",
                        )}
                      >
                        {item.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(item.createdAt).toLocaleDateString(locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {canUpdate && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(item)}
                            aria-label="Edit item"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                        )}
                        {canDelete && (
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
    </div>
  );
}
