"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { Badge } from "@amisibiz/ui/badge";
import { formatMoney } from "@amisibiz/documents";
import {
  getDocumentsAction,
  type DocumentListItem,
} from "@/server/actions/document";
import {
  Loader2,
  Search,
  ChevronUp,
  ChevronDown,
  FileText,
  Eye,
  Download,
  Printer,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Mirrors `documentQuerySchema.sortBy` exactly. A column the server cannot sort
 * by is not offered as sortable — the header stays a plain label — because a
 * rejected `sortBy` would surface as "Invalid query parameters" over a list the
 * user can see perfectly well.
 */
type SortField =
  "createdAt" | "updatedAt" | "issuedAt" | "issueDate" | "number" | "total";
type SortOrder = "asc" | "desc";

interface DocumentsClientProps {
  locale: string;
  tenantId: string;
  initialPage: number;
  initialSearch: string;
  initialType: string;
  initialStatus: string;
  initialSortBy: string;
  initialSortOrder: string;
  canCreateQuotation: boolean;
  canCreateInvoice: boolean;
  canCreateDeliveryNote: boolean;
  canDownload: boolean;
  title: string;
  description: string;
}

const PAGE_SIZE = 25;

const SORT_FIELDS: readonly SortField[] = [
  "createdAt",
  "updatedAt",
  "issuedAt",
  "issueDate",
  "number",
  "total",
];

function toSortField(value: string): SortField {
  return (SORT_FIELDS as readonly string[]).includes(value)
    ? (value as SortField)
    : "createdAt";
}

function toSortOrder(value: string): SortOrder {
  return value === "asc" ? "asc" : "desc";
}

function toDocumentType(
  value: string,
): "QUOTATION" | "INVOICE" | "DELIVERY_NOTE" | "" {
  return value === "QUOTATION" ||
    value === "INVOICE" ||
    value === "DELIVERY_NOTE"
    ? value
    : "";
}

function toDocumentStatus(value: string): string | "" {
  const statuses = [
    "DRAFT",
    "ISSUED",
    "ACCEPTED",
    "REJECTED",
    "EXPIRED",
    "CANCELLED",
    "PARTIALLY_PAID",
    "PAID",
    "OVERDUE",
    "VOID",
    "PARTIALLY_DELIVERED",
    "DELIVERED",
  ];
  return statuses.includes(value) ? value : "";
}

/**
 * A column header that sorts. Only fields the server's `sortBy` enum accepts are
 * given one; the rest are plain text, so clicking a header can never produce a
 * query the validation layer rejects.
 */
function SortableHeader({
  label,
  field,
  sortBy,
  sortOrder,
  onSort,
}: {
  label: string;
  field: SortField;
  sortBy: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
}) {
  const isActive = sortBy === field;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className="flex items-center gap-1 hover:underline"
    >
      {label}
      {isActive &&
        (sortOrder === "asc" ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        ))}
    </button>
  );
}

function statusTone(
  status: string,
): "success" | "danger" | "warning" | "info" | "neutral" {
  switch (status) {
    case "PAID":
    case "ACCEPTED":
    case "DELIVERED":
      return "success";
    case "OVERDUE":
    case "VOID":
    case "REJECTED":
    case "CANCELLED":
      return "danger";
    case "ISSUED":
      return "info";
    case "PARTIALLY_PAID":
    case "PARTIALLY_DELIVERED":
      return "warning";
    default:
      return "neutral";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "QUOTATION":
      return "Quotation";
    case "INVOICE":
      return "Invoice";
    case "DELIVERY_NOTE":
      return "Delivery note";
    default:
      return type;
  }
}

export function DocumentsClient({
  locale,
  tenantId,
  initialPage,
  initialSearch,
  initialType,
  initialStatus,
  initialSortBy,
  initialSortOrder,
  canCreateQuotation,
  canCreateInvoice,
  canCreateDeliveryNote,
  canDownload,
  title,
  description,
}: DocumentsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [documents, setDocuments] = React.useState<DocumentListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const [page, setPage] = React.useState(initialPage);
  const [search, setSearch] = React.useState(initialSearch);
  const [type, setType] = React.useState<
    "QUOTATION" | "INVOICE" | "DELIVERY_NOTE" | ""
  >(toDocumentType(initialType));
  const [status, setStatus] = React.useState<string | "">(
    toDocumentStatus(initialStatus),
  );
  const [sortBy, setSortBy] = React.useState<SortField>(
    toSortField(initialSortBy),
  );
  const [sortOrder, setSortOrder] = React.useState<SortOrder>(
    toSortOrder(initialSortOrder),
  );

  const fetchDocuments = React.useCallback(async () => {
    setIsLoading(true);
    setServerError(null);
    try {
      const result = await getDocumentsAction({
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
        setServerError(result.error || "Failed to load documents");
        return;
      }
      if (result.data) {
        setDocuments(result.data.documents);
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
    void fetchDocuments();
  }, [fetchDocuments]);

  // The URL drives the list: every search, filter, sort and page change is a
  // `router.push` that re-renders the server parent with new props, so the local
  // mirrors have to follow them.
  React.useEffect(() => {
    setPage(initialPage);
    setSearch(initialSearch);
    setType(toDocumentType(initialType));
    setStatus(toDocumentStatus(initialStatus));
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
    if (key === "type") setType(toDocumentType(value));
    else setStatus(toDocumentStatus(value));
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

  const handleCreate = (docType: "QUOTATION" | "INVOICE" | "DELIVERY_NOTE") => {
    router.push(`/${locale}/app/documents/new?type=${docType}`);
  };

  const getContactLabel = (doc: DocumentListItem) => {
    if (!doc.contact) return "—";
    const parts = [doc.contact.firstName, doc.contact.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    return doc.contact.companyName || parts || "—";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        {(canCreateQuotation || canCreateInvoice || canCreateDeliveryNote) && (
          <div className="flex items-center gap-2">
            {canCreateQuotation && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCreate("QUOTATION")}
              >
                <FileText className="h-4 w-4 mr-2" />
                New Quotation
              </Button>
            )}
            {canCreateInvoice && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCreate("INVOICE")}
              >
                <FileText className="h-4 w-4 mr-2" />
                New Invoice
              </Button>
            )}
            {canCreateDeliveryNote && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCreate("DELIVERY_NOTE")}
              >
                <FileText className="h-4 w-4 mr-2" />
                New Delivery Note
              </Button>
            )}
          </div>
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
                placeholder="Search by number, contact, email, company..."
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
              <option value="QUOTATION">Quotation</option>
              <option value="INVOICE">Invoice</option>
              <option value="DELIVERY_NOTE">Delivery Note</option>
            </Select>
            <Select
              value={status}
              onChange={(e) => handleFilterChange("status", e.target.value)}
              className="w-full sm:w-48"
            >
              <option value="">All Statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="ISSUED">Issued</option>
              <option value="ACCEPTED">Accepted</option>
              <option value="REJECTED">Rejected</option>
              <option value="EXPIRED">Expired</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="PARTIALLY_PAID">Partially Paid</option>
              <option value="PAID">Paid</option>
              <option value="OVERDUE">Overdue</option>
              <option value="VOID">Voided</option>
              <option value="PARTIALLY_DELIVERED">Partially Delivered</option>
              <option value="DELIVERED">Delivered</option>
            </Select>
          </form>
        </div>

        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <SortableHeader
                    label="Number"
                    field="number"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                </TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>
                  <SortableHeader
                    label="Issue Date"
                    field="issueDate"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <SortableHeader
                    label="Total"
                    field="total"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
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
              ) : documents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState
                      className="border-0 bg-transparent py-12"
                      title="No documents found"
                      description={
                        search || type || status
                          ? "Try adjusting your search or filters."
                          : "Create your first quotation, invoice or delivery note."
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                documents.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="font-mono text-sm font-medium">
                      {doc.number ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                          doc.type === "QUOTATION"
                            ? "bg-blue-100 text-blue-800"
                            : doc.type === "INVOICE"
                              ? "bg-green-100 text-green-800"
                              : "bg-purple-100 text-purple-800",
                        )}
                      >
                        {typeLabel(doc.type)}
                      </span>
                    </TableCell>
                    <TableCell>{getContactLabel(doc)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {doc.issueDate
                        ? new Date(doc.issueDate).toLocaleDateString(locale)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge tone={statusTone(doc.status)}>
                        {doc.status.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {doc.total !== null && doc.total !== undefined
                        ? formatMoney(doc.total.toString(), doc.currency)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            router.push(`/${locale}/app/documents/${doc.id}`)
                          }
                          aria-label="View document"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {canDownload && doc.status !== "DRAFT" && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                window.open(
                                  `/api/documents/${doc.id}/pdf?tenantId=${tenantId}&disposition=attachment`,
                                  "_blank",
                                );
                              }}
                              aria-label="Download PDF"
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                window.open(
                                  `/api/documents/${doc.id}/pdf?tenantId=${tenantId}&disposition=inline`,
                                  "_blank",
                                );
                              }}
                              aria-label="Preview PDF"
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                          </>
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
                setPage(newPage);
                const params = new URLSearchParams(searchParams.toString());
                params.set("page", newPage.toString());
                router.push(`?${params.toString()}`);
              }}
            />
            <p className="text-sm text-muted-foreground mt-2 text-center">
              Showing {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1} to{" "}
              {Math.min(page * PAGE_SIZE, total)} of {total} documents
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
