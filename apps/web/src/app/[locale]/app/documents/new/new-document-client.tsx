"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Textarea } from "@amisibiz/ui/textarea";
import { Label } from "@amisibiz/ui/label";
import { Separator } from "@amisibiz/ui/separator";
import { createDocumentDraftAction } from "@/server/actions/document";
import { getContactItemsAction } from "@/server/actions/contact-item";
import {
  resolveCatalogueLineFacts,
  type CatalogueItemSource,
  type CustomerCatalogueOverride,
  type DocumentLineDiscount,
} from "@amisibiz/documents";
import { Plus, X, FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  documentTypeLabel,
  type DocumentTypeFilter,
  type DocumentTypeValue,
} from "@/components/documents/document-labels";

interface ContactOption {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  type: "INDIVIDUAL" | "BUSINESS";
}

/**
 * A catalogue row, in exactly the shape the shared precedence function takes.
 *
 * The form runs `resolveCatalogueLineFacts` from `@amisibiz/documents` — the same
 * function the server's line resolver calls inside the write transaction — so what
 * this page previews and what the server stores are produced by one implementation,
 * not by two that have to be kept in step.
 */
export type ItemOption = CatalogueItemSource;

/** One of the tenant's tax classifications, for a line that is not a catalogue line. */
export interface TaxRateOption {
  id: string;
  label: string;
}

/** A customer's agreement for one catalogue item. */
interface AgreementOption extends CustomerCatalogueOverride {
  itemId: string;
}

interface NewDocumentClientProps {
  locale: string;
  tenantId: string;
  contacts: ContactOption[];
  itemOptions: ItemOption[];
  taxRateOptions: TaxRateOption[];
  /** False when the role may write documents but may not read the catalogue. */
  canReadCatalogue: boolean;
  initialType: DocumentTypeFilter;
  allowedTypes: DocumentTypeValue[];
  canCreateQuotation: boolean;
  canCreateInvoice: boolean;
  canCreateDeliveryNote: boolean;
  /** `ORDERS_CREATE`: without it the order choice is never offered. */
  canCreateOrder: boolean;
  title: string;
  description: string;
}

interface LineInput {
  id: string;
  /** Empty means a free-text line, which the engine prices from this request. */
  itemId: string;
  /** Read-only on a catalogue line: it is the item's code, not the writer's. */
  itemCode: string;
  description: string;
  quantity: string;
  unitPrice: string;
  unitOfMeasure: string;
  discountType: "PERCENT" | "AMOUNT" | "";
  discountPercent: string;
  discountAmount: string;
  taxRateId: string;
  /** Which price won, as the resolver reported it. Drives the hint below. */
  priceSource: "customer" | "catalogue" | "";
}

const DEFAULT_LINE: Omit<LineInput, "id"> = {
  itemId: "",
  itemCode: "",
  description: "",
  quantity: "1",
  unitPrice: "0",
  unitOfMeasure: "each",
  discountType: "",
  discountPercent: "0",
  discountAmount: "0",
  taxRateId: "",
  priceSource: "",
};

/** Mirrors `decimalStringSchema(4)` for the two fields a line is priced from. */
const DECIMAL_QUANTITY = /^\d+(?:\.\d{1,4})?$/;
const DECIMAL_AMOUNT = /^\d+(?:\.\d{1,4})?$/;
/** `percentSchema` — a percentage discount is 0–100, never a fraction. */
const DECIMAL_PERCENT = /^(?:100|[1-9]?\d)(?:\.\d{1,4})?$/;

/**
 * A date input names a calendar day, so it is anchored at midnight UTC.
 *
 * The detail view does the same and the server reads the day back out of the
 * timestamp (`calendarDate`), which is what makes an agreement's validity window be
 * tested against the day the person typed. A local-midnight reading would push a
 * +03:00 "today" back a day — and with it the price the line resolves at.
 */
function toIsoDate(input: string): string {
  return new Date(`${input}T00:00:00.000Z`).toISOString();
}

/**
 * The fields the catalogue owns on a line.
 *
 * Compared rather than blindly copied, so the re-pricing effect below only renders
 * when a figure genuinely changed.
 */
function factsEqual(a: LineInput, b: LineInput): boolean {
  return (
    a.description === b.description &&
    a.itemCode === b.itemCode &&
    a.unitOfMeasure === b.unitOfMeasure &&
    a.unitPrice === b.unitPrice &&
    a.discountType === b.discountType &&
    a.discountPercent === b.discountPercent &&
    a.discountAmount === b.discountAmount &&
    a.taxRateId === b.taxRateId &&
    a.priceSource === b.priceSource
  );
}

/** The line's own discount, in the shape the shared resolver takes. */
function discountOf(line: LineInput): DocumentLineDiscount {
  return {
    discountType: line.discountType || null,
    discountPercent: line.discountPercent || "0",
    discountAmount: line.discountAmount || "0",
  };
}

/**
 * Refills a line from the catalogue and that customer's agreement.
 *
 * This calls `resolveCatalogueLineFacts` — the same function the server's line
 * resolver calls inside the write transaction — so the figure shown here is the
 * figure that will be stored, and a suspended or expired agreement falls back to the
 * standard price on both sides. Everything it returns is copied, including the
 * discount and the tax classification, because the server overwrites all of it on
 * submit: a price typed into this form has no authority over a catalogue item.
 */
function applyCatalogueFacts(
  line: LineInput,
  item: ItemOption,
  agreement: AgreementOption | null,
  asOf: string,
): LineInput {
  const facts = resolveCatalogueLineFacts({
    item,
    override: agreement,
    documentDiscount: discountOf(line),
    // The issue date is the day the agreement's window is tested against, read the
    // same way the server reads it (`calendarDate(input.issueDate)`).
    asOf,
  });

  return {
    ...line,
    description: facts.description,
    itemCode: facts.itemCode ?? "",
    unitOfMeasure: facts.unitOfMeasure,
    unitPrice: facts.unitPrice,
    discountType: facts.discountType ?? "",
    discountPercent: facts.discountPercent,
    discountAmount: facts.discountAmount,
    taxRateId: facts.taxRateId ?? "",
    priceSource: facts.priceSource,
  };
}

/**
 * What each type is for, in one line, so the choice on this form is made with the
 * document's role in mind. An order is deliberately described as a request, not as
 * a tax document: the invoice raised from it is the one that requests payment.
 */
const TYPE_HINTS: Record<DocumentTypeValue, string> = {
  QUOTATION:
    "A priced offer. The customer can accept or reject it, and an accepted quotation can become an order or an invoice.",
  ORDER: "What the customer has asked for. It is not a tax invoice.",
  INVOICE:
    "A tax document that requests payment. Issuing it allocates a number and freezes the totals.",
  DELIVERY_NOTE:
    "What was handed over. Acknowledged quantities are recorded on the note, not on the invoice.",
};

export function NewDocumentClient({
  locale,
  tenantId,
  contacts,
  itemOptions,
  taxRateOptions,
  canReadCatalogue,
  initialType,
  allowedTypes,
  canCreateQuotation,
  canCreateInvoice,
  canCreateDeliveryNote,
  canCreateOrder,
  title,
  description,
}: NewDocumentClientProps) {
  const router = useRouter();

  const [docType, setDocType] = React.useState<DocumentTypeValue>(
    (initialType || allowedTypes[0] || "QUOTATION") as DocumentTypeValue,
  );
  const [contactId, setContactId] = React.useState<string>("");
  const [currency, setCurrency] = React.useState("KES");
  // Typed as `string` and built with `slice`: `split("T")[0]` would make the state
  // `string | undefined`, and this value is now the day every agreement window is
  // tested against.
  const [issueDate, setIssueDate] = React.useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [dueDate, setDueDate] = React.useState("");
  const [expiryDate, setExpiryDate] = React.useState("");
  const [customerNote, setCustomerNote] = React.useState("");
  const [terms, setTerms] = React.useState("");

  const [lines, setLines] = React.useState<LineInput[]>([
    { id: crypto.randomUUID(), ...DEFAULT_LINE },
  ]);
  /**
   * One key for the whole form, generated at mount.
   *
   * The engine treats a repeated key as the same write and returns the document it
   * already created, so a double submit or a retry after a lost response cannot
   * produce two drafts. A fresh page visit is a fresh intent and gets a fresh key.
   */
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<
    Record<string, string[]>
  >({});

  /* ------------------------- the customer's agreements ------------------------- */

  /**
   * This customer's catalogue agreements, loaded when they are chosen.
   *
   * Read through the same authorized action the customer's own pricing page uses,
   * so the server's tenant check runs on the way in; the keyed-by-item shape is
   * what the resolver wants, because `(tenant, contact, item)` is the unique
   * agreement triple. A failure here is not fatal: with no agreement loaded every
   * line previews at the standard price, and the server still applies the real
   * agreement when the draft is written.
   */
  const [agreements, setAgreements] = React.useState<
    Record<string, AgreementOption>
  >({});
  const [agreementsState, setAgreementsState] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [agreementsTruncated, setAgreementsTruncated] = React.useState(false);

  React.useEffect(() => {
    if (!contactId || !canReadCatalogue) {
      setAgreements({});
      setAgreementsState("idle");
      setAgreementsTruncated(false);
      return;
    }

    let active = true;
    setAgreementsState("loading");

    async function loadAgreements() {
      const result = await getContactItemsAction({
        tenantId,
        contactId,
        page: 1,
        pageSize: 100,
      });
      if (!active) return;

      if (!result.success || !result.data) {
        setAgreements({});
        setAgreementsState("error");
        return;
      }

      setAgreements(
        Object.fromEntries(
          result.data.contactItems.map((row) => [
            row.itemId,
            {
              itemId: row.itemId,
              customCode: row.customCode,
              customName: row.customName,
              customUnitOfMeasure: row.customUnitOfMeasure,
              // Exact text again: a Decimal never becomes a JS number here.
              agreedPrice: row.agreedPrice.toFixed(4),
              discountPercent: row.discountPercent.toFixed(4),
              isAvailable: row.isAvailable,
              validFrom: row.validFrom?.toISOString() ?? null,
              validUntil: row.validUntil?.toISOString() ?? null,
            },
          ]),
        ),
      );
      setAgreementsTruncated(
        result.data.total > result.data.contactItems.length,
      );
      setAgreementsState("ready");
    }

    loadAgreements();
    return () => {
      active = false;
    };
  }, [contactId, tenantId, canReadCatalogue]);

  const itemsById = React.useMemo(
    () => new Map(itemOptions.map((item) => [item.itemId, item])),
    [itemOptions],
  );

  /**
   * Re-prices every catalogue line when the customer, the issue date or the
   * agreements change.
   *
   * `lines` is deliberately NOT a dependency: the update is functional, and leaving
   * it out is what keeps this from re-running on every keystroke (which would also
   * fight the person typing a quantity). The date matters because an agreement is
   * only in force inside its own window — moving the issue date out of the window
   * moves the line back to the standard price, exactly as the server would.
   */
  React.useEffect(() => {
    setLines((previous) => {
      let changed = false;
      const next = previous.map((line) => {
        if (!line.itemId) return line;
        const item = itemsById.get(line.itemId);
        // A catalogue row that is no longer offered (archived between loads) keeps
        // the figures it was filled with; the server gives the definitive answer.
        if (!item) return line;
        const priced = applyCatalogueFacts(
          line,
          item,
          agreements[line.itemId] ?? null,
          issueDate,
        );
        if (factsEqual(line, priced)) return line;
        changed = true;
        return priced;
      });
      return changed ? next : previous;
    });
  }, [agreements, issueDate, itemsById]);

  /* -------------------------------- line edits -------------------------------- */

  const addLine = () => {
    setLines((previous) => [
      ...previous,
      { id: crypto.randomUUID(), ...DEFAULT_LINE },
    ]);
  };

  const removeLine = (id: string) => {
    setLines((previous) =>
      previous.length <= 1
        ? previous
        : previous.filter((line) => line.id !== id),
    );
  };

  /**
   * Field errors are keyed by LINE ID (`<id>-description`), not by row index: an
   * index shifts the moment a line above it is removed, which would leave the
   * message pinned to the wrong row. `setLines` keeps ids stable, so the error
   * follows the line it belongs to.
   */
  const updateLine = (id: string, field: keyof LineInput, value: string) => {
    setLines((previous) =>
      previous.map((line) =>
        line.id === id ? { ...line, [field]: value } : line,
      ),
    );
    setFieldErrors((previous) => {
      const key = `${id}-${field}`;
      if (!previous[key]) return previous;
      const { [key]: _cleared, ...rest } = previous;
      return rest;
    });
  };

  /**
   * Choosing a catalogue item fills the line from it; clearing the choice hands the
   * line back to the writer as a free-text line.
   *
   * The fill is a preview of the server's own answer, and the fields it sets are
   * read-only for exactly that reason — quantity is the only commercial figure a
   * person types for a catalogue line.
   */
  const selectItem = (id: string, itemId: string) => {
    setLines((previous) =>
      previous.map((line) => {
        if (line.id !== id) return line;
        if (!itemId) {
          return { ...line, itemId: "", itemCode: "", priceSource: "" };
        }
        const item = itemsById.get(itemId);
        const chosen: LineInput = { ...line, itemId };
        // An item the resolver could not be shown a row for keeps its manual
        // fields; the server still refuses it if it is not this tenant's.
        if (!item) return chosen;
        return applyCatalogueFacts(
          chosen,
          item,
          agreements[itemId] ?? null,
          issueDate,
        );
      }),
    );
    setFieldErrors((previous) => {
      const rest = { ...previous };
      for (const field of ["description", "unitPrice", "quantity"] as const) {
        delete rest[`${id}-${field}`];
      }
      return rest;
    });
  };

  const validateForm = () => {
    const errors: Record<string, string[]> = {};

    if (!docType) {
      errors.type = ["Document type is required"];
    }
    if (!issueDate) {
      errors.issueDate = ["Issue date is required"];
    }
    if (lines.length === 0) {
      errors.lines = ["At least one line is required"];
    } else {
      for (const line of lines) {
        if (!line.description.trim()) {
          errors[`${line.id}-description`] = ["Description is required"];
        }
        // The same shape the write schema accepts: a plain decimal, never
        // scientific notation or a JS number. Checking it here means the engine
        // is not the first place a bad value is noticed.
        if (
          !DECIMAL_QUANTITY.test(line.quantity.trim()) ||
          Number(line.quantity) <= 0
        ) {
          errors[`${line.id}-quantity`] = [
            "Quantity must be a positive decimal (up to 4 places)",
          ];
        }
        if (
          !DECIMAL_AMOUNT.test(line.unitPrice.trim()) ||
          Number(line.unitPrice) < 0
        ) {
          errors[`${line.id}-unitPrice`] = [
            "Unit price must be a non-negative decimal",
          ];
        }

        // A discount is one mechanism plus its value — the same pairing the
        // server's `normaliseDiscount` insists on. Checking it here means the form
        // can point at the line that is wrong instead of the engine rejecting the
        // whole draft with a message about "lines".
        if (
          line.discountType === "PERCENT" &&
          (!DECIMAL_PERCENT.test(line.discountPercent.trim()) ||
            Number(line.discountPercent) <= 0)
        ) {
          errors[`${line.id}-discountPercent`] = [
            "A percentage discount must be greater than 0 and no more than 100",
          ];
        }
        if (
          line.discountType === "AMOUNT" &&
          (!DECIMAL_AMOUNT.test(line.discountAmount.trim()) ||
            Number(line.discountAmount) <= 0)
        ) {
          errors[`${line.id}-discountAmount`] = [
            "A fixed-amount discount must be greater than 0",
          ];
        }
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    // Defence in depth: the submit button is already disabled for a role with no
    // create permission, and the server authorizes again regardless.
    if (noTypeAllowed) {
      return;
    }

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        tenantId,
        type: docType,
        // Replays instead of duplicating if this submit is retried.
        idempotencyKey,
        contactId: contactId || null,
        currency,
        issueDate: toIsoDate(issueDate),
        dueDate: dueDate ? toIsoDate(dueDate) : null,
        expiryDate: expiryDate ? toIsoDate(expiryDate) : null,
        customerNote: customerNote || null,
        terms: terms || null,
        lines: lines.map((line) => ({
          // The real link, so the server re-prices the line from the catalogue row
          // and this customer's agreement instead of trusting this request. No item
          // means a free-text line, which the engine prices as written.
          itemId: line.itemId || null,
          description: line.description,
          itemCode: line.itemCode || null,
          unitOfMeasure: line.unitOfMeasure,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: line.discountType || null,
          // Only the chosen mechanism carries a value; the other is left at zero,
          // which is the pairing the server requires.
          discountPercent:
            line.discountType === "PERCENT" ? line.discountPercent || "0" : "0",
          discountAmount:
            line.discountType === "AMOUNT" ? line.discountAmount || "0" : "0",
          // A link, never a rate: the server copies the fraction and the label from
          // its own row, and for a catalogue line it uses the item's classification.
          taxRateId: line.taxRateId || null,
        })),
      };

      const result = await createDocumentDraftAction(payload);

      if (!result.success) {
        setServerError(result.error || "Failed to create document");
        if (result.fieldErrors) {
          setFieldErrors(result.fieldErrors);
        }
        return;
      }

      // `data` is optional on a successful result, so the id is read through
      // optional chaining: a create that came back without one is reported as
      // such instead of navigating to `/documents/undefined`.
      const createdId = result.data?.id;
      if (!createdId) {
        setServerError(
          "The draft was created but could not be opened. Refresh the documents list.",
        );
        return;
      }

      router.push(`/${locale}/app/documents/${createdId}`);
      router.refresh();
    } catch {
      setServerError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getContactLabel = (contact: ContactOption) => {
    if (contact.type === "BUSINESS") {
      return contact.companyName || "—";
    }
    return `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "—";
  };

  const canCreateType = (type: DocumentTypeValue) => {
    switch (type) {
      case "QUOTATION":
        return canCreateQuotation;
      case "ORDER":
        return canCreateOrder;
      case "INVOICE":
        return canCreateInvoice;
      case "DELIVERY_NOTE":
        return canCreateDeliveryNote;
    }
  };

  const filteredAllowedTypes = allowedTypes.filter(canCreateType);
  const noTypeAllowed = filteredAllowedTypes.length === 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>

      {serverError && (
        <div className="text-sm text-destructive" role="alert">
          {serverError}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Document Type</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {filteredAllowedTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setDocType(type)}
                aria-pressed={docType === type}
                className={cn(
                  "rounded-lg border p-4 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  docType === type
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50",
                )}
              >
                <FileText className="mb-2 h-5 w-5 text-muted-foreground" />
                <p className="font-medium">{documentTypeLabel(type)}</p>
                {docType === type && (
                  <p className="mt-1 text-xs text-muted-foreground">Selected</p>
                )}
              </button>
            ))}
          </div>
          {filteredAllowedTypes.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {TYPE_HINTS[docType]}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              This role cannot create any document type, so this form is closed.
              Ask for a create permission, or open an existing draft from the
              documents list.
            </p>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <Label htmlFor="contactId">Contact (optional)</Label>
            <Select
              id="contactId"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">— No contact —</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {getContactLabel(contact)}
                  {contact.email && ` (${contact.email})`}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="currency">Currency</Label>
            <Select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled
            >
              <option value="KES">KES — Kenyan Shilling</option>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Currency is fixed to KES for this phase.
            </p>
          </div>
        </div>
      </div>

      <Separator />

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <Label htmlFor="issueDate">Issue Date</Label>
          <Input
            id="issueDate"
            type="date"
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
            required
          />
          {fieldErrors.issueDate && (
            <p className="text-sm text-destructive">
              {fieldErrors.issueDate[0]}
            </p>
          )}
        </div>

        {(docType === "INVOICE" ||
          docType === "QUOTATION" ||
          docType === "ORDER") && (
          <div className="space-y-4">
            <Label htmlFor="dueDate">Due Date</Label>
            <Input
              id="dueDate"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            {docType === "ORDER" && (
              <p className="text-xs text-muted-foreground">
                Optional. For an order it is the day delivery or fulfilment is
                expected, not a payment deadline — payment is requested by the
                invoice raised from this order.
              </p>
            )}
          </div>
        )}

        {docType === "QUOTATION" && (
          <div className="space-y-4">
            <Label htmlFor="expiryDate">Expiry Date</Label>
            <Input
              id="expiryDate"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </div>
        )}
      </div>

      <Separator />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Line Items</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addLine}
            disabled={isSubmitting}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Line
          </Button>
        </div>

        {!canReadCatalogue && (
          <p className="text-sm text-muted-foreground">
            This role may write documents but may not read the catalogue, so
            every line is typed by hand and priced from what you enter.
          </p>
        )}

        {canReadCatalogue && (
          <p className="text-sm text-muted-foreground">
            A line chosen from the catalogue is priced by the server — from the
            item, or from this customer&apos;s agreed price while that agreement
            is in force. Its description, code, unit, price and tax are the
            catalogue&apos;s to decide, so they are not editable here.
            {agreementsState === "loading" && " Loading customer prices…"}
            {agreementsState === "error" &&
              " Customer prices could not be loaded, so standard prices are shown."}
            {agreementsTruncated &&
              " This customer has more agreements than the preview can hold; the server still applies the right one."}
          </p>
        )}

        <div className="space-y-3">
          {lines.map((line) => {
            const isCatalogueLine = Boolean(line.itemId);
            const agreedPrice =
              isCatalogueLine && line.priceSource === "customer";
            // Whether the price the line carries came from an agreement rather than
            // the standard catalogue row.
            const agreementDiscount =
              agreedPrice &&
              line.discountType === "PERCENT" &&
              !/^0+(?:\.0+)?$/.test(
                (agreements[line.itemId]?.discountPercent ?? "0").trim(),
              );
            const discountField =
              line.discountType === "AMOUNT"
                ? "discountAmount"
                : "discountPercent";

            return (
              <div
                key={line.id}
                className="space-y-3 p-4 border rounded-lg bg-card"
              >
                <div className="grid gap-3 sm:grid-cols-12">
                  <div className="space-y-1 sm:col-span-5">
                    <Label htmlFor={`item-${line.id}`}>Catalogue item</Label>
                    <Select
                      id={`item-${line.id}`}
                      value={line.itemId}
                      disabled={!canReadCatalogue || isSubmitting}
                      onChange={(e) => selectItem(line.id, e.target.value)}
                    >
                      <option value="">— Free-text line —</option>
                      {/* Only items priced in this document's currency: the engine
                          copies a price, it never converts one, so offering the rest
                          would be offering a line the server has to refuse. */}
                      {itemOptions
                        .filter((item) => item.currency === currency)
                        .map((item) => (
                          <option key={item.itemId} value={item.itemId}>
                            {item.name}
                            {item.sku ? ` · ${item.sku}` : ""}
                          </option>
                        ))}
                    </Select>
                  </div>

                  <div className="space-y-1 sm:col-span-5">
                    <Label htmlFor={`desc-${line.id}`}>Description *</Label>
                    <Input
                      id={`desc-${line.id}`}
                      value={line.description}
                      readOnly={isCatalogueLine}
                      onChange={(e) =>
                        updateLine(line.id, "description", e.target.value)
                      }
                      placeholder="Item description"
                      className={cn(
                        fieldErrors[`${line.id}-description`] &&
                          "border-destructive",
                        isCatalogueLine && "bg-muted/50",
                      )}
                    />
                    {fieldErrors[`${line.id}-description`]?.[0] && (
                      <p className="text-sm text-destructive">
                        {fieldErrors[`${line.id}-description`]?.[0]}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={`code-${line.id}`}>Code</Label>
                    <Input
                      id={`code-${line.id}`}
                      value={line.itemCode}
                      readOnly={isCatalogueLine}
                      onChange={(e) =>
                        updateLine(line.id, "itemCode", e.target.value)
                      }
                      placeholder="SKU"
                      maxLength={50}
                      className={isCatalogueLine ? "bg-muted/50" : undefined}
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-12">
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={`qty-${line.id}`}>Qty *</Label>
                    <Input
                      id={`qty-${line.id}`}
                      type="text"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) =>
                        updateLine(line.id, "quantity", e.target.value)
                      }
                      className={
                        fieldErrors[`${line.id}-quantity`]
                          ? "border-destructive"
                          : undefined
                      }
                    />
                    {fieldErrors[`${line.id}-quantity`]?.[0] && (
                      <p className="text-sm text-destructive">
                        {fieldErrors[`${line.id}-quantity`]?.[0]}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={`uom-${line.id}`}>Unit</Label>
                    <Input
                      id={`uom-${line.id}`}
                      value={line.unitOfMeasure}
                      readOnly={isCatalogueLine}
                      onChange={(e) =>
                        updateLine(line.id, "unitOfMeasure", e.target.value)
                      }
                      placeholder="each"
                      className={isCatalogueLine ? "bg-muted/50" : undefined}
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={`price-${line.id}`}>Unit Price *</Label>
                    <Input
                      id={`price-${line.id}`}
                      type="text"
                      inputMode="decimal"
                      value={line.unitPrice}
                      readOnly={isCatalogueLine}
                      onChange={(e) =>
                        updateLine(line.id, "unitPrice", e.target.value)
                      }
                      className={cn(
                        fieldErrors[`${line.id}-unitPrice`] &&
                          "border-destructive",
                        isCatalogueLine && "bg-muted/50",
                      )}
                    />
                    {fieldErrors[`${line.id}-unitPrice`]?.[0] && (
                      <p className="text-sm text-destructive">
                        {fieldErrors[`${line.id}-unitPrice`]?.[0]}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1 sm:col-span-3">
                    <Label htmlFor={`discount-${line.id}`}>Discount</Label>
                    <div className="flex gap-2">
                      <Select
                        id={`discount-${line.id}`}
                        value={line.discountType}
                        disabled={agreementDiscount}
                        onChange={(e) =>
                          updateLine(line.id, "discountType", e.target.value)
                        }
                      >
                        <option value="">None</option>
                        <option value="PERCENT">Percent %</option>
                        <option value="AMOUNT">Amount</option>
                      </Select>
                      {line.discountType && !agreementDiscount && (
                        <Input
                          aria-label={
                            line.discountType === "PERCENT"
                              ? "Discount percentage"
                              : "Discount amount"
                          }
                          className="w-24"
                          type="text"
                          inputMode="decimal"
                          value={line[discountField]}
                          onChange={(e) =>
                            updateLine(line.id, discountField, e.target.value)
                          }
                        />
                      )}
                    </div>
                    {agreementDiscount && (
                      <p className="text-xs text-muted-foreground">
                        This customer&apos;s agreed discount applies to the
                        line.
                      </p>
                    )}
                    {fieldErrors[`${line.id}-${discountField}`]?.[0] && (
                      <p className="text-sm text-destructive">
                        {fieldErrors[`${line.id}-${discountField}`]?.[0]}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={`tax-${line.id}`}>Tax</Label>
                    <Select
                      id={`tax-${line.id}`}
                      value={line.taxRateId}
                      // A catalogue line's classification is the item's, not the
                      // writer's: the server reads it back off the item either way.
                      disabled={
                        isCatalogueLine || !canReadCatalogue || isSubmitting
                      }
                      onChange={(e) =>
                        updateLine(line.id, "taxRateId", e.target.value)
                      }
                      className={isCatalogueLine ? "bg-muted/50" : undefined}
                    >
                      <option value="">No tax</option>
                      {taxRateOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                      {isCatalogueLine &&
                        line.taxRateId &&
                        !taxRateOptions.some(
                          (o) => o.id === line.taxRateId,
                        ) && (
                          <option value={line.taxRateId}>
                            The item&apos;s classification
                          </option>
                        )}
                    </Select>
                  </div>

                  <div className="flex items-end justify-end sm:col-span-1">
                    <X
                      className="h-5 w-5 mb-2 cursor-pointer hover:text-foreground"
                      onClick={() => removeLine(line.id)}
                      aria-label="Remove line"
                    />
                  </div>
                </div>

                {isCatalogueLine && (
                  <p className="text-xs text-muted-foreground">
                    {agreedPrice
                      ? "Agreed price for this customer."
                      : "Standard catalogue price."}{" "}
                    The server re-reads the catalogue and this customer&apos;s
                    agreement when the draft is written.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {lines.length === 1 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            Add at least one line item to continue.
          </p>
        )}
      </div>

      <Separator />

      <div className="space-y-4">
        <h2 className="text-lg font-medium">Notes & Terms</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="customerNote">Customer Note</Label>
            <Textarea
              id="customerNote"
              value={customerNote}
              onChange={(e) => setCustomerNote(e.target.value)}
              placeholder="Visible to the customer on the document"
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="terms">Terms & Conditions</Label>
            <Textarea
              id="terms"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Payment terms, delivery terms, etc."
              rows={3}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-4 pt-4 border-t">
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.back()}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting || noTypeAllowed}>
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Creating...
            </>
          ) : (
            `Create ${documentTypeLabel(docType).toLowerCase()} draft`
          )}
        </Button>
      </div>
    </form>
  );
}
