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
import { ContactDialog } from "@/components/contacts/contact-dialog";
import { getContactsAction } from "@/server/actions/contact";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { Contact } from "@prisma/client";
import { Loader2, Search, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContactsClientProps {
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

type ContactWithAddresses = Contact & {
  addresses: {
    type: string;
    line1: string;
    city?: string | null;
    country?: string | null;
  }[];
};

export function ContactsClient({
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
}: ContactsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [contacts, setContacts] = React.useState<ContactWithAddresses[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [showDialog, setShowDialog] = React.useState(false);
  const [editingContact, setEditingContact] = React.useState<ContactWithAddresses | null>(null);
  const [archivingContact, setArchivingContact] = React.useState<ContactWithAddresses | null>(null);
  const [restoringContact, setRestoringContact] = React.useState<ContactWithAddresses | null>(null);

  const [page, setPage] = React.useState(initialPage);
  const [search, setSearch] = React.useState(initialSearch);
  const [type, setType] = React.useState(initialType);
  const [status, setStatus] = React.useState(initialStatus);
  const [sortBy, setSortBy] = React.useState(initialSortBy);
  const [sortOrder, setSortOrder] = React.useState(initialSortOrder);

  const fetchContacts = React.useCallback(async () => {
    setIsLoading(true);
    setServerError(null);
    try {
      const result = await getContactsAction({
        tenantId,
        search: search || undefined,
        type: type || undefined,
        status: status || undefined,
        page,
        pageSize: 25,
        sortBy: sortBy as "createdAt" | "updatedAt" | "firstName" | "lastName" | "companyName" | "email",
        sortOrder: sortOrder as "asc" | "desc",
      });
      if (!result.success) {
        setServerError(result.error || "Failed to load contacts");
      } else if (result.data) {
        setContacts(result.data.contacts as ContactWithAddresses[]);
        setTotal(result.data.total);
        setTotalPages(result.data.totalPages);
      } else {
        setServerError("Failed to load contacts");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, search, type, status, page, sortBy, sortOrder]);

  React.useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

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
    params.set("sortBy", sortBy === column ? column : column);
    params.set("sortOrder", sortOrder === "asc" ? "desc" : "asc");
    router.push(`?${params.toString()}`);
  };

  const handleCreate = () => {
    setEditingContact(null);
    setShowDialog(true);
  };

  const handleEdit = (contact: ContactWithAddresses) => {
    setEditingContact(contact);
    setShowDialog(true);
  };

  const handleArchive = async (contact: ContactWithAddresses) => {
    if (!canDelete) return;
    setArchivingContact(contact);
  };

  const handleRestore = async (contact: ContactWithAddresses) => {
    if (!canUpdate) return;
    setRestoringContact(contact);
  };

  const confirmArchive = async () => {
    if (!archivingContact) return;
    setIsSubmitting(true);
    setServerError(null);
    try {
      const { archiveContactAction } = await import("@/server/actions/contact");
      const result = await archiveContactAction({
        contactId: archivingContact.id,
        tenantId,
      });
      if (result.success) {
        setShowDialog(false);
        setArchivingContact(null);
        fetchContacts();
      } else {
        setServerError(result.error || "Failed to archive contact");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmRestore = async () => {
    if (!restoringContact) return;
    setIsSubmitting(true);
    setServerError(null);
    try {
      const { restoreContactAction } = await import("@/server/actions/contact");
      const result = await restoreContactAction(restoringContact.id, tenantId);
      if (result.success) {
        setShowDialog(false);
        setRestoringContact(null);
        fetchContacts();
      } else {
        setServerError(result.error || "Failed to restore contact");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDialogSuccess = () => {
    setShowDialog(false);
    setEditingContact(null);
    fetchContacts();
  };

  const getDisplayName = (contact: ContactWithAddresses) => {
    if (contact.type === "BUSINESS") {
      return contact.companyName || "—";
    }
    return `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "—";
  };

  const getCompanyName = (contact: ContactWithAddresses) => {
    return contact.type === "INDIVIDUAL" ? contact.companyName || "—" : "—";
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
            New Contact
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
                placeholder="Search by name, company, email, phone..."
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
              <option value="INDIVIDUAL">Individual</option>
              <option value="BUSINESS">Business</option>
            </Select>
            <Select
              value={status}
              onChange={(e) => handleFilterChange("status", e.target.value)}
              className="w-full sm:w-48"
            >
              <option value="">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
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
                    onClick={() => handleSort("firstName")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    Name
                    {sortBy === "firstName" && (sortOrder === "asc" ? <ChevronUp /> : <ChevronDown />)}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("companyName")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    Company
                    {sortBy === "companyName" && (sortOrder === "asc" ? <ChevronUp /> : <ChevronDown />)}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("email")}
                    className="flex items-center gap-1 hover:underline"
                  >
                    Email
                    {sortBy === "email" && (sortOrder === "asc" ? <ChevronUp /> : <ChevronDown />)}
                  </button>
                </TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Type</TableHead>
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
                  <TableCell colSpan={7} className="py-12 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : contacts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState
                      className="border-0 bg-transparent py-12"
                      title="No contacts found"
                      description={search || type || status ? "Try adjusting your search or filters." : "Get started by adding your first contact."}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                contacts.map((contact) => (
                  <TableRow key={contact.id}>
                    <TableCell className="font-medium">{getDisplayName(contact)}</TableCell>
                    <TableCell>{getCompanyName(contact)}</TableCell>
                    <TableCell>{contact.email || "—"}</TableCell>
                    <TableCell>{contact.phone || contact.mobile || "—"}</TableCell>
                    <TableCell>
                      <span className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                        contact.type === "BUSINESS"
                          ? "bg-blue-100 text-blue-800"
                          : "bg-green-100 text-green-800"
                      )}>
                        {contact.type === "BUSINESS" ? "Business" : "Individual"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(contact.createdAt).toLocaleDateString(locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="icon" onClick={() => router.push(`/${locale}/app/contacts/${contact.id}`)} aria-label="View contact">
                          <Eye className="h-4 w-4" />
                        </Button>
                        {canUpdate && (
                          <Button variant="ghost" size="icon" onClick={() => handleEdit(contact)} aria-label="Edit contact">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </Button>
                        )}
                        {canDelete && contact.status === "ACTIVE" && (
                          <Button variant="ghost" size="icon" onClick={() => handleArchive(contact)} aria-label="Archive contact">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                            </svg>
                          </Button>
                        )}
                        {canUpdate && contact.status === "ARCHIVED" && (
                          <Button variant="ghost" size="icon" onClick={() => handleRestore(contact)} aria-label="Restore contact">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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
              Showing {((page - 1) * 25) + 1} to {Math.min(page * 25, total)} of {total} contacts
            </p>
          </div>
        )}
      </div>

      {showDialog && editingContact && (
        <ContactDialog
          tenantId={tenantId}
          contactId={editingContact.id}
          onSuccess={handleDialogSuccess}
        />
      )}
      {showDialog && !editingContact && (
        <ContactDialog
          tenantId={tenantId}
          onSuccess={handleDialogSuccess}
        />
      )}

      {archivingContact && (
        <ConfirmDialog
          title="Archive Contact"
          description={`Are you sure you want to archive "${getDisplayName(archivingContact)}"? This contact will no longer appear in active lists but will be preserved for historical records.`}
          onConfirm={confirmArchive}
          onCancel={() => setArchivingContact(null)}
          isLoading={isSubmitting}
          confirmLabel="Archive"
          variant="danger"
        />
      )}

      {restoringContact && (
        <ConfirmDialog
          title="Restore Contact"
          description={`Are you sure you want to restore "${getDisplayName(restoringContact)}"?`}
          onConfirm={confirmRestore}
          onCancel={() => setRestoringContact(null)}
          isLoading={isSubmitting}
          confirmLabel="Restore"
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