"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/state";
import { ItemDialog } from "@/components/items/item-dialog";
import { getItemsAction, deleteItemAction, getTaxCategoriesAction } from "@/server/actions/item";
import type { Item } from "@prisma/client";
import { Loader2, Search, ChevronLeft, ChevronRight, Tag, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

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

type ItemWithTaxRate = Item & {
  taxRate: {
    id: string;
    name: string;
    rate: { toString: () => string };
    category: { id: string; name: string } | null;
  } | null;
};

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

  const [items, setItems] = React.useState<ItemWithTaxRate[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [showDialog, setShowDialog] = React.useState(false);
  const [editingItem, setEditingItem] = React.useState<ItemWithTaxRate | null>(null);
  const [deletingItem, setDeletingItem] = React.useState<ItemWithTaxRate | null>(null);

  const [page, setPage] = React.useState(initialPage);
  const [search, setSearch] = React.useState(initialSearch);
  const [type, setType] = React.useState(initialType);
  const [status, setStatus] = React.useState(initialStatus);
  const [sortBy, setSortBy] = React.useState(initialSortBy);
  const [sortOrder, setSortOrder] = React.useState(initialSortOrder);

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
        pageSize: 25,
        sortBy: sortBy as "createdAt" | "updatedAt" | "name" | "sku" | "unitPrice",
        sortOrder: sortOrder as "asc" | "desc",
      });
      if (!result.success) {
        setServerError(result.error || "Failed to load items");
      } else if (result.data) {
        setItems(result.data.items as ItemWithTaxRate[]);
        setTotal(result.data.total);
        setTotalPages(result.data.totalPages);
      } else {
        setServerError("Failed to load items");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, search, type, status, page, sortBy, sortOrder]);

  React.useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (search) params.set("search", search);
    else params.delete("search");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handleFilterChange = (key: string, value: string) => {
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("asc");
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", column);
    params.set("sortOrder", sortOrder === "asc" ? "desc" : "asc");
    router.push(`?${params.toString()}`);
  };

  const handleCreate = () => {
    setEditingItem(null);
    setShowDialog(true);
  };

  const handleEdit = (item: ItemWithTaxRate) => {
    setEditingItem(item);
    setShowDialog(true);
  };

  const handleDelete = async (item: ItemWithTaxRate) => {
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
        setShowDialog(false);
        setDeletingItem(null);
        fetchItems();
      } else {
        setServerError(result.error || "Failed to delete item");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDialogSuccess = () => {
    setShowDialog(false);
    setEditingItem(null);
    fetchItems();
  };

  const formatPrice = (price: { toString: () => string } | number | string) => {
    const num = typeof price === "string" ? parseFloat(price) : typeof price === "number" ? price : Number(price.toString());
    return new Intl.NumberFormat(locale, { style: "currency", currency: "KES", minimumFractionDigits: 2 }).format(num);
  };

  const formatTaxRate = (rate: { toString: () => string } | number | string | null) => {
    if (!rate) return "—";
    const num = typeof rate === "string" ? parseFloat(rate) : typeof rate === "number" ? rate : Number(rate.toString());
    return `${(num * 100).toFixed(2)}%`;
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
            <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Item
          </Button>
        )}
      </div>

      {serverError && (
        <div className="text-sm text-destructive" role="alert">{serverError}</div>
      )}

      <div className="card">
        <div className="p-4 border-b border-border">
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-4">
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
                    {sortBy === "name" && (sortOrder === "asc" ? <ChevronUp /> : <ChevronDown />)}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("sku")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    SKU
                    {sortBy === "sku" && (sortOrder === "asc" ? <ChevronUp /> : <ChevronDown />)}
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
                    {sortBy === "unitPrice" && (sortOrder === "asc" ? <ChevronUp /> : <ChevronDown />)}
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
                    {sortBy === "createdAt" && (sortOrder === "asc" ? <ChevronUp /> : <ChevronDown />)}
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
                      description={search || type || status ? "Try adjusting your search or filters." : "Get started by adding your first product or service."}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="font-mono text-sm">{item.sku || "—"}</TableCell>
                    <TableCell>
                      <span className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                        item.type === "PRODUCT"
                          ? "bg-blue-100 text-blue-800"
                          : "bg-purple-100 text-purple-800"
                      )}>
                        {item.type === "PRODUCT" ? "Product" : "Service"}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono">{formatPrice(item.unitPrice)}</TableCell>
                    <TableCell>
                      {item.taxRate ? (
                        <>
                          <span className="font-mono text-sm">{formatTaxRate(item.taxRate.rate)}</span>
                          {item.taxRate.category && (
                            <span className="ml-1 text-xs text-muted-foreground">({item.taxRate.category.name})</span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                        item.status === "ACTIVE"
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-800"
                      )}>
                        {item.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(item.createdAt).toLocaleDateString(locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="icon" onClick={() => router.push(`/${locale}/app/items/${item.id}`)} aria-label="View item">
                          <Eye className="h-4 w-4" />
                        </Button>
                        {canUpdate && (
                          <Button variant="ghost" size="icon" onClick={() => handleEdit(item)} aria-label="Edit item">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </Button>
                        )}
                        {canDelete && (
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(item)} aria-label="Delete item">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
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
              Showing {((page - 1) * 25) + 1} to {Math.min(page * 25, total)} of {total} items
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
        <ItemDialog
          tenantId={tenantId}
          onSuccess={handleDialogSuccess}
        />
      )}

      {deletingItem && (
        <ConfirmDialog
          title="Delete Item"
          description={`Are you sure you want to delete "${deletingItem.name}"? This action cannot be undone.`}
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

function ChevronUp() {
  return <ChevronLeft className="h-3 w-3" />;
}

function ChevronDown() {
  return <ChevronRight className="h-3 w-3" />;
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
  confirmLabel: string;
  variant?: "primary" | "danger";
}

function ConfirmDialog({ title, description, onConfirm, onCancel, isLoading, confirmLabel, variant = "primary" }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={isLoading}>
            {isLoading ? "Working..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}