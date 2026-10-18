"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Field } from "@amisibiz/ui/field";
import { Badge } from "@amisibiz/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@amisibiz/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@amisibiz/ui/dialog";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { Alert } from "@amisibiz/ui/alert";
import { EmptyState } from "@amisibiz/ui/state";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { formatMoney, formatPercent } from "@amisibiz/documents";
import {
  createVariantAction,
  deleteVariantAction,
  updateVariantAction,
} from "@/server/actions/item";
import { useTaxRateOptions } from "./use-tax-rate-options";
import type { ItemVariantRow } from "./types";

/**
 * Variant list for one item: add / edit / delete, every price stated with its
 * OWN explicit currency.
 *
 * Money rules kept exactly as the item dialog keeps them: a price is captured
 * as a decimal STRING (text input + decimal keypad, never `type="number"`), it
 * is sent to the Server Action as that string, and the browser performs no
 * arithmetic and shows no computed totals — there is nothing here to add up,
 * because a variant's price is a row the server owns.
 *
 * Permission gating mirrors the items list: create needs `ITEMS_CREATE`,
 * edits and archive verbs `ITEMS_UPDATE`, deletes `ITEMS_DELETE`, and a
 * read-only workspace (suspended tenant / support grant) gets no write control
 * at all.
 */

const MONEY_PATTERN = /^\d+(\.\d{1,4})?$/;
const VARIANT_NAME_MAX = 200;
const VARIANT_SKU_MAX = 64;

interface VariantForm {
  name: string;
  sku: string;
  unitPrice: string;
  currency: string;
  taxRateId: string;
  status: "ACTIVE" | "INACTIVE";
  position: string;
}

const EMPTY_VARIANT: VariantForm = {
  name: "",
  sku: "",
  unitPrice: "",
  currency: "KES",
  taxRateId: "",
  status: "ACTIVE",
  position: "0",
};

function toVariantForm(variant: ItemVariantRow): VariantForm {
  return {
    name: variant.name,
    sku: variant.sku ?? "",
    // Exact decimal text straight from `numeric` — no float round-trip.
    unitPrice: variant.unitPrice.toString(),
    currency: variant.currency,
    taxRateId: variant.taxRateId ?? "",
    status: variant.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    position: String(variant.position),
  };
}

/** Client-side mirror of the server schema; the action still has the last word. */
function validate(
  form: VariantForm,
): Partial<Record<keyof VariantForm, string>> {
  const errors: Partial<Record<keyof VariantForm, string>> = {};

  if (!form.name.trim()) errors.name = "Name is required.";
  if (form.name.trim().length > VARIANT_NAME_MAX) {
    errors.name = `Name must be ${VARIANT_NAME_MAX} characters or fewer.`;
  }
  if (form.sku.length > 0 && form.sku.trim().length === 0) {
    errors.sku = "SKU cannot be blank if you start filling it in.";
  }
  if (form.sku.trim().length > VARIANT_SKU_MAX) {
    errors.sku = `SKU must be ${VARIANT_SKU_MAX} characters or fewer.`;
  }
  if (!MONEY_PATTERN.test(form.unitPrice.trim())) {
    errors.unitPrice = "Enter a positive amount with up to 4 decimal places.";
  } else if (Number(form.unitPrice.trim()) >= 1e12) {
    errors.unitPrice = "Amount is too large.";
  }
  if (!/^[A-Za-z]{3}$/.test(form.currency.trim())) {
    errors.currency = "Currency must be an explicit 3-letter ISO 4217 code.";
  }
  const position = Number(form.position);
  if (!Number.isInteger(position)) {
    errors.position = "Position must be a whole number.";
  }

  return errors;
}

/* ------------------------------- dialog ---------------------------------- */

interface VariantDialogProps {
  tenantId: string;
  itemId: string;
  variant: ItemVariantRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}

function VariantDialog({
  tenantId,
  itemId,
  variant,
  onClose,
  onSaved,
}: VariantDialogProps) {
  const isEditing = Boolean(variant);
  const taxRates = useTaxRateOptions(tenantId);
  const [form, setForm] = React.useState<VariantForm>(
    variant ? toVariantForm(variant) : EMPTY_VARIANT,
  );
  const [errors, setErrors] = React.useState<
    Partial<Record<keyof VariantForm, string>>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const set = (key: keyof VariantForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setServerError(null);

    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setIsSubmitting(true);
    try {
      const fields = {
        name: form.name.trim(),
        sku: form.sku.trim(),
        unitPrice: form.unitPrice.trim(),
        currency: form.currency.trim().toUpperCase(),
        // "" clears the tax link; the action disconnects the rate.
        taxRateId: form.taxRateId ? form.taxRateId : null,
        status: form.status,
        position: Number(form.position),
      };

      const result = variant
        ? await updateVariantAction({
            tenantId,
            variantId: variant.id,
            ...fields,
          })
        : await createVariantAction({ tenantId, itemId, ...fields });

      if (result.success) {
        onSaved(isEditing ? "Variant updated." : "Variant created.");
        return;
      }

      setServerError(result.error || "Failed to save the variant.");
      const fieldErrors = result.fieldErrors;
      if (fieldErrors) {
        const mapped: Partial<Record<keyof VariantForm, string>> = {};
        for (const key of Object.keys(fields) as (keyof VariantForm)[]) {
          const message = fieldErrors[key]?.[0];
          if (message) mapped[key] = message;
        }
        setErrors(mapped);
      }
    } catch {
      setServerError("Something went wrong while saving the variant.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit variant" : "New variant"}
          </DialogTitle>
          <DialogDescription>
            A variant carries its own price and its own currency. Nothing is
            inherited from the item, and the price travels as an exact decimal.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {serverError ? (
            <div className="text-sm text-destructive" role="alert">
              {serverError}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Variant name" required error={errors.name}>
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                maxLength={VARIANT_NAME_MAX}
                placeholder="e.g. 500 ml bottle"
                disabled={isSubmitting}
              />
            </Field>
            <Field
              label="SKU"
              description="Optional; unique within your workspace."
              error={errors.sku}
            >
              <Input
                value={form.sku}
                onChange={(e) => set("sku", e.target.value)}
                maxLength={VARIANT_SKU_MAX}
                disabled={isSubmitting}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Unit price"
              required
              description="Decimal, up to 4 places (e.g. 1250.50). Never a currency-formatted number."
              error={errors.unitPrice}
            >
              <Input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={form.unitPrice}
                onChange={(e) => set("unitPrice", e.target.value)}
                placeholder="0.00"
                disabled={isSubmitting}
              />
            </Field>
            <Field
              label="Currency"
              required
              description="Explicit ISO 4217 code, e.g. KES, UGX, TZS, USD."
              error={errors.currency}
            >
              <Input
                value={form.currency}
                onChange={(e) => set("currency", e.target.value)}
                maxLength={3}
                spellCheck={false}
                className="uppercase font-mono"
                disabled={isSubmitting}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Tax rate"
              description="No selection means untaxed — never an assumed rate."
              error={errors.taxRateId}
            >
              <Select
                value={form.taxRateId}
                onChange={(e) => set("taxRateId", e.target.value)}
                disabled={isSubmitting || taxRates.isLoading}
              >
                <option value="">
                  {taxRates.isLoading ? "Loading tax rates…" : "No tax"}
                </option>
                {taxRates.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={form.status}
                onChange={(e) =>
                  set(
                    "status",
                    e.target.value === "INACTIVE" ? "INACTIVE" : "ACTIVE",
                  )
                }
                disabled={isSubmitting}
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Display order"
            description="Whole number; variants are listed from the lowest."
            error={errors.position}
          >
            <Input
              type="text"
              inputMode="numeric"
              value={form.position}
              onChange={(e) => set("position", e.target.value)}
              className="w-32"
              disabled={isSubmitting}
            />
          </Field>

          {taxRates.error ? (
            <Alert tone="warning" title="Tax rates unavailable">
              {taxRates.error} You can still save the variant without a tax
              rate.
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {isSubmitting
                ? "Saving…"
                : isEditing
                  ? "Save variant"
                  : "Create variant"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- panel ----------------------------------- */

export interface ItemVariantsPanelProps {
  tenantId: string;
  itemId: string;
  variants: ItemVariantRow[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onChanged: () => void;
}

export function ItemVariantsPanel({
  tenantId,
  itemId,
  variants,
  canCreate,
  canUpdate,
  canDelete,
  onChanged,
}: ItemVariantsPanelProps) {
  const canWrite = canCreate || canUpdate || canDelete;
  const [editing, setEditing] = React.useState<ItemVariantRow | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ItemVariantRow | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);

  const confirmDelete = async () => {
    if (!deleting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await deleteVariantAction({
        tenantId,
        variantId: deleting.id,
      });
      if (result.success) {
        setFlash("Variant deleted.");
        setDeleting(null);
        onChanged();
      } else {
        // A variant already snapshotted into a document line refuses here;
        // the action's own message says what to do instead.
        setError(result.error || "Failed to delete the variant.");
      }
    } catch {
      setError("Something went wrong while deleting the variant.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="variants-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="variants-heading" className="text-sm font-semibold">
          Variants
        </h3>
        {canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add variant
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {flash ? (
        <p className="text-sm text-success-foreground" role="status">
          {flash}
        </p>
      ) : null}

      {variants.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No variants"
          description="This item has no price variants. Customers and documents can still use the item's own unit price; add a variant only when the same product is sold in different shapes or prices."
        />
      ) : (
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Order</TableHead>
                {canWrite ? (
                  <TableHead className="text-right">Actions</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((variant) => (
                <TableRow key={variant.id}>
                  <TableCell className="font-medium">{variant.name}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {variant.sku || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {/* Currency is the variant row's own, always printed. */}
                    {formatMoney(
                      variant.unitPrice.toString(),
                      variant.currency,
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {variant.taxRate ? (
                      <>
                        <span className="font-mono">
                          {formatPercent(variant.taxRate.rate.toString())}
                        </span>
                        {variant.taxRate.category ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({variant.taxRate.category.name})
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      tone={variant.status === "ACTIVE" ? "success" : "neutral"}
                    >
                      {variant.status === "ACTIVE" ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {variant.position}
                  </TableCell>
                  {canWrite ? (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {canUpdate ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit variant ${variant.name}`}
                            onClick={() => setEditing(variant)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canDelete ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete variant ${variant.name}`}
                            onClick={() => {
                              setError(null);
                              setDeleting(variant);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {creating ? (
        <VariantDialog
          tenantId={tenantId}
          itemId={itemId}
          variant={null}
          onClose={() => setCreating(false)}
          onSaved={(message) => {
            setCreating(false);
            setFlash(message);
            onChanged();
          }}
        />
      ) : null}

      {editing ? (
        <VariantDialog
          tenantId={tenantId}
          itemId={itemId}
          variant={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setFlash(message);
            onChanged();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Delete variant"
          description={`Delete “${deleting.name}”? A variant already used by a document line cannot be deleted — set it INACTIVE instead, which keeps historical documents intact.`}
          confirmLabel="Delete"
          variant="danger"
          isLoading={isSubmitting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}
