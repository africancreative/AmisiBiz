"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
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
import { ContactItemsClient } from "@/components/contacts/contact-items-client";
import {
  getContactAction,
  getContactBalanceAction,
  archiveContactAction,
  restoreContactAction,
  type ContactWithDetails,
} from "@/server/actions/contact";
import { getDocumentsAction } from "@/server/actions/document";
import { formatMoney } from "@/lib/format/money";
import {
  Loader2,
  Edit,
  Archive,
  RotateCcw,
  DollarSign,
  Package,
  ChevronLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ContactDetailClientProps {
  locale: string;
  tenantId: string;
  contactId: string;
  canUpdate: boolean;
  canDelete: boolean;
  canManageItems: boolean;
  title: string;
}

/** Outstanding balance is money: a decimal string plus its currency. */
interface ContactBalance {
  outstanding: string;
  currency: string;
  documentCount: number;
}

const DOCUMENTS_PAGE_SIZE = 10;

export function ContactDetailClient({
  locale,
  tenantId,
  contactId,
  canUpdate,
  canDelete,
  canManageItems,
  title,
}: ContactDetailClientProps) {
  const router = useRouter();

  const [contact, setContact] = React.useState<ContactWithDetails | null>(null);
  const [balance, setBalance] = React.useState<ContactBalance | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [showEditDialog, setShowEditDialog] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);

  // Document pagination
  const [docPage, setDocPage] = React.useState(1);
  const [docTotal, setDocTotal] = React.useState(0);
  const [docTotalPages, setDocTotalPages] = React.useState(1);
  const [isDocLoading, setIsDocLoading] = React.useState(false);

  const fetchContact = React.useCallback(async () => {
    setIsLoading(true);
    setServerError(null);
    try {
      const result = await getContactAction(contactId, tenantId);
      if (!result.success) {
        setServerError(result.error || "Failed to load contact");
        return;
      }
      if (result.data?.contact) {
        setContact(result.data.contact);
      } else {
        setServerError("Contact not found");
      }
    } catch {
      setServerError("Something went wrong while loading. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, contactId]);

  const fetchBalance = React.useCallback(async () => {
    try {
      const result = await getContactBalanceAction(contactId, tenantId);
      if (result.success && result.data) {
        setBalance({
          outstanding: result.data.outstanding,
          currency: result.data.currency,
          documentCount: result.data.documentCount,
        });
      }
    } catch {
      // The balance is derived from documents; its absence never blocks the
      // contact record itself, so the history card simply shows "—".
      setBalance(null);
    }
  }, [tenantId, contactId]);

  const fetchDocuments = React.useCallback(async () => {
    setIsDocLoading(true);
    try {
      const result = await getDocumentsAction({
        tenantId,
        contactId,
        page: docPage,
        pageSize: DOCUMENTS_PAGE_SIZE,
        sortBy: "issuedAt",
        sortOrder: "desc",
      });
      if (!result.success) {
        setServerError(result.error || "Failed to load document history");
        return;
      }
      const data = result.data;
      if (!data) return;
      // Local const: property narrowing does not survive inside the updater.
      setContact((prev) =>
        prev ? { ...prev, documents: data.documents } : prev,
      );
      setDocTotal(data.total);
      setDocTotalPages(data.totalPages);
    } catch {
      setServerError(
        "Something went wrong while loading documents. Please try again.",
      );
    } finally {
      setIsDocLoading(false);
    }
  }, [tenantId, contactId, docPage]);

  React.useEffect(() => {
    void fetchContact();
    void fetchBalance();
  }, [fetchContact, fetchBalance]);

  React.useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  const handleEdit = () => {
    setShowEditDialog(true);
  };

  const handleArchive = async () => {
    if (!contact || !canDelete) return;
    setArchiving(true);
    setServerError(null);
    try {
      const result = await archiveContactAction({ contactId, tenantId });
      if (!result.success) {
        setServerError(result.error || "Failed to archive contact");
        return;
      }
      router.refresh();
    } catch {
      setServerError("Something went wrong while archiving. Please try again.");
    } finally {
      setArchiving(false);
    }
  };

  const handleRestore = async () => {
    if (!contact || !canUpdate) return;
    setRestoring(true);
    setServerError(null);
    try {
      const result = await restoreContactAction({ contactId, tenantId });
      if (!result.success) {
        setServerError(result.error || "Failed to restore contact");
        return;
      }
      router.refresh();
    } catch {
      setServerError("Something went wrong while restoring. Please try again.");
    } finally {
      setRestoring(false);
    }
  };

  const handleEditSuccess = () => {
    setShowEditDialog(false);
    void fetchContact();
    void fetchBalance();
  };

  const getDisplayName = (c: ContactWithDetails) => {
    if (c.type === "BUSINESS") {
      return c.companyName || "—";
    }
    return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—";
  };

  /** Decimal string in, formatted amount out — no `Number()` involved. */
  const formatCurrency = (amount: string, currency = "KES") =>
    formatMoney(amount, currency);

  const formatDate = (date: Date | string) =>
    new Date(date).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  const getStatusBadge = (status: string) => {
    const tones: Record<string, BadgeTone> = {
      DRAFT: "neutral",
      ISSUED: "primary",
      OVERDUE: "danger",
      PAID: "success",
      PARTIALLY_PAID: "warning",
      VOID: "neutral",
    };
    return <Badge tone={tones[status] || "neutral"}>{status}</Badge>;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Contact not found</h2>
        <p className="text-muted-foreground mt-2">
          The contact may have been removed or you do not have access to it.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.push(`/${locale}/app/contacts`)}
        >
          <ChevronLeft className="h-4 w-4 mr-2" />
          Back to {title}
        </Button>
      </div>
    );
  }

  const displayName = getDisplayName(contact);

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        onClick={() => router.push(`/${locale}/app/contacts`)}
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        {title}
      </Button>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="h-16 w-16 rounded-lg bg-muted flex items-center justify-center">
            {contact.type === "BUSINESS" ? (
              <Package className="h-8 w-8 text-muted-foreground" />
            ) : (
              <svg
                className="h-8 w-8 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            )}
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{displayName}</h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              <Badge tone={contact.type === "BUSINESS" ? "info" : "neutral"}>
                {contact.type === "BUSINESS" ? "Business" : "Individual"}
              </Badge>
              <Badge tone={contact.status === "ACTIVE" ? "primary" : "neutral"}>
                {contact.status}
              </Badge>
              {contact.taxPin && (
                <span className="font-mono text-xs">PIN: {contact.taxPin}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canUpdate && (
            <Button variant="outline" onClick={handleEdit}>
              <Edit className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}
          {canDelete && contact.status === "ACTIVE" && (
            <Button
              variant="outline"
              onClick={handleArchive}
              disabled={archiving}
            >
              <Archive className="h-4 w-4 mr-2" />
              {archiving ? "Archiving..." : "Archive"}
            </Button>
          )}
          {canUpdate && contact.status === "ARCHIVED" && (
            <Button
              variant="outline"
              onClick={handleRestore}
              disabled={restoring}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              {restoring ? "Restoring..." : "Restore"}
            </Button>
          )}
        </div>
      </div>

      {serverError && (
        <div className="text-sm text-destructive" role="alert">
          {serverError}
        </div>
      )}

      {/* Balance Card */}
      <Card className="border-destructive/20">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">
                Outstanding Balance
              </p>
              <p className="text-3xl font-semibold text-destructive">
                {balance
                  ? formatCurrency(balance.outstanding, balance.currency)
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {balance
                  ? `Across ${balance.documentCount} unpaid document${
                      balance.documentCount === 1 ? "" : "s"
                    }`
                  : "Not available"}
              </p>
            </div>
            <DollarSign className="h-12 w-12 text-destructive/20" />
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="details" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="catalogue">Customer Catalogue</TabsTrigger>
        </TabsList>

        {/* Details Tab */}
        <TabsContent value="details" className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            {/* Basic Info */}
            <Card>
              <CardHeader>
                <CardTitle>Contact Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Email
                  </label>
                  <p>{contact.email || "—"}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Phone
                  </label>
                  <p>{contact.phone || "—"}</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Mobile
                  </label>
                  <p>{contact.mobile || "—"}</p>
                </div>
                {contact.taxPin && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Tax PIN
                    </label>
                    <p className="font-mono">{contact.taxPin}</p>
                  </div>
                )}
                {contact.notes && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Notes
                    </label>
                    <p className="whitespace-pre-wrap">{contact.notes}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Addresses */}
            <Card>
              <CardHeader>
                <CardTitle>Addresses</CardTitle>
              </CardHeader>
              <CardContent>
                {contact.addresses.length === 0 ? (
                  <p className="text-muted-foreground">No addresses recorded</p>
                ) : (
                  <div className="space-y-4">
                    {contact.addresses.map((addr, index) => (
                      <div
                        key={index}
                        className="p-3 border border-border rounded-lg"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span
                            className={cn(
                              "text-xs font-medium px-2 py-1 rounded-full",
                              addr.type === "POSTAL"
                                ? "bg-blue-100 text-blue-800"
                                : "bg-green-100 text-green-800",
                            )}
                          >
                            {addr.type}
                          </span>
                          {addr.isDefault && (
                            <Badge
                              tone="neutral"
                              className="text-xs border border-border bg-transparent"
                            >
                              Default
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm">{addr.line1}</p>
                        {addr.line2 && (
                          <p className="text-sm text-muted-foreground">
                            {addr.line2}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground mt-1">
                          {addr.city && <span>{addr.city}</span>}
                          {addr.state && <span>{addr.state}</span>}
                          {addr.postalCode && <span>{addr.postalCode}</span>}
                          {addr.country && <span>{addr.country}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Metadata */}
          <Card>
            <CardHeader>
              <CardTitle>Record Information</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-4 text-sm">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Created
                </label>
                <p>{formatDate(contact.createdAt)}</p>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Last Updated
                </label>
                <p>{formatDate(contact.updatedAt)}</p>
              </div>
              {contact.archivedAt && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Archived
                  </label>
                  <p>{formatDate(contact.archivedAt)}</p>
                </div>
              )}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Catalogue Items
                </label>
                <p>{contact.contactItems.length}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Documents Tab */}
        <TabsContent value="documents">
          <div className="card">
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isDocLoading ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-12 text-center">
                        <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ) : !contact.documents || contact.documents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0">
                        <EmptyState
                          className="border-0 bg-transparent py-12"
                          title="No documents"
                          description="Documents issued to this contact will appear here."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    contact.documents.map((doc) => (
                      <TableRow key={doc.id}>
                        <TableCell className="font-mono font-medium">
                          {doc.number}
                        </TableCell>
                        <TableCell>
                          <Badge tone="neutral">{doc.type}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-right">
                          {formatCurrency(doc.total.toString(), doc.currency)}
                        </TableCell>
                        <TableCell>{getStatusBadge(doc.status)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {doc.issuedAt ? formatDate(doc.issuedAt) : "—"}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground text-sm">
                          {formatDate(doc.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>

            {docTotalPages > 1 && (
              <div className="p-4 border-t border-border">
                <Pagination
                  currentPage={docPage}
                  totalPages={docTotalPages}
                  onPageChange={setDocPage}
                />
                <p className="text-sm text-muted-foreground mt-2 text-center">
                  Showing{" "}
                  {docTotal === 0 ? 0 : (docPage - 1) * DOCUMENTS_PAGE_SIZE + 1}{" "}
                  to {Math.min(docPage * DOCUMENTS_PAGE_SIZE, docTotal)} of{" "}
                  {docTotal} documents
                </p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Customer Catalogue Tab */}
        <TabsContent value="catalogue">
          <ContactItemsClient
            tenantId={tenantId}
            contactId={contactId}
            contactName={displayName}
            canCreate={canManageItems}
            canUpdate={canManageItems}
            canDelete={canManageItems}
          />
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      {showEditDialog && (
        <ContactDialog
          tenantId={tenantId}
          contactId={contactId}
          onSuccess={handleEditSuccess}
        />
      )}
    </div>
  );
}
