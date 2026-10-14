"use client";

import * as React from "react";
import type { Prisma } from "@prisma/client";
import { Button } from "@amisibiz/ui/button";
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
import { ContactItemDialog } from "@/components/contacts/contact-item-dialog";
import {
  getContactItemsAction,
  deleteContactItemAction,
} from "@/server/actions/contact-item";
import { formatMoney, formatPercent } from "@amisibiz/documents";
import { Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContactItemsClientProps {
  tenantId: string;
  contactId: string;
  contactName: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/** Same projection the Server Action returns; typed rather than asserted. */
type ContactItemRow = Prisma.ContactItemGetPayload<{
  include: { item: { include: { taxRate: { include: { category: true } } } } };
}>;

const PAGE_SIZE = 25;

export function ContactItemsClient({
  tenantId,
  contactId,
  contactName,
  canCreate,
  canUpdate,
  canDelete,
}: ContactItemsClientProps) {
  const [contactItems, setContactItems] = React.useState<ContactItemRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = React.useState(false);
  const [editingContactItem, setEditingContactItem] =
    React.useState<ContactItemRow | null>(null);
  const [deletingContactItem, setDeletingContactItem] =
    React.useState<ContactItemRow | null>(null);

  const [page, setPage] = React.useState(1);

  const fetchContactItems = React.useCallback(async () => {
    setIsLoading(true);
    setServerError(null);
    try {
      const result = await getContactItemsAction({
        tenantId,
        contactId,
        page,
        pageSize: PAGE_SIZE,
      });
      // Narrow on `success` first: `error` only exists on the failure branch.
      if (!result.success) {
        setServerError(result.error || "Failed to load contact items");
        return;
      }
      if (result.data) {
        setContactItems(result.data.contactItems);
        setTotal(result.data.total);
        setTotalPages(result.data.totalPages);
      }
    } catch {
      setServerError("Something went wrong while loading. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, contactId, page]);

  React.useEffect(() => {
    void fetchContactItems();
  }, [fetchContactItems]);

  const handleAddItem = () => {
    setEditingContactItem(null);
    setShowAddDialog(true);
  };

  const handleEdit = (contactItem: ContactItemRow) => {
    setEditingContactItem(contactItem);
    setShowAddDialog(true);
  };

  const handleDelete = (contactItem: ContactItemRow) => {
    if (!canDelete) return;
    setDeletingContactItem(contactItem);
  };

  const confirmDelete = async () => {
    if (!deletingContactItem) return;
    setIsSubmitting(true);
    setServerError(null);
    try {
      const result = await deleteContactItemAction({
        contactItemId: deletingContactItem.id,
        tenantId,
      });
      if (!result.success) {
        setServerError(result.error || "Failed to remove item from contact");
        return;
      }
      setDeletingContactItem(null);
      void fetchContactItems();
    } catch {
      setServerError("Something went wrong while removing. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDialogSuccess = () => {
    setShowAddDialog(false);
    setEditingContactItem(null);
    void fetchContactItems();
  };

  /** Agreed/discount amounts are per-customer commercial terms. */
  const money = (value: Prisma.Decimal, currency: string) =>
    formatMoney(value.toString(), currency);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">
            Customer Catalogue for {contactName}
          </h2>
          <p className="text-muted-foreground">
            Items with customer-specific pricing and terms
          </p>
        </div>
        {canCreate && (
          <Button onClick={handleAddItem}>
            <Plus className="h-4 w-4 mr-2" />
            Add Item
          </Button>
        )}
      </div>

      {serverError && (
        <div className="text-sm text-destructive" role="alert">
          {serverError}
        </div>
      )}

      <div className="card">
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Customer Code</TableHead>
                <TableHead>Customer Name</TableHead>
                <TableHead className="text-right">Agreed Price</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead>Default Tax</TableHead>
                <TableHead>Status</TableHead>
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
              ) : contactItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
                    <EmptyState
                      className="border-0 bg-transparent py-12"
                      title="No customer-specific items"
                      description="Add items from the default catalogue to create customer-specific pricing and terms."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                contactItems.map((ci) => (
                  <TableRow key={ci.id}>
                    <TableCell className="font-medium">
                      {ci.item.name}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {ci.customCode || "—"}
                    </TableCell>
                    <TableCell>{ci.customName || ci.item.name}</TableCell>
                    <TableCell className="font-mono text-right">
                      {money(ci.agreedPrice, ci.item.currency)}
                    </TableCell>
                    <TableCell className="font-mono text-right">
                      {formatPercent(ci.discountPercent.toString())}
                    </TableCell>
                    <TableCell>
                      {ci.item.taxRate ? (
                        <>
                          <span className="font-mono text-sm">
                            {formatPercent(ci.item.taxRate.rate.toString())}
                          </span>
                          {ci.item.taxRate.category && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({ci.item.taxRate.category.name})
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
                          ci.isAvailable
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-800",
                        )}
                      >
                        {ci.isAvailable ? "Available" : "Unavailable"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {canUpdate && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(ci)}
                            aria-label="Edit customer item"
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(ci)}
                            aria-label="Remove from customer catalogue"
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
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
              onPageChange={(newPage) => setPage(newPage)}
            />
            <p className="text-sm text-muted-foreground mt-2 text-center">
              Showing {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1} to{" "}
              {Math.min(page * PAGE_SIZE, total)} of {total} items
            </p>
          </div>
        )}
      </div>

      {showAddDialog && (
        <ContactItemDialog
          tenantId={tenantId}
          contactId={contactId}
          contactItemId={editingContactItem?.id}
          onSuccess={handleDialogSuccess}
        />
      )}

      {deletingContactItem && (
        <ConfirmDialog
          title="Remove Item from Customer"
          description={`Are you sure you want to remove "${deletingContactItem.item.name}" from this customer's catalogue? The default catalogue item and any issued documents are untouched.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingContactItem(null)}
          isLoading={isSubmitting}
          confirmLabel="Remove"
          variant="danger"
        />
      )}
    </div>
  );
}
