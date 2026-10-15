"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Prisma } from "@prisma/client";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
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
  createContactItemAction,
  updateContactItemAction,
  getContactItemAction,
  getAvailableItemsForContactAction,
} from "@/server/actions/contact-item";
import {
  CONTACT_ITEM_FORM_DEFAULT_VALUES,
  contactItemFormSchema,
  type ContactItemFormValues,
} from "@/lib/validations/contact-item";
import { formatMoney, formatPercent } from "@amisibiz/documents";

/**
 * Customer-specific catalogue assignment dialog.
 *
 * A customer price is written to the `ContactItem` row only; the default
 * catalogue (`Item.unitPrice`) is never touched, so agreeing a rate with one
 * customer cannot change the price any other customer is quoted (brief D).
 */
type CatalogueItem = Prisma.ItemGetPayload<{
  include: { taxRate: { include: { category: true } } };
}>;

interface ContactItemDialogProps {
  tenantId: string;
  contactId: string;
  contactItemId?: string | undefined;
  availableItems?: CatalogueItem[] | undefined;
  onSuccess: () => void;
}

/** A stored `Date` (or nothing) as the `YYYY-MM-DD` a date input expects. */
function toDateInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function ContactItemDialog({
  tenantId,
  contactId,
  contactItemId,
  availableItems: passedAvailableItems,
  onSuccess,
}: ContactItemDialogProps) {
  const router = useRouter();
  const isEditing = Boolean(contactItemId);
  const [isLoading, setIsLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [availableItems, setAvailableItems] = React.useState<CatalogueItem[]>(
    passedAvailableItems ?? [],
  );
  const [isLoadingItems, setIsLoadingItems] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    watch,
    formState: { errors },
  } = useForm<ContactItemFormValues>({
    resolver: zodResolver(contactItemFormSchema),
    // Shared frozen defaults; an edit load overwrites each field.
    defaultValues: CONTACT_ITEM_FORM_DEFAULT_VALUES,
  });

  const selectedItemId = watch("itemId");
  const selectedItem = availableItems.find(
    (item) => item.id === selectedItemId,
  );

  React.useEffect(() => {
    // While editing, the picker is disabled and only needs the assigned item,
    // which the load below seeds in. Fetching here would race with it.
    if (contactItemId) return;
    if (passedAvailableItems) {
      setAvailableItems(passedAvailableItems);
      return;
    }
    let active = true;
    setIsLoadingItems(true);

    const load = async () => {
      try {
        const result = await getAvailableItemsForContactAction(
          contactId,
          tenantId,
        );
        if (result.success && result.data && active) {
          setAvailableItems(result.data.items);
        }
      } finally {
        if (active) setIsLoadingItems(false);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [tenantId, contactId, contactItemId, passedAvailableItems]);

  React.useEffect(() => {
    const editingId = contactItemId;
    if (!editingId) return;
    let active = true;

    // Arrow function so the narrowing above survives inside the body.
    const load = async () => {
      const result = await getContactItemAction(editingId, tenantId);
      if (!result.success || !result.data?.contactItem || !active) return;

      const ci = result.data.contactItem;
      setValue("itemId", ci.itemId);
      setValue("customCode", ci.customCode ?? "");
      setValue("customName", ci.customName ?? "");
      setValue("customUnitOfMeasure", ci.customUnitOfMeasure ?? "");
      // Exact decimal text from `numeric`, no float round-trip.
      setValue("agreedPrice", ci.agreedPrice.toString());
      setValue("discountPercent", ci.discountPercent.toString());
      setValue("isAvailable", ci.isAvailable);
      setValue("validFrom", toDateInput(ci.validFrom));
      setValue("validUntil", toDateInput(ci.validUntil));
      // The picker excludes already-assigned items, so seed this one in —
      // otherwise the default-price comparison would have nothing to show.
      setAvailableItems((prev) =>
        prev.some((item) => item.id === ci.itemId) ? prev : [...prev, ci.item],
      );
    };

    void load();
    return () => {
      active = false;
    };
  }, [contactItemId, tenantId, setValue]);

  const onSubmit = async (data: ContactItemFormValues) => {
    setIsLoading(true);
    setServerError(null);

    try {
      const result = contactItemId
        ? // `itemId` is deliberately absent: the assignment identity is fixed.
          await updateContactItemAction({
            contactItemId,
            tenantId,
            customCode: data.customCode,
            customName: data.customName,
            customUnitOfMeasure: data.customUnitOfMeasure,
            agreedPrice: data.agreedPrice,
            discountPercent: data.discountPercent,
            isAvailable: data.isAvailable,
            validFrom: data.validFrom || null,
            validUntil: data.validUntil || null,
          })
        : await createContactItemAction({
            tenantId,
            contactId,
            itemId: data.itemId,
            customCode: data.customCode,
            customName: data.customName,
            customUnitOfMeasure: data.customUnitOfMeasure,
            agreedPrice: data.agreedPrice,
            discountPercent: data.discountPercent,
            isAvailable: data.isAvailable,
            validFrom: data.validFrom || null,
            validUntil: data.validUntil || null,
          });

      if (result.success) {
        onSuccess();
        router.refresh();
        return;
      }

      setServerError(result.error || "Failed to save customer item");
      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          const message = messages[0];
          if (!message) continue;
          setError(field as keyof ContactItemFormValues, { message });
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
          <DialogTitle>
            {isEditing
              ? "Edit Customer Item"
              : "Add Item to Customer Catalogue"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the customer-specific pricing and terms."
              : "Select an item from your catalogue and set customer-specific pricing."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 p-4">
          {serverError && (
            <div className="text-sm text-destructive" role="alert">
              {serverError}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="itemId">
              Item <span className="text-destructive">*</span>
            </Label>
            {isLoadingItems ? (
              <Select id="itemId" {...register("itemId")} disabled>
                <option value="">Loading...</option>
              </Select>
            ) : (
              <Select id="itemId" {...register("itemId")} disabled={isEditing}>
                <option value="">Select an item...</option>
                {availableItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.sku ? ` (${item.sku})` : ""} -{" "}
                    {formatMoney(item.unitPrice.toString(), item.currency)}
                  </option>
                ))}
              </Select>
            )}
            {errors.itemId && (
              <p className="text-xs text-destructive">
                {errors.itemId.message}
              </p>
            )}
            {isEditing && (
              <p className="text-xs text-muted-foreground">
                Item cannot be changed after creation.
              </p>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="customCode">Customer Code</Label>
              <Input
                id="customCode"
                {...register("customCode")}
                maxLength={50}
                placeholder="Customer-specific SKU"
              />
              {errors.customCode && (
                <p className="text-xs text-destructive">
                  {errors.customCode.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="customName">Customer Name</Label>
              <Input
                id="customName"
                {...register("customName")}
                maxLength={200}
                placeholder="Customer-specific description"
              />
              {errors.customName && (
                <p className="text-xs text-destructive">
                  {errors.customName.message}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="customUnitOfMeasure">Customer Unit</Label>
              <Input
                id="customUnitOfMeasure"
                {...register("customUnitOfMeasure")}
                maxLength={20}
                placeholder="e.g. carton"
              />
              {errors.customUnitOfMeasure && (
                <p className="text-xs text-destructive">
                  {errors.customUnitOfMeasure.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="validFrom">Valid From</Label>
              <Input id="validFrom" type="date" {...register("validFrom")} />
              {errors.validFrom && (
                <p className="text-xs text-destructive">
                  {errors.validFrom.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="validUntil">Valid Until</Label>
              <Input id="validUntil" type="date" {...register("validUntil")} />
              {errors.validUntil && (
                <p className="text-xs text-destructive">
                  {errors.validUntil.message}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="agreedPrice">
                Agreed Price <span className="text-destructive">*</span>
              </Label>
              {/* Text input: a `number` field would hand the price back as a JS
                  number, and prices must stay exact decimal strings. */}
              <Input
                id="agreedPrice"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                {...register("agreedPrice")}
                placeholder="0.00"
              />
              {errors.agreedPrice && (
                <p className="text-xs text-destructive">
                  {errors.agreedPrice.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discountPercent">Discount %</Label>
              <Input
                id="discountPercent"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                {...register("discountPercent")}
                placeholder="0"
              />
              {errors.discountPercent && (
                <p className="text-xs text-destructive">
                  {errors.discountPercent.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5 flex items-end">
              <Label
                htmlFor="isAvailable"
                className="flex items-center gap-2 mb-0"
              >
                <input
                  id="isAvailable"
                  type="checkbox"
                  {...register("isAvailable")}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <span>Available</span>
              </Label>
            </div>
          </div>

          {selectedItem && (
            <div className="p-4 bg-muted/50 rounded-lg border border-border space-y-2">
              <p className="text-sm font-medium">
                Default Catalogue Item Details
              </p>
              <div className="grid gap-2 md:grid-cols-3 text-sm text-muted-foreground">
                <div>
                  <span className="font-medium">Default Price: </span>
                  {formatMoney(
                    selectedItem.unitPrice.toString(),
                    selectedItem.currency,
                  )}
                </div>
                <div>
                  <span className="font-medium">Unit: </span>
                  {selectedItem.unitOfMeasure}
                </div>
                <div>
                  <span className="font-medium">Tax: </span>
                  {selectedItem.taxRate
                    ? `${formatPercent(selectedItem.taxRate.rate.toString())} (${selectedItem.taxRate.category?.name ?? "—"})`
                    : "No tax"}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Changing the agreed price here does not change the default
                catalogue price.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onSuccess()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || isLoadingItems}>
              {isLoading
                ? "Saving..."
                : isLoadingItems
                  ? "Loading..."
                  : isEditing
                    ? "Update"
                    : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
