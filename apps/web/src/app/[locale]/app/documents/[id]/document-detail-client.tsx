"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge } from "@amisibiz/ui/badge";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Label } from "@amisibiz/ui/label";
import { Select } from "@amisibiz/ui/select";
import { Textarea } from "@amisibiz/ui/textarea";
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@amisibiz/ui/table";
import { ErrorState, LoadingState } from "@amisibiz/ui/state";
import type { ActionResult } from "@/lib/errors";
import {
  allowedTransitions,
  formatMoney,
  formatPercent,
  outstandingBalance,
  sumDecimalStrings,
  type DocumentStatus,
  type TaxBreakdownEntry,
} from "@amisibiz/documents";
import {
  cancelOrderAction,
  convertQuotationAction,
  convertQuotationToOrderAction,
  createDeliveryNoteAction,
  createInvoiceFromOrderAction,
  createReplacementAction,
  getDocumentDetailAction,
  issueDocumentAction,
  recordDeliveryAction,
  recordPaymentAction,
  recordQuotationDecisionAction,
  reversePaymentAction,
  voidInvoiceAction,
  type DocumentDetail,
} from "@/server/actions/document";
import {
  documentTypeLabel,
  type DocumentTypeValue,
} from "@/components/documents/document-labels";
import { DerivativeDocumentDialog } from "@/components/documents/derivative-document-dialog";
import {
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  Printer,
  Truck,
} from "lucide-react";

/**
 * Document detail.
 *
 * Everything on this screen is a VIEW of server state plus a SET OF VERBS that
 * the server already gates. Two rules shape it:
 *
 *  1. **No client-side arithmetic.** The money shown is what the engine stored —
 *     decimal strings from `Document` and `DocumentLine`. Nothing here adds,
 *     rounds or multiplies a price. The one sum it does make (paid to date) uses
 *     `sumDecimalStrings`, the same exact helper the engine uses, over the
 *     payment rows that have not been reversed.
 *  2. **The buttons follow the state machine, and the server decides again.**
 *     Which actions appear comes from `allowedTransitions(type, status)` in
 *     `@amisibiz/documents` — the same module the service calls before it
 *     writes — combined with the permission flags the server page computed from
 *     the caller's role. Showing a button is never the check: each action is
 *     re-authorized and re-validated on the server, so a stale or tampered
 *     screen cannot issue, void or pay anything the role forbids.
 *
 * A draft is shown as the working document it is; an issued one carries its
 * frozen snapshot note and is immutable apart from the lifecycle verbs the
 * lifecycle allows (payments, deliveries, decisions, voiding, replacement).
 *
 * Every status and payment-method label comes from the `documentEnums` message
 * namespace, which is the same vocabulary the database enums use — so a new
 * locale translates one block rather than hunting through components. Type labels
 * come from it too, with one documented exception: the bundle has no `ORDER` key
 * yet, so an order is labelled from the shared English helper.
 *
 * ORDER is the same screen on purpose. An order is a `Document` of type `ORDER`,
 * so it gets the same lines, totals, snapshot note and status trail; what differs
 * is which verbs are offered (the `ORDERS_*` keys the server page resolved), the
 * words used for it — an order is never called a tax invoice here — and the two
 * derivative actions an order can start: an invoice and a delivery note.
 */

type QuotationDecision = "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED";
type PaymentMethodValue =
  "CASH" | "BANK_TRANSFER" | "MOBILE_MONEY" | "CARD" | "CHEQUE" | "OTHER";

/** The shapes the document actions can come back with, when they return data. */
type ActionData = { id?: string; number?: string; status?: string };

interface DocumentDetailClientProps {
  locale: string;
  tenantId: string;
  documentId: string;
  canIssue: boolean;
  canVoid: boolean;
  canRecordQuotationDecision: boolean;
  canConvert: boolean;
  canCreateDeliveryNote: boolean;
  canRecordDelivery: boolean;
  canRecordPayment: boolean;
  canReversePayment: boolean;
  canCreateReplacement: boolean;
  /**
   * The ORDER-scoped keys. An order is a `Document` of type `ORDER` and the
   * document actions pick the permission from the STORED type, so an order's
   * issue/void/payment buttons are only offered when `ORDERS_ISSUE` /
   * `ORDERS_VOID` are held — never on the invoice flags, which would show
   * controls the server is obliged to refuse.
   */
  canIssueOrder: boolean;
  canVoidOrder: boolean;
  canRecordOrderPayment: boolean;
  canReverseOrderPayment: boolean;
  /** `ORDERS_CREATE`: turns an accepted quotation into an order draft. */
  canCreateOrder: boolean;
  /** `INVOICES_CREATE`: raises the invoice an order is billed by. */
  canCreateInvoice: boolean;
  canDownload: boolean;
  title: string;
}

const PAYMENT_METHODS: readonly PaymentMethodValue[] = [
  "BANK_TRANSFER",
  "MOBILE_MONEY",
  "CASH",
  "CARD",
  "CHEQUE",
  "OTHER",
];

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
    case "EXPIRED":
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

function decisionLabel(decision: string): string {
  switch (decision) {
    case "ACCEPTED":
      return "Accept";
    case "REJECTED":
      return "Reject";
    case "EXPIRED":
      return "Mark expired";
    case "CANCELLED":
      return "Cancel";
    default:
      return decision;
  }
}

function decimalText(value: unknown): string {
  // Prisma hands back a Decimal object for every money and quantity column.
  // `toString()` keeps the exact stored digits; `Number(...)` would not.
  return String(value ?? "0");
}

function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}

function toIsoDate(input: string): string {
  // A date input is a calendar day; the schema coerces it to a Date. Anchoring
  // it at midnight UTC keeps the same day every timezone renders.
  return new Date(`${input}T00:00:00.000Z`).toISOString();
}

function formatDate(value: Date | string | null, locale: string): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(locale);
}

function formatDateTime(value: Date | string | null, locale: string): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Only the entries this screen can actually render are read out of the JSON
 * column; a malformed or future-shaped row is skipped rather than guessed at.
 */
function readTaxBreakdown(value: unknown): TaxBreakdownEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: TaxBreakdownEntry[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name : null;
    const rate = typeof raw.rate === "string" ? raw.rate : null;
    const base = typeof raw.base === "string" ? raw.base : null;
    const amount = typeof raw.amount === "string" ? raw.amount : null;
    if (!name || !rate || !base || !amount) continue;
    entries.push({ name, rate, base, amount });
  }
  return entries;
}

export function DocumentDetailClient({
  locale,
  tenantId,
  documentId,
  canIssue,
  canVoid,
  canRecordQuotationDecision,
  canConvert,
  canCreateDeliveryNote,
  canRecordDelivery,
  canRecordPayment,
  canReversePayment,
  canCreateReplacement,
  canIssueOrder,
  canVoidOrder,
  canRecordOrderPayment,
  canReverseOrderPayment,
  canCreateOrder,
  canCreateInvoice,
  canDownload,
  title,
}: DocumentDetailClientProps) {
  const router = useRouter();
  // The enum vocabularies live in one message namespace, shared with the
  // branding preview and the platform console, so a status reads the same in
  // every screen and in every locale.
  const tEnums = useTranslations("documentEnums");
  /**
   * `documentEnums.type` carries no `ORDER` key yet — `messages/**` belongs to the
   * consolidated i18n pass, and next-intl throws on a missing key instead of
   * rendering it — so an order takes its label from the shared English vocabulary
   * while the three types the bundle does hold keep translating.
   */
  const typeLabel = (value: string): string =>
    value === "ORDER" ? documentTypeLabel(value) : tEnums(`type.${value}`);
  const statusLabel = (value: string): string => tEnums(`status.${value}`);
  const paymentMethodLabel = (value: string): string =>
    tEnums(`paymentMethod.${value}`);

  const [document, setDocument] = React.useState<DocumentDetail | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isBusy, setIsBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  /**
   * One create-from-source dialog open at a time.
   *
   * The dialog is mounted only while it is open, which is what gives each opening
   * its own idempotency key: confirming twice replays the same write instead of
   * allocating a second document, while deciding to do the same thing again later
   * is treated as the new intent it is.
   */
  const [derivativeDialog, setDerivativeDialog] = React.useState<
    "invoice-from-order" | "delivery-note" | "order-from-quotation" | null
  >(null);

  /**
   * The status the server derived from the payment it just wrote, shown exactly as
   * it came back. Recording a payment never sets a status here; the engine does.
   */
  const [derivedStatus, setDerivedStatus] = React.useState<string | null>(null);

  // Payment form
  const [paymentAmount, setPaymentAmount] = React.useState("");
  const [paymentDate, setPaymentDate] = React.useState(todayInputValue);
  const [paymentMethod, setPaymentMethod] =
    React.useState<PaymentMethodValue>("BANK_TRANSFER");
  const [paymentReference, setPaymentReference] = React.useState("");
  const [paymentNote, setPaymentNote] = React.useState("");

  // Reason-driven actions (void / reversal) keep one open target at a time, so a
  // reason cannot be applied to the wrong row after a click elsewhere.
  const [voidReason, setVoidReason] = React.useState("");
  const [voidOpen, setVoidOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [reversalTarget, setReversalTarget] = React.useState<string | null>(
    null,
  );
  const [reversalReason, setReversalReason] = React.useState("");

  // Delivery acknowledgement: lineId → quantity the customer took.
  const [deliveredInputs, setDeliveredInputs] = React.useState<
    Record<string, string>
  >({});

  const reload = React.useCallback(async () => {
    const result = await getDocumentDetailAction(documentId, tenantId);
    if (result.success && result.data) {
      setDocument(result.data.document);
      setLoadError(null);
      return;
    }
    setLoadError(
      result.success ? "This document could not be loaded." : result.error,
    );
  }, [documentId, tenantId]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      const result = await getDocumentDetailAction(documentId, tenantId);
      if (cancelled) return;
      if (result.success && result.data) {
        setDocument(result.data.document);
      } else {
        setLoadError(
          result.success
            ? "This document could not be loaded."
            : result.error || "Failed to load document.",
        );
      }
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, tenantId]);

  /**
   * Runs one server action, reports its failure verbatim (they are written to be
   * safe to show), then reloads from the database rather than patching local
   * state — the server's answer about a lifecycle move is the only one that
   * counts, so the screen must reflect it exactly.
   */
  const runAction = React.useCallback(
    async (
      action: () => Promise<ActionResult<ActionData | void>>,
      redirectTo?: (id: string) => string,
      /** Lets a caller surface what the server returned (e.g. a derived status). */
      onResult?: (data: ActionData | undefined) => void,
    ): Promise<boolean> => {
      setIsBusy(true);
      setActionError(null);
      try {
        const result = await action();
        if (!result.success) {
          setActionError(result.error);
          return false;
        }
        onResult?.(result.data as ActionData | undefined);
        if (redirectTo) {
          const id = (result.data as ActionData | undefined)?.id;
          if (typeof id === "string") {
            router.push(redirectTo(id));
            router.refresh();
            return true;
          }
        }
        await reload();
        router.refresh();
        return true;
      } catch {
        setActionError("Something went wrong. Please try again.");
        return false;
      } finally {
        setIsBusy(false);
      }
    },
    [reload, router],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <LoadingState label="Loading document…" />
      </div>
    );
  }

  if (!document) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <ErrorState
          title="Document unavailable"
          description={
            loadError ??
            "This document does not exist in this workspace, or it was removed."
          }
          action={
            <Button
              variant="outline"
              onClick={() => router.push(`/${locale}/app/documents`)}
            >
              Back to documents
            </Button>
          }
        />
      </div>
    );
  }

  const type = document.type as DocumentTypeValue;
  const status = document.status as DocumentStatus;
  const currency = document.currency;
  const isDraft = status === "DRAFT";
  const hasSnapshot = document.snapshot !== null;

  const total = decimalText(document.total);
  const paidRows = document.payments.filter((payment) => !payment.reversedAt);
  const paid = sumDecimalStrings(paidRows.map((p) => decimalText(p.amount)));
  const outstanding = outstandingBalance(total, paid);

  const nextStatuses = allowedTransitions(type, status);
  const canMoveTo = (target: DocumentStatus): boolean =>
    nextStatuses.includes(target);

  const customerName = document.contact
    ? document.contact.companyName ||
      [document.contact.firstName, document.contact.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      "Unnamed contact"
    : "No customer";

  const breakdown = readTaxBreakdown(document.taxBreakdown);

  // Which verbs this screen offers is the state machine's answer AND the
  // server page's permission flags. Neither alone is enough, and neither is a
  // check: every action is authorized again where it is executed. The flag is
  // picked per stored type, because that is what the actions do server-side.
  const isOrder = type === "ORDER";
  const showIssue =
    isDraft && canMoveTo("ISSUED") && (isOrder ? canIssueOrder : canIssue);
  const decisions: QuotationDecision[] =
    type === "QUOTATION" && canRecordQuotationDecision
      ? (["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"] as const).filter(
          (decision) => canMoveTo(decision),
        )
      : [];
  const showConvert =
    type === "QUOTATION" && canConvert && status === "ACCEPTED";
  /** An accepted quotation can also become an ORDER instead of an invoice. */
  const showConvertToOrder =
    type === "QUOTATION" && canCreateOrder && status === "ACCEPTED";
  const showVoid =
    (isOrder ? canVoidOrder : canVoid) &&
    (isOrder || type === "INVOICE") &&
    status !== "VOID" &&
    canMoveTo("VOID");
  /**
   * The unfulfilled order's exit. A DRAFT order has no number and was never
   * issued, so closing it is a cancellation rather than a void — which is exactly
   * what `cancelOrder` accepts — and an issued one only offers it when the state
   * machine allows the move.
   */
  const showCancelOrder =
    isOrder &&
    canVoidOrder &&
    status !== "CANCELLED" &&
    status !== "VOID" &&
    (isDraft || canMoveTo("CANCELLED"));
  const showDeliveryForm =
    type === "DELIVERY_NOTE" &&
    canRecordDelivery &&
    (status === "ISSUED" || status === "PARTIALLY_DELIVERED");
  /** Only invoices and orders carry a money lifecycle. */
  const isMonetary = type === "INVOICE" || isOrder;
  const showPaymentsPanel = isMonetary && document.payments.length > 0;
  const canReverseThisPayment = isOrder
    ? canReverseOrderPayment
    : canReversePayment;
  const showPaymentForm =
    isMonetary &&
    (isOrder ? canRecordOrderPayment : canRecordPayment) &&
    !isDraft &&
    status !== "VOID" &&
    status !== "CANCELLED" &&
    status !== "PAID";
  const showDeliveryNoteCreate =
    isMonetary &&
    canCreateDeliveryNote &&
    !isDraft &&
    status !== "VOID" &&
    status !== "CANCELLED";
  /** The invoice that bills an order. The engine returns the existing one if this order is already invoiced. */
  const showInvoiceFromOrder =
    isOrder &&
    canCreateInvoice &&
    !isDraft &&
    status !== "VOID" &&
    status !== "CANCELLED";
  const showReplacement =
    isMonetary && canCreateReplacement && status === "VOID";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/${locale}/app/documents`)}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Documents
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">
              {document.number ?? `${typeLabel(type)} draft`}
            </h1>
            <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
            <Badge tone="neutral">{typeLabel(type)}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {customerName} · {currency}
          </p>
        </div>

        {canDownload && !isDraft && hasSnapshot && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                window.open(
                  `/api/documents/${document.id}/pdf?tenantId=${tenantId}&disposition=inline`,
                  "_blank",
                )
              }
            >
              <Printer className="h-4 w-4 mr-2" />
              Preview
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                window.open(
                  `/api/documents/${document.id}/pdf?tenantId=${tenantId}&disposition=attachment`,
                  "_blank",
                )
              }
            >
              <Download className="h-4 w-4 mr-2" />
              Download PDF
            </Button>
          </div>
        )}
      </div>

      {actionError && (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </div>
      )}

      {isDraft && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          This is a draft: it has no number and is not part of the legal record
          yet. Issuing it allocates the next number for this type and freezes
          the business, customer, line and tax details it will always print
          with.
        </div>
      )}

      {!isDraft && hasSnapshot && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Issued {formatDateTime(document.issuedAt, locale)} — printed from the
          snapshot frozen at {formatDateTime(document.snapshotAt, locale)}.
          Later edits to the customer, the catalogue or this workspace&apos;s
          branding cannot change this document.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-medium">Lines</h2>
          </div>
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {document.lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center">
                      <span className="text-sm text-muted-foreground">
                        This document has no lines yet. A document needs at
                        least one line before it can be issued.
                      </span>
                    </TableCell>
                  </TableRow>
                ) : (
                  document.lines.map((line) => {
                    const discountLabel =
                      line.discountType === "PERCENT"
                        ? `${decimalText(line.discountPercent)}%`
                        : line.discountType === "AMOUNT"
                          ? formatMoney(
                              decimalText(line.discountAmount),
                              currency,
                            )
                          : "—";
                    return (
                      <TableRow key={line.id}>
                        <TableCell className="text-sm text-muted-foreground">
                          {line.position}
                        </TableCell>
                        <TableCell>
                          <p className="text-sm">{line.description}</p>
                          {line.itemCode && (
                            <p className="text-xs text-muted-foreground">
                              {line.itemCode}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {decimalText(line.quantity)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {line.unitOfMeasure}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatMoney(decimalText(line.unitPrice), currency)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {discountLabel}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          <p>
                            {formatMoney(decimalText(line.lineTax), currency)}
                          </p>
                          {line.taxName && (
                            <p className="text-xs text-muted-foreground">
                              {line.taxName} (
                              {formatPercent(decimalText(line.taxRate))})
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatMoney(decimalText(line.lineTotal), currency)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </TableContainer>
          {document.lines.length > 0 && (
            <div className="p-4 border-t border-border text-xs text-muted-foreground">
              Amount is quantity × unit price, rounded per line by the stored
              policy ({document.roundingPolicy}). Discount and tax are the
              figures the engine computed and saved — not recomputed here.
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="card">
            <div className="p-4 border-b border-border">
              <h2 className="text-lg font-medium">Totals</h2>
            </div>
            <div className="p-4 space-y-2 text-sm">
              <TotalRow
                label="Subtotal"
                value={formatMoney(decimalText(document.subtotal), currency)}
              />
              <TotalRow
                label="Discount"
                value={`− ${formatMoney(decimalText(document.totalDiscount), currency)}`}
              />
              <TotalRow
                label="Taxable base"
                value={formatMoney(decimalText(document.taxableBase), currency)}
              />
              {breakdown.map((entry) => (
                <TotalRow
                  key={`${entry.name}-${entry.rate}`}
                  label={`${entry.name} · ${formatPercent(entry.rate)}`}
                  value={formatMoney(entry.amount, currency)}
                  muted
                />
              ))}
              <TotalRow
                label="Tax"
                value={formatMoney(decimalText(document.taxTotal), currency)}
              />
              <div className="border-t border-border pt-2">
                <TotalRow
                  label="Total"
                  value={formatMoney(total, currency)}
                  strong
                />
              </div>
              {isMonetary && !isDraft && (
                <>
                  <div className="border-t border-border pt-2 space-y-2">
                    <TotalRow
                      label="Paid"
                      value={formatMoney(paid, currency)}
                    />
                    <TotalRow
                      label="Outstanding"
                      value={formatMoney(outstanding, currency)}
                      strong
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Outstanding is the stored total minus the {paidRows.length}{" "}
                    recorded payment
                    {paidRows.length === 1 ? "" : "s"}. Payments are
                    transactions; the {isOrder ? "order" : "invoice"} status
                    above is derived from them by the server.
                  </p>
                </>
              )}
              {isOrder && !isDraft && (
                <p className="text-xs text-muted-foreground">
                  This is an order, not a tax invoice. Money noted here is
                  received against the order; the invoice raised from it is the
                  document that requests payment.
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="p-4 border-b border-border">
              <h2 className="text-lg font-medium">Customer</h2>
            </div>
            <div className="p-4 space-y-2 text-sm">
              <FactRow label="Name" value={customerName} />
              <FactRow
                label="Type"
                value={document.contact ? document.contact.type : "—"}
              />
              <FactRow label="Email" value={document.contact?.email ?? "—"} />
              <p className="text-xs text-muted-foreground">
                An issued document prints the customer block frozen when it was
                issued.
              </p>
            </div>
          </div>

          <div className="card">
            <div className="p-4 border-b border-border">
              <h2 className="text-lg font-medium">Dates</h2>
            </div>
            <div className="p-4 space-y-2 text-sm">
              <FactRow
                label="Issue date"
                value={formatDate(document.issueDate, locale)}
              />
              <FactRow
                label="Due date"
                value={formatDate(document.dueDate, locale)}
              />
              <FactRow
                label="Valid until"
                value={formatDate(document.expiryDate, locale)}
              />
              <FactRow
                label="Delivery date"
                value={formatDate(document.deliveryDate, locale)}
              />
              <FactRow
                label="Created"
                value={formatDateTime(document.createdAt, locale)}
              />
              {document.voidedAt && (
                <FactRow
                  label="Voided"
                  value={formatDateTime(document.voidedAt, locale)}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {(document.customerNote ||
        document.terms ||
        document.deliveryNote ||
        (isMonetary && document.voidReason)) && (
        <div className="card">
          <div className="p-4 space-y-4 text-sm">
            {document.customerNote && (
              <div>
                <h3 className="font-medium mb-1">Customer note</h3>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {document.customerNote}
                </p>
              </div>
            )}
            {document.terms && (
              <div>
                <h3 className="font-medium mb-1">Terms</h3>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {document.terms}
                </p>
              </div>
            )}
            {document.deliveryNote && (
              <div>
                <h3 className="font-medium mb-1">Delivery instructions</h3>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {document.deliveryNote}
                </p>
              </div>
            )}
            {document.voidReason && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <h3 className="font-medium mb-1 text-destructive">
                  Void reason
                </h3>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {document.voidReason}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {showPaymentsPanel && (
        <div className="card">
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-medium">Payments</h2>
          </div>
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {document.payments.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell className="text-sm">
                      {formatDate(payment.occurredOn, locale)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {paymentMethodLabel(payment.method)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {payment.reference ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatMoney(decimalText(payment.amount), currency)}
                      {payment.reversedAt && (
                        <Badge tone="danger" className="ml-2">
                          Reversed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canReverseThisPayment && !payment.reversedAt ? (
                        reversalTarget === payment.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <Input
                              aria-label="Reversal reason"
                              value={reversalReason}
                              onChange={(e) =>
                                setReversalReason(e.target.value)
                              }
                              placeholder="Reason (required)"
                              className="h-8 w-48"
                            />
                            <Button
                              size="sm"
                              variant="danger"
                              loading={isBusy}
                              disabled={reversalReason.trim().length < 3}
                              onClick={() =>
                                void runAction(() =>
                                  reversePaymentAction({
                                    tenantId,
                                    paymentId: payment.id,
                                    reason: reversalReason.trim(),
                                  }),
                                ).then((ok) => {
                                  if (ok) {
                                    setReversalTarget(null);
                                    setReversalReason("");
                                  }
                                })
                              }
                            >
                              Confirm
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setReversalTarget(null);
                                setReversalReason("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setReversalTarget(payment.id);
                              setReversalReason("");
                              setVoidOpen(false);
                            }}
                          >
                            Reverse
                          </Button>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <p className="p-4 border-t border-border text-xs text-muted-foreground">
            Reversing a payment keeps the row and marks it reversed, then the
            server re-derives the {isOrder ? "order" : "invoice"} status. A
            status is never set by hand.
          </p>
        </div>
      )}

      {type === "DELIVERY_NOTE" && document.lines.length > 0 && (
        <div className="card">
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-medium">Delivered quantities</h2>
          </div>
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Acknowledged</TableHead>
                  {showDeliveryForm && (
                    <TableHead className="text-right">Record</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {document.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="text-sm">
                      {line.description}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {decimalText(line.quantity)} {line.unitOfMeasure}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {decimalText(line.deliveredQuantity)}
                    </TableCell>
                    {showDeliveryForm && (
                      <TableCell className="text-right">
                        <Input
                          aria-label={`Delivered quantity for ${line.description}`}
                          type="number"
                          step="0.0001"
                          min="0"
                          className="h-8 w-28 ml-auto"
                          value={
                            deliveredInputs[line.id] ??
                            decimalText(line.deliveredQuantity)
                          }
                          onChange={(e) =>
                            setDeliveredInputs((prev) => ({
                              ...prev,
                              [line.id]: e.target.value,
                            }))
                          }
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {showDeliveryForm && (
            <div className="p-4 border-t border-border flex items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                Delivery acknowledgements are the customer&apos;s receipt of
                these quantities. They do not touch invoiced amounts or
                payments.
              </p>
              <Button
                size="sm"
                loading={isBusy}
                onClick={() =>
                  void runAction(() =>
                    recordDeliveryAction({
                      tenantId,
                      documentId: document.id,
                      acknowledgements: document.lines.map((line) => ({
                        lineId: line.id,
                        deliveredQuantity:
                          deliveredInputs[line.id] ??
                          decimalText(line.deliveredQuantity),
                      })),
                    }),
                  )
                }
              >
                Save acknowledgements
              </Button>
            </div>
          )}
        </div>
      )}

      {document.statusEvents.length > 0 && (
        <div className="card">
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-medium">Status history</h2>
          </div>
          <ul className="p-4 space-y-2 text-sm">
            {document.statusEvents.map((event) => (
              <li key={event.id} className="flex flex-wrap gap-2">
                <span className="text-muted-foreground">
                  {formatDateTime(event.createdAt, locale)}
                </span>
                <Badge tone={statusTone(event.toStatus)}>
                  {event.fromStatus
                    ? `${statusLabel(event.fromStatus)} → ${statusLabel(event.toStatus)}`
                    : statusLabel(event.toStatus)}
                </Badge>
                {event.reason && (
                  <span className="text-muted-foreground">{event.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-medium">Actions</h2>
        </div>
        <div className="p-4 space-y-6">
          {showIssue && (
            <section className="space-y-3">
              <h3 className="font-medium">Issue this draft</h3>
              <p className="text-sm text-muted-foreground">
                Allocates the next number for this type, freezes the snapshot
                and writes the audit row in one transaction. Lines and currency
                cannot change on the way through.
              </p>
              <Button
                loading={isBusy}
                disabled={document.lines.length === 0}
                onClick={() =>
                  void runAction(() =>
                    issueDocumentAction({
                      tenantId,
                      documentId: document.id,
                      issueDate: new Date(document.issueDate).toISOString(),
                    }),
                  )
                }
              >
                Issue {typeLabel(type)}
              </Button>
              {document.lines.length === 0 && (
                <p className="text-sm text-destructive">
                  Add at least one line before issuing.
                </p>
              )}
            </section>
          )}

          {decisions.length > 0 && (
            <section className="space-y-3">
              <h3 className="font-medium">Record the customer&apos;s answer</h3>
              <p className="text-sm text-muted-foreground">
                Only the moves this quotation can still make are offered. The
                server re-checks the lifecycle and the role on submission.
              </p>
              <div className="flex flex-wrap gap-2">
                {decisions.map((decision) => (
                  <Button
                    key={decision}
                    variant={decision === "ACCEPTED" ? "primary" : "outline"}
                    size="sm"
                    loading={isBusy}
                    onClick={() =>
                      void runAction(() =>
                        recordQuotationDecisionAction({
                          tenantId,
                          documentId: document.id,
                          decision,
                        }),
                      )
                    }
                  >
                    {decisionLabel(decision)}
                  </Button>
                ))}
              </div>
            </section>
          )}

          {showConvert && (
            <section className="space-y-3">
              <h3 className="font-medium">Convert to invoice</h3>
              <p className="text-sm text-muted-foreground">
                Creates a NEW draft invoice carrying this quotation&apos;s
                customer, currency and lines. The quotation itself stays as
                issued. Any change to a price is a separate, audited edit on
                that draft — conversion never re-prices anything.
              </p>
              <Button
                loading={isBusy}
                onClick={() =>
                  void runAction(
                    () =>
                      convertQuotationAction({
                        tenantId,
                        quotationId: document.id,
                      }),
                    (id) => `/${locale}/app/documents/${id}`,
                  )
                }
              >
                Create invoice draft
              </Button>
            </section>
          )}

          {showConvertToOrder && (
            <section className="space-y-3">
              <h3 className="font-medium">Convert to order</h3>
              <p className="text-sm text-muted-foreground">
                Creates a NEW draft order carrying this quotation&apos;s
                customer, currency and lines; the quotation itself stays as
                issued. An order records what the customer asked for — it is not
                a tax invoice, and the invoice that requests payment is raised
                from the order after it is issued.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDerivativeDialog("order-from-quotation")}
              >
                <FileText className="h-4 w-4 mr-2" />
                Create order draft
              </Button>
            </section>
          )}

          {showInvoiceFromOrder && (
            <section className="space-y-3">
              <h3 className="font-medium">Create invoice from order</h3>
              <p className="text-sm text-muted-foreground">
                Raises a draft invoice for exactly the figures this order
                agreed. Issuing that invoice is what requests payment and
                creates the tax document; this step alone does neither.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDerivativeDialog("invoice-from-order")}
              >
                <FileText className="h-4 w-4 mr-2" />
                Create invoice draft
              </Button>
            </section>
          )}

          {showCancelOrder && (
            <section className="space-y-3">
              <h3 className="font-medium">Cancel this order</h3>
              <p className="text-sm text-muted-foreground">
                Closing an order that was never fulfilled. The row and its
                number are kept and the reason is written to the status trail —
                a cancelled order is not deleted. An order with goods already
                acknowledged on a delivery note is refused until that delivery
                is corrected.
              </p>
              {cancelOpen ? (
                <div className="space-y-3">
                  <Label htmlFor="cancel-reason">Reason</Label>
                  <Textarea
                    id="cancel-reason"
                    rows={2}
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder="Why this order is being cancelled"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      loading={isBusy}
                      disabled={cancelReason.trim().length < 3}
                      onClick={() =>
                        void runAction(() =>
                          cancelOrderAction({
                            tenantId,
                            documentId: document.id,
                            reason: cancelReason.trim(),
                          }),
                        ).then((ok) => {
                          if (ok) {
                            setCancelOpen(false);
                            setCancelReason("");
                          }
                        })
                      }
                    >
                      Confirm cancellation
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setCancelOpen(false);
                        setCancelReason("");
                      }}
                    >
                      Keep the order open
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A reason of at least three characters is required.
                  </p>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCancelOpen(true);
                    setVoidOpen(false);
                    setReversalTarget(null);
                  }}
                >
                  Cancel order
                </Button>
              )}
            </section>
          )}
          {showDeliveryNoteCreate && (
            <section className="space-y-3">
              <h3 className="font-medium">Raise a delivery note</h3>
              <p className="text-sm text-muted-foreground">
                Drafts a delivery note against this{" "}
                {isOrder ? "order" : "invoice"}&apos;s lines, each defaulting to
                the quantity still outstanding. What the customer acknowledges
                is recorded on the note, separate from what was billed and paid.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDerivativeDialog("delivery-note")}
              >
                <Truck className="h-4 w-4 mr-2" />
                Create delivery note draft
              </Button>
            </section>
          )}

          {showPaymentForm && (
            <section className="space-y-3">
              <h3 className="font-medium">Record a payment</h3>
              <p className="text-sm text-muted-foreground">
                Records money the business says it received. Nothing here is a
                confirmation from a bank or a payment provider, and the{" "}
                {isOrder ? "order" : "invoice"} status is derived by the server
                from the payments it holds.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1">
                  <Label htmlFor="payment-amount">Amount ({currency})</Label>
                  <Input
                    id="payment-amount"
                    inputMode="decimal"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    placeholder={outstanding}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="payment-date">Received on</Label>
                  <Input
                    id="payment-date"
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="payment-method">Method</Label>
                  <Select
                    id="payment-method"
                    value={paymentMethod}
                    onChange={(e) =>
                      setPaymentMethod(e.target.value as PaymentMethodValue)
                    }
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {paymentMethodLabel(method)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="payment-reference">Reference</Label>
                  <Input
                    id="payment-reference"
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    placeholder="M-Pesa code, transfer ref…"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="payment-note">Note</Label>
                <Textarea
                  id="payment-note"
                  rows={2}
                  value={paymentNote}
                  onChange={(e) => setPaymentNote(e.target.value)}
                  placeholder="Anything a later auditor should know"
                />
              </div>
              <Button
                loading={isBusy}
                disabled={!/^\d+(\.\d{1,4})?$/.test(paymentAmount.trim())}
                onClick={() =>
                  void runAction(
                    () =>
                      recordPaymentAction({
                        tenantId,
                        documentId: document.id,
                        amount: paymentAmount.trim(),
                        occurredOn: toIsoDate(paymentDate),
                        method: paymentMethod,
                        reference: paymentReference.trim() || null,
                        note: paymentNote.trim() || null,
                      }),
                    undefined,
                    // The status the server derived from the payment it wrote.
                    (data) => {
                      if (typeof data?.status === "string") {
                        setDerivedStatus(data.status);
                      }
                    },
                  ).then((ok) => {
                    if (ok) {
                      setPaymentAmount("");
                      setPaymentReference("");
                      setPaymentNote("");
                    }
                  })
                }
              >
                Record payment
              </Button>
              {derivedStatus && (
                <div
                  className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm"
                  role="status"
                >
                  <p>
                    Payment recorded. The server set the{" "}
                    {isOrder ? "order" : "invoice"} status to{" "}
                    <strong>{statusLabel(derivedStatus)}</strong> from the
                    payments it holds.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1"
                    onClick={() => setDerivedStatus(null)}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </section>
          )}

          {showVoid && (
            <section className="space-y-3">
              <h3 className="font-medium">
                Void this {isOrder ? "order" : "invoice"}
              </h3>
              <p className="text-sm text-muted-foreground">
                Keeps the row, its number and its history: a voided{" "}
                {isOrder ? "order" : "invoice"} is cancelled against the
                customer, never deleted. A reason is required and is written to
                the audit trail.
              </p>
              {voidOpen ? (
                <div className="space-y-3">
                  <Label htmlFor="void-reason">Reason</Label>
                  <Textarea
                    id="void-reason"
                    rows={2}
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    placeholder={
                      isOrder
                        ? "Why this order is being voided"
                        : "Why this invoice is being cancelled"
                    }
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      loading={isBusy}
                      disabled={voidReason.trim().length < 3}
                      onClick={() =>
                        void runAction(() =>
                          voidInvoiceAction({
                            tenantId,
                            documentId: document.id,
                            reason: voidReason.trim(),
                          }),
                        ).then((ok) => {
                          if (ok) {
                            setVoidOpen(false);
                            setVoidReason("");
                          }
                        })
                      }
                    >
                      Confirm void
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setVoidOpen(false);
                        setVoidReason("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A reason of at least three characters is required.
                  </p>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setVoidOpen(true);
                    setReversalTarget(null);
                    setCancelOpen(false);
                  }}
                >
                  Void {isOrder ? "order" : "invoice"}
                </Button>
              )}
            </section>
          )}

          {showReplacement && (
            <section className="space-y-3">
              <h3 className="font-medium">Create a replacement draft</h3>
              <p className="text-sm text-muted-foreground">
                The controlled correction: a new draft linked to this voided
                document, which keeps its own number and its own place in the
                trail. Nothing on the voided document changes.
                {isOrder &&
                  " This action is gated on the invoice-create permission the server requires for it, and the replacement is a new order draft."}
              </p>
              <Button
                variant="outline"
                size="sm"
                loading={isBusy}
                onClick={() =>
                  void runAction(
                    () =>
                      createReplacementAction({
                        tenantId,
                        documentId: document.id,
                      }),
                    (id) => `/${locale}/app/documents/${id}`,
                  )
                }
              >
                Create replacement draft
              </Button>
            </section>
          )}

          {!showIssue &&
            decisions.length === 0 &&
            !showConvert &&
            !showConvertToOrder &&
            !showInvoiceFromOrder &&
            !showCancelOrder &&
            !showPaymentForm &&
            !showVoid &&
            !showDeliveryForm &&
            !showDeliveryNoteCreate &&
            !showReplacement && (
              <p className="text-sm text-muted-foreground">
                No further action is available for this document.{" "}
                {!isDraft &&
                  "Issued documents are immutable; corrections go through voiding and a replacement."}{" "}
                {!canIssue &&
                  !canIssueOrder &&
                  !canVoid &&
                  !canVoidOrder &&
                  "Actions a role cannot perform are not offered here; the server checks the same permissions again on submission."}
              </p>
            )}
        </div>
      </div>

      {derivativeDialog === "order-from-quotation" && (
        <DerivativeDocumentDialog
          title="Create an order draft from this quotation"
          description="The order carries this quotation's customer, currency and lines. The server re-reads its own catalogue for the figures; nothing here re-prices them."
          confirmLabel="Create order draft"
          fields={["issueDate"]}
          notice="An order is a commercial request, not a tax invoice. If an order has already been raised from this quotation, the server returns that one instead of creating a second."
          run={(input) =>
            convertQuotationToOrderAction({
              tenantId,
              quotationId: document.id,
              issueDate: input.issueDate,
              idempotencyKey: input.idempotencyKey,
            })
          }
          onCreated={(id) => {
            setDerivativeDialog(null);
            router.push(`/${locale}/app/documents/${id}`);
            router.refresh();
          }}
          onClose={() => setDerivativeDialog(null)}
        />
      )}

      {derivativeDialog === "invoice-from-order" && (
        <DerivativeDocumentDialog
          title="Create an invoice draft from this order"
          description="A draft invoice for exactly the figures this order agreed, dated from the day chosen below. Issuing that invoice is the step that requests payment."
          confirmLabel="Create invoice draft"
          fields={["issueDate", "dueDate"]}
          notice="Only one invoice is raised per order: if this order is already invoiced, the server returns the existing invoice instead of creating a second."
          run={(input) =>
            createInvoiceFromOrderAction({
              tenantId,
              orderId: document.id,
              issueDate: input.issueDate,
              dueDate: input.dueDate,
              idempotencyKey: input.idempotencyKey,
            })
          }
          onCreated={(id) => {
            setDerivativeDialog(null);
            router.push(`/${locale}/app/documents/${id}`);
            router.refresh();
          }}
          onClose={() => setDerivativeDialog(null)}
        />
      )}

      {derivativeDialog === "delivery-note" && (
        <DerivativeDocumentDialog
          title="Create a delivery note draft"
          description={`A delivery note for this ${
            isOrder ? "order" : "invoice"
          }'s lines, each defaulting to the quantity still outstanding. Several notes may reference the same document.`}
          confirmLabel="Create delivery note draft"
          fields={["deliveryDate"]}
          run={(input) =>
            createDeliveryNoteAction({
              tenantId,
              sourceDocumentId: document.id,
              deliveryDate: input.deliveryDate,
              idempotencyKey: input.idempotencyKey,
            })
          }
          onCreated={(id) => {
            setDerivativeDialog(null);
            router.push(`/${locale}/app/documents/${id}`);
            router.refresh();
          }}
          onClose={() => setDerivativeDialog(null)}
        />
      )}

      {isBusy && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Working…
        </p>
      )}
    </div>
  );
}

function TotalRow({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span
        className={
          muted
            ? "text-xs text-muted-foreground"
            : strong
              ? "font-medium"
              : "text-muted-foreground"
        }
      >
        {label}
      </span>
      <span
        className={
          strong ? "font-mono font-semibold" : "font-mono text-sm text-right"
        }
      >
        {value}
      </span>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right break-words">{value}</span>
    </div>
  );
}
