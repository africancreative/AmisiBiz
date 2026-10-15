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
import { Plus, X, FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContactOption {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  type: "INDIVIDUAL" | "BUSINESS";
}

interface NewDocumentClientProps {
  locale: string;
  tenantId: string;
  contacts: ContactOption[];
  initialType: "QUOTATION" | "INVOICE" | "DELIVERY_NOTE" | "";
  allowedTypes: ("QUOTATION" | "INVOICE" | "DELIVERY_NOTE")[];
  canCreateQuotation: boolean;
  canCreateInvoice: boolean;
  canCreateDeliveryNote: boolean;
  title: string;
  description: string;
}

interface LineInput {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  unitOfMeasure: string;
  discountType: "PERCENT" | "AMOUNT" | "";
  discountPercent: string;
  discountAmount: string;
  taxRateId: string;
}

const DEFAULT_LINE: Omit<LineInput, "id"> = {
  description: "",
  quantity: "1",
  unitPrice: "0",
  unitOfMeasure: "each",
  discountType: "",
  discountPercent: "0",
  discountAmount: "0",
  taxRateId: "",
};

/** Mirrors `decimalStringSchema(4)` for the two fields a line is priced from. */
const DECIMAL_QUANTITY = /^\d+(?:\.\d{1,4})?$/;
const DECIMAL_AMOUNT = /^\d+(?:\.\d{1,4})?$/;

function typeLabel(type: string): string {
  switch (type) {
    case "QUOTATION":
      return "Quotation";
    case "INVOICE":
      return "Invoice";
    case "DELIVERY_NOTE":
      return "Delivery Note";
    default:
      return type;
  }
}

export function NewDocumentClient({
  locale,
  tenantId,
  contacts,
  initialType,
  allowedTypes,
  canCreateQuotation,
  canCreateInvoice,
  canCreateDeliveryNote,
  title,
  description,
}: NewDocumentClientProps) {
  const router = useRouter();

  const [docType, setDocType] = React.useState<
    "QUOTATION" | "INVOICE" | "DELIVERY_NOTE"
  >(
    initialType ||
      (allowedTypes[0] as "QUOTATION" | "INVOICE" | "DELIVERY_NOTE") ||
      "QUOTATION",
  );
  const [contactId, setContactId] = React.useState<string>("");
  const [currency, setCurrency] = React.useState("KES");
  const [issueDate, setIssueDate] = React.useState(
    new Date().toISOString().split("T")[0],
  );
  const [dueDate, setDueDate] = React.useState("");
  const [expiryDate, setExpiryDate] = React.useState("");
  const [customerNote, setCustomerNote] = React.useState("");
  const [terms, setTerms] = React.useState("");

  const [lines, setLines] = React.useState<LineInput[]>([
    { id: crypto.randomUUID(), ...DEFAULT_LINE },
  ]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<
    Record<string, string[]>
  >({});

  const addLine = () => {
    setLines([...lines, { id: crypto.randomUUID(), ...DEFAULT_LINE }]);
  };

  const removeLine = (id: string) => {
    if (lines.length <= 1) return;
    setLines(lines.filter((line) => line.id !== id));
  };

  /**
   * Field errors are keyed by LINE ID (`<id>-description`), not by row index: an
   * index shifts the moment a line above it is removed, which would leave the
   * message pinned to the wrong row. `setLines` keeps ids stable, so the error
   * follows the line it belongs to.
   */
  const updateLine = (id: string, field: keyof LineInput, value: string) => {
    setLines(
      lines.map((line) =>
        line.id === id ? { ...line, [field]: value } : line,
      ),
    );
    const key = `${id}-${field}`;
    const existing = fieldErrors[key];
    if (existing?.includes(field)) {
      setFieldErrors({
        ...fieldErrors,
        [key]: existing.filter((entry) => entry !== field),
      });
    }
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
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        tenantId,
        type: docType,
        contactId: contactId || null,
        currency,
        issueDate: new Date(issueDate + "T00:00:00").toISOString(),
        dueDate: dueDate ? new Date(dueDate + "T00:00:00").toISOString() : null,
        expiryDate: expiryDate
          ? new Date(expiryDate + "T00:00:00").toISOString()
          : null,
        customerNote: customerNote || null,
        terms: terms || null,
        lines: lines.map((line) => ({
          itemId: null,
          description: line.description,
          itemCode: null,
          unitOfMeasure: line.unitOfMeasure,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: line.discountType || null,
          discountPercent: line.discountPercent || "0",
          discountAmount: line.discountAmount || "0",
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

  const canCreateType = (type: "QUOTATION" | "INVOICE" | "DELIVERY_NOTE") => {
    switch (type) {
      case "QUOTATION":
        return canCreateQuotation;
      case "INVOICE":
        return canCreateInvoice;
      case "DELIVERY_NOTE":
        return canCreateDeliveryNote;
    }
  };

  const filteredAllowedTypes = allowedTypes.filter(canCreateType);

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
          <div className="grid gap-2 sm:grid-cols-3">
            {filteredAllowedTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setDocType(type)}
                className={cn(
                  "p-4 border rounded-lg text-left transition-colors",
                  docType === type
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50",
                )}
              >
                <FileText className="h-5 w-5 mb-2 text-muted-foreground" />
                <p className="font-medium">{typeLabel(type)}</p>
              </button>
            ))}
          </div>
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

        {(docType === "INVOICE" || docType === "QUOTATION") && (
          <div className="space-y-4">
            <Label htmlFor="dueDate">Due Date</Label>
            <Input
              id="dueDate"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
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

        <div className="space-y-3">
          {lines.map((line) => (
            <div
              key={line.id}
              className="grid gap-3 p-4 border rounded-lg bg-card"
              style={{
                gridTemplateColumns:
                  "minmax(0, 2fr) repeat(4, minmax(0, 1fr)) auto",
              }}
            >
              <div className="space-y-1">
                <Label htmlFor={`desc-${line.id}`}>Description *</Label>
                <Input
                  id={`desc-${line.id}`}
                  value={line.description}
                  onChange={(e) =>
                    updateLine(line.id, "description", e.target.value)
                  }
                  placeholder="Item description"
                  className={
                    fieldErrors[`${line.id}-description`]
                      ? "border-destructive"
                      : undefined
                  }
                />
                {fieldErrors[`${line.id}-description`]?.[0] && (
                  <p className="text-sm text-destructive">
                    {fieldErrors[`${line.id}-description`]?.[0]}
                  </p>
                )}
              </div>

              <div className="space-y-1">
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

              <div className="space-y-1">
                <Label htmlFor={`uom-${line.id}`}>Unit</Label>
                <Input
                  id={`uom-${line.id}`}
                  value={line.unitOfMeasure}
                  onChange={(e) =>
                    updateLine(line.id, "unitOfMeasure", e.target.value)
                  }
                  placeholder="each"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor={`price-${line.id}`}>Unit Price *</Label>
                <Input
                  id={`price-${line.id}`}
                  type="text"
                  inputMode="decimal"
                  value={line.unitPrice}
                  onChange={(e) =>
                    updateLine(line.id, "unitPrice", e.target.value)
                  }
                  className={
                    fieldErrors[`${line.id}-unitPrice`]
                      ? "border-destructive"
                      : undefined
                  }
                />
                {fieldErrors[`${line.id}-unitPrice`]?.[0] && (
                  <p className="text-sm text-destructive">
                    {fieldErrors[`${line.id}-unitPrice`]?.[0]}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor={`discount-${line.id}`}>Discount</Label>
                <Select
                  id={`discount-${line.id}`}
                  value={line.discountType}
                  onChange={(e) =>
                    updateLine(line.id, "discountType", e.target.value)
                  }
                >
                  <option value="">None</option>
                  <option value="PERCENT">Percent %</option>
                  <option value="AMOUNT">Amount</option>
                </Select>
              </div>

              <div className="flex items-center justify-center text-muted-foreground">
                <X
                  className="h-5 w-5 cursor-pointer hover:text-foreground"
                  onClick={() => removeLine(line.id)}
                  aria-label="Remove line"
                />
              </div>
            </div>
          ))}
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
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Creating...
            </>
          ) : (
            "Create Draft"
          )}
        </Button>
      </div>
    </form>
  );
}
