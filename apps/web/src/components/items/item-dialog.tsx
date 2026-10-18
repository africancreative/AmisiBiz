"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Textarea } from "@amisibiz/ui/textarea";
import { Select } from "@amisibiz/ui/select";
import { Label } from "@amisibiz/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@amisibiz/ui/dialog";
import {
  createItemAction,
  updateItemAction,
  getItemAction,
  getTaxCategoriesAction,
} from "@/server/actions/item";
import {
  itemFormSchema,
  ITEM_FORM_DEFAULT_VALUES,
  UNIT_OF_MEASURE,
  UNIT_OF_MEASURE_LABELS,
  toUnitOfMeasure,
  type ItemFormValues,
} from "@/lib/validations/item";
import {
  CURRENCY_LABELS,
  SUPPORTED_CURRENCIES,
  toSupportedCurrency,
} from "@amisibiz/domain";
import { formatPercent } from "@amisibiz/documents";

/**
 * Item (product / service) dialog.
 *
 * Price is captured as a decimal string and stays one until the Server Action
 * converts it to `Prisma.Decimal`; the browser never performs the arithmetic.
 * Tax is an explicit link to one of this tenant's tax rates — an item with no
 * selection is untaxed rather than taxable at an assumed rate.
 */
interface ItemDialogProps {
  tenantId: string;
  itemId?: string | undefined;
  onSuccess: () => void;
}

export function ItemDialog({ tenantId, itemId, onSuccess }: ItemDialogProps) {
  const router = useRouter();
  const isEditing = Boolean(itemId);
  const [isLoading, setIsLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [taxCategories, setTaxCategories] = React.useState<
    {
      id: string;
      name: string;
      rates: { id: string; name: string; rate: string }[];
    }[]
  >([]);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors },
  } = useForm<ItemFormValues>({
    resolver: zodResolver(itemFormSchema),
    defaultValues: ITEM_FORM_DEFAULT_VALUES,
  });

  React.useEffect(() => {
    let active = true;

    async function loadTaxCategories() {
      const result = await getTaxCategoriesAction({
        tenantId,
        page: 1,
        pageSize: 100,
      });
      if (!result.success || !result.data?.categories || !active) return;

      setTaxCategories(
        result.data.categories.map((c) => ({
          id: c.id,
          name: c.name,
          rates: c.rates
            .filter((r) => r.isActive)
            // Decimal comes back as an object; keep its exact text form.
            .map((r) => ({ id: r.id, name: r.name, rate: r.rate.toString() })),
        })),
      );
    }

    loadTaxCategories();
    return () => {
      active = false;
    };
  }, [tenantId]);

  React.useEffect(() => {
    const editingId = itemId;
    if (!editingId) return;
    let active = true;

    // Arrow function (not a hoisted declaration) so the `editingId` narrowing
    // above still holds inside the body.
    const loadItem = async () => {
      const result = await getItemAction(editingId, tenantId);
      if (!result.success || !result.data?.item || !active) return;

      const item = result.data.item;
      setValue("type", item.type);
      // The dialog only edits the ACTIVE/INACTIVE switch; an ARCHIVED item is
      // shown with the form default and restored through the archive surface
      // (AGENT 02 Phase 3), never silently flipped by this dialog.
      if (item.status !== "ARCHIVED") setValue("status", item.status);
      setValue("name", item.name);
      setValue("sku", item.sku ?? "");
      setValue("description", item.description ?? "");
      setValue("unitOfMeasure", toUnitOfMeasure(item.unitOfMeasure));
      // Exact decimal text straight from `numeric` — no float round-trip.
      setValue("unitPrice", item.unitPrice.toString());
      setValue("currency", toSupportedCurrency(item.currency));
      setValue("taxRateId", item.taxRateId ?? "");
      setValue("notes", item.notes ?? "");
    };

    void loadItem();
    return () => {
      active = false;
    };
  }, [itemId, tenantId, setValue]);

  const onSubmit = async (data: ItemFormValues) => {
    setIsLoading(true);
    setServerError(null);

    try {
      const payload = {
        type: data.type,
        status: data.status,
        name: data.name,
        sku: data.sku,
        description: data.description,
        unitOfMeasure: data.unitOfMeasure,
        unitPrice: data.unitPrice,
        currency: data.currency,
        // "" means "clear the tax link"; the action disconnects the rate.
        taxRateId: data.taxRateId || null,
        notes: data.notes,
      };

      const result = isEditing
        ? await updateItemAction({ itemId, tenantId, ...payload })
        : await createItemAction({ tenantId, ...payload });

      if (result.success) {
        onSuccess();
        router.refresh();
        return;
      }

      setServerError(result.error || "Failed to save item");
      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          const message = messages[0];
          if (!message) continue;
          setError(field as keyof ItemFormValues, { message });
        }
      }
    } catch {
      setServerError("Something went wrong while saving. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={() => onSuccess()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Item" : "New Item"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the item details below."
              : "Add a new product or service to your catalogue."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 p-4">
          {serverError && (
            <div className="text-sm text-destructive" role="alert">
              {serverError}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="type">
                Type <span className="text-destructive">*</span>
              </Label>
              <Select id="type" {...register("type")}>
                <option value="PRODUCT">Product</option>
                <option value="SERVICE">Service</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="status">Status</Label>
              <Select id="status" {...register("status")}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              {...register("name")}
              maxLength={200}
              placeholder="e.g. Consulting Services"
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sku">SKU / Item Code</Label>
              <Input
                id="sku"
                {...register("sku")}
                maxLength={50}
                placeholder="e.g. CONSULT-001"
              />
              {errors.sku && (
                <p className="text-xs text-destructive">{errors.sku.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="unitOfMeasure">Unit of Measure</Label>
              <Select id="unitOfMeasure" {...register("unitOfMeasure")}>
                {UNIT_OF_MEASURE.map((unit) => (
                  <option key={unit} value={unit}>
                    {UNIT_OF_MEASURE_LABELS[unit]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="unitPrice">
                Unit Price <span className="text-destructive">*</span>
              </Label>
              {/*
                Plain text + decimal keypad: a `number` input hands back a JS
                number, and the price must stay an exact decimal string all the
                way to `Prisma.Decimal`.
              */}
              <Input
                id="unitPrice"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                {...register("unitPrice")}
                placeholder="0.00"
              />
              {errors.unitPrice && (
                <p className="text-xs text-destructive">
                  {errors.unitPrice.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Select id="currency" {...register("currency")}>
                {SUPPORTED_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {CURRENCY_LABELS[code]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="taxRateId">Tax Rate</Label>
              <Select id="taxRateId" {...register("taxRateId")}>
                <option value="">No Tax</option>
                {taxCategories.flatMap((cat) =>
                  cat.rates.map((rate) => (
                    <option key={rate.id} value={rate.id}>
                      {cat.name}: {rate.name} ({formatPercent(rate.rate)})
                    </option>
                  )),
                )}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              {...register("description")}
              maxLength={2000}
              rows={3}
              placeholder="Optional description for internal use"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              {...register("notes")}
              maxLength={1000}
              rows={2}
              placeholder="Internal notes"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onSuccess()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Saving..." : isEditing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
