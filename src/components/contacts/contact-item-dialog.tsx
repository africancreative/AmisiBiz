"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  createContactItemAction,
  updateContactItemAction,
  getContactItemAction,
  getAvailableItemsForContactAction,
} from "@/server/actions/contact-item";
import type { Item } from "@prisma/client";

const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "Must be a valid decimal number with up to 4 decimal places");

const discountPercentSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Must be a valid percentage with up to 2 decimal places")
  .refine((v) => parseFloat(v) >= 0 && parseFloat(v) <= 100, "Discount must be between 0 and 100");

const contactItemSchema = z.object({
  itemId: z.string().cuid("Please select an item"),
  customCode: z.string().max(50).optional().or(z.literal("")),
  customName: z.string().max(200).optional().or(z.literal("")),
  agreedPrice: decimalStringSchema.refine((v) => parseFloat(v) >= 0, "Price must be non-negative"),
  discountPercent: discountPercentSchema.default("0"),
  isAvailable: z.boolean().default(true),
});

type ContactItemFormData = z.infer<typeof contactItemSchema>;

const DEFAULT_VALUES: ContactItemFormData = {
  itemId: "",
  customCode: "",
  customName: "",
  agreedPrice: "0.00",
  discountPercent: "0",
  isAvailable: true,
};

interface ContactItemDialogProps {
  tenantId: string;
  contactId: string;
  contactItemId?: string;
  availableItems?: Item[];
  onSuccess: () => void;
}

export function ContactItemDialog({ tenantId, contactId, contactItemId, availableItems: passedAvailableItems, onSuccess }: ContactItemDialogProps) {
  const router = useRouter();
  const isEditing = !!contactItemId;
  const [isLoading, setIsLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [availableItems, setAvailableItems] = React.useState<Item[]>(passedAvailableItems || []);
  const [isLoadingItems, setIsLoadingItems] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ContactItemFormData>({
    resolver: zodResolver(contactItemSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const selectedItemId = watch("itemId");
  const selectedItem = availableItems.find((item) => item.id === selectedItemId);

  React.useEffect(() => {
    if (!isEditing && passedAvailableItems) {
      setAvailableItems(passedAvailableItems);
    } else {
      async function loadAvailableItems() {
        setIsLoadingItems(true);
        try {
          const result = await getAvailableItemsForContactAction(contactId, tenantId);
          if (result.success && result.data) {
            setAvailableItems(result.data.items);
          }
        } catch (err) {
          console.error("Failed to load available items", err);
        } finally {
          setIsLoadingItems(false);
        }
      }
      loadAvailableItems();
    }
  }, [tenantId, contactId, isEditing, passedAvailableItems]);

  React.useEffect(() => {
    if (contactItemId) {
      async function loadContactItem() {
        const result = await getContactItemAction(contactItemId, tenantId);
        if (result.success && result.data.contactItem) {
          const ci = result.data.contactItem;
          setValue("itemId", ci.itemId);
          setValue("customCode", ci.customCode || "");
          setValue("customName", ci.customName || "");
          setValue("agreedPrice", ci.agreedPrice.toString());
          setValue("discountPercent", ci.discountPercent.toString());
          setValue("isAvailable", ci.isAvailable);
        }
      }
      loadContactItem();
    } else if (selectedItem && !isEditing) {
      // Pre-fill agreed price with item's default price when item is selected
      setValue("agreedPrice", selectedItem.unitPrice.toString());
    }
  }, [contactItemId, tenantId, setValue, selectedItem, isEditing]);

  const onSubmit = async (data: ContactItemFormData) => {
    setIsLoading(true);
    setServerError(null);

    try {
      let result;
      if (isEditing) {
        result = await updateContactItemAction({
          contactItemId,
          tenantId,
          ...data,
        });
      } else {
        result = await createContactItemAction({
          tenantId,
          contactId,
          ...data,
        });
      }

      if (result.success) {
        onSuccess();
        router.refresh();
      } else {
        setServerError(result.error || "Failed to save customer item");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  if (!isEditing && contactItemId) return null;

  return (
    <Dialog open={true} onOpenChange={() => onSuccess()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Customer Item" : "Add Item to Customer Catalogue"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the customer-specific pricing and terms."
              : "Select an item from your catalogue and set customer-specific pricing."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 p-4">
          {serverError && (
            <div className="text-sm text-destructive" role="alert">{serverError}</div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="itemId">Item <span className="text-destructive">*</span></Label>
            {isLoadingItems ? (
              <Select id="itemId" {...register("itemId")} disabled>
                <option value="">Loading...</option>
              </Select>
            ) : (
              <Select id="itemId" {...register("itemId")} disabled={isEditing}>
                <option value="">Select an item...</option>
                {availableItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} {item.sku && `(${item.sku})`} - {new Intl.NumberFormat("en-KE", { style: "currency", currency: item.currency, minimumFractionDigits: 2 }).format(Number(item.unitPrice.toString()))}
                  </option>
                ))}
              </Select>
            )}
            {errors.itemId && <p className="text-xs text-destructive">{errors.itemId.message}</p>}
            {isEditing && <p className="text-xs text-muted-foreground">Item cannot be changed after creation.</p>}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="customCode">Customer Code</Label>
              <Input id="customCode" {...register("customCode")} maxLength={50} placeholder="Customer-specific SKU" />
              {errors.customCode && <p className="text-xs text-destructive">{errors.customCode.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="customName">Customer Name</Label>
              <Input id="customName" {...register("customName")} maxLength={200} placeholder="Customer-specific description" />
              {errors.customName && <p className="text-xs text-destructive">{errors.customName.message}</p>}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="agreedPrice">Agreed Price <span className="text-destructive">*</span></Label>
              <Input
                id="agreedPrice"
                type="number"
                step="0.01"
                min="0"
                {...register("agreedPrice")}
                placeholder="0.00"
              />
              {errors.agreedPrice && <p className="text-xs text-destructive">{errors.agreedPrice.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discountPercent">Discount %</Label>
              <Input
                id="discountPercent"
                type="number"
                step="0.01"
                min="0"
                max="100"
                {...register("discountPercent")}
                placeholder="0"
              />
              {errors.discountPercent && <p className="text-xs text-destructive">{errors.discountPercent.message}</p>}
            </div>
            <div className="space-y-1.5 flex items-end">
              <Label htmlFor="isAvailable" className="flex items-center gap-2 mb-0">
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
              <p className="text-sm font-medium">Default Catalogue Item Details</p>
              <div className="grid gap-2 md:grid-cols-3 text-sm text-muted-foreground">
                <div>
                  <span className="font-medium">Default Price: </span>
                  {new Intl.NumberFormat("en-KE", { style: "currency", currency: selectedItem.currency, minimumFractionDigits: 2 }).format(Number(selectedItem.unitPrice.toString()))}
                </div>
                <div>
                  <span className="font-medium">Unit: </span>
                  {selectedItem.unitOfMeasure}
                </div>
                <div>
                  <span className="font-medium">Tax: </span>
                  {selectedItem.taxRate
                    ? `${(Number(selectedItem.taxRate.rate.toString()) * 100).toFixed(2)}% (${selectedItem.taxRate.category?.name || "—"})`
                    : "No tax"}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onSuccess()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || isLoadingItems}>
              {isLoading ? "Saving..." : isLoadingItems ? "Loading..." : isEditing ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Need to add a getContactItemAction - let's add a placeholder export
// This will be imported from the server actions