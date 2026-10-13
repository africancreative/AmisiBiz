"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { createItemAction, updateItemAction, getItemAction, getTaxCategoriesAction } from "@/server/actions/item";

const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "Must be a valid decimal number with up to 4 decimal places");

const unitOfMeasureSchema = z.enum([
  "each",
  "hour",
  "day",
  "week",
  "month",
  "year",
  "kg",
  "g",
  "l",
  "ml",
  "m",
  "cm",
  "mm",
  "sqm",
  "cum",
  "box",
  "pack",
  "roll",
  "bundle",
]);

const itemSchema = z.object({
  type: z.enum(["PRODUCT", "SERVICE"]).default("PRODUCT"),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  name: z.string().min(1, "Name is required").max(200),
  sku: z.string().max(50).optional().or(z.literal("")),
  description: z.string().max(2000).optional().or(z.literal("")),
  unitOfMeasure: unitOfMeasureSchema.default("each"),
  unitPrice: decimalStringSchema.refine((v) => parseFloat(v) >= 0, "Price must be non-negative"),
  currency: z.string().length(3, "Currency must be a 3-letter ISO code").default("KES"),
  taxRateId: z.string().cuid("Invalid tax rate ID").optional(),
  notes: z.string().max(1000).optional().or(z.literal("")),
}).refine(
  (data) => data.sku === undefined || data.sku.trim() !== "",
  {
    message: "SKU cannot be empty if provided",
    path: ["sku"],
  }
);

type ItemFormData = z.infer<typeof itemSchema>;

const DEFAULT_VALUES: ItemFormData = {
  type: "PRODUCT",
  status: "ACTIVE",
  name: "",
  sku: "",
  description: "",
  unitOfMeasure: "each",
  unitPrice: "0.00",
  currency: "KES",
  taxRateId: undefined,
  notes: "",
};

interface ItemDialogProps {
  tenantId: string;
  itemId?: string;
  onSuccess: () => void;
}

export function ItemDialog({ tenantId, itemId, onSuccess }: ItemDialogProps) {
  const router = useRouter();
  const isEditing = !!itemId;
  const [isLoading, setIsLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [taxCategories, setTaxCategories] = React.useState<{
    id: string;
    name: string;
    rates: { id: string; name: string; rate: { toString: () => string } }[];
  }[]>([]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ItemFormData>({
    resolver: zodResolver(itemSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const type = watch("type");

  React.useEffect(() => {
    async function loadTaxCategories() {
      const result = await getTaxCategoriesAction({ tenantId, page: 1, pageSize: 100 });
      if (result.success && result.data) {
        setTaxCategories(
          result.data.categories.map((c) => ({
            id: c.id,
            name: c.name,
            rates: c.rates
              .filter((r) => r.isActive)
              .map((r) => ({
                id: r.id,
                name: r.name,
                rate: r.rate,
              })),
          }))
        );
      }
    }
    loadTaxCategories();
  }, [tenantId]);

  React.useEffect(() => {
    if (itemId) {
      async function loadItem() {
        const result = await getItemAction(itemId, tenantId);
        if (result.success && result.data.item) {
          const item = result.data.item;
          setValue("type", item.type);
          setValue("status", item.status);
          setValue("name", item.name);
          setValue("sku", item.sku || "");
          setValue("description", item.description || "");
          setValue("unitOfMeasure", item.unitOfMeasure);
          setValue("unitPrice", item.unitPrice.toString());
          setValue("currency", item.currency);
          setValue("taxRateId", item.taxRateId || undefined);
          setValue("notes", item.notes || "");
        }
      }
      loadItem();
    }
  }, [itemId, tenantId, setValue]);

  const onSubmit = async (data: ItemFormData) => {
    setIsLoading(true);
    setServerError(null);

    try {
      const payload = {
        ...data,
        unitPrice: data.unitPrice,
      };

      let result;
      if (isEditing) {
        result = await updateItemAction({
          itemId,
          tenantId,
          ...payload,
        });
      } else {
        result = await createItemAction({
          tenantId,
          ...payload,
        });
      }

      if (result.success) {
        onSuccess();
        router.refresh();
      } else {
        setServerError(result.error || "Failed to save item");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  if (!isEditing && itemId) return null;

  return (
    <Dialog open={true} onOpenChange={() => onSuccess()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Item" : "New Item"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Update the item details below." : "Add a new product or service to your catalogue."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 p-4">
          {serverError && (
            <div className="text-sm text-destructive" role="alert">{serverError}</div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="type">Type <span className="text-destructive">*</span></Label>
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
            <Label htmlFor="name">Name <span className="text-destructive">*</span></Label>
            <Input id="name" {...register("name")} maxLength={200} placeholder="e.g. Consulting Services" />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sku">SKU / Item Code</Label>
              <Input id="sku" {...register("sku")} maxLength={50} placeholder="e.g. CONSULT-001" />
              {errors.sku && <p className="text-xs text-destructive">{errors.sku.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="unitOfMeasure">Unit of Measure</Label>
              <Select id="unitOfMeasure" {...register("unitOfMeasure")}>
                <option value="each">Each</option>
                <option value="hour">Hour</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
                <option value="kg">Kilogram (kg)</option>
                <option value="g">Gram (g)</option>
                <option value="l">Liter (l)</option>
                <option value="ml">Milliliter (ml)</option>
                <option value="m">Meter (m)</option>
                <option value="cm">Centimeter (cm)</option>
                <option value="mm">Millimeter (mm)</option>
                <option value="sqm">Square Meter (sqm)</option>
                <option value="cum">Cubic Meter (cum)</option>
                <option value="box">Box</option>
                <option value="pack">Pack</option>
                <option value="roll">Roll</option>
                <option value="bundle">Bundle</option>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="unitPrice">Unit Price <span className="text-destructive">*</span></Label>
              <Input
                id="unitPrice"
                type="number"
                step="0.01"
                min="0"
                {...register("unitPrice")}
                placeholder="0.00"
              />
              {errors.unitPrice && <p className="text-xs text-destructive">{errors.unitPrice.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Select id="currency" {...register("currency")}>
                <option value="KES">KES - Kenyan Shilling</option>
                <option value="USD">USD - US Dollar</option>
                <option value="EUR">EUR - Euro</option>
                <option value="GBP">GBP - British Pound</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="taxRateId">Tax Rate</Label>
              <Select id="taxRateId" {...register("taxRateId")}>
                <option value="">No Tax</option>
                {taxCategories.flatMap((cat) =>
                  cat.rates.map((rate) => (
                    <option key={rate.id} value={rate.id}>
                      {cat.name}: {rate.name} ({(Number(rate.rate.toString()) * 100).toFixed(2)}%)
                    </option>
                  ))
                )}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" {...register("description")} maxLength={2000} rows={3} placeholder="Optional description for internal use" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" {...register("notes")} maxLength={1000} rows={2} placeholder="Internal notes" />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onSuccess()}>
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