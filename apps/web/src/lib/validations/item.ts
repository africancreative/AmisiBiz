import { z } from "zod";
import {
  SUPPORTED_CURRENCIES,
  currencySchema,
  moneySchema,
  taxRateFractionSchema,
} from "@amisibiz/domain";

export const itemTypeSchema = z.enum(["PRODUCT", "SERVICE"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

export const itemStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

/**
 * Units of measure are a closed list rather than free text: a controlled value
 * keeps documents consistent and avoids per-tenant spelling drift on the
 * quantities that feed priced lines.
 */
export const UNIT_OF_MEASURE = [
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
] as const;

export const unitOfMeasureSchema = z.enum(UNIT_OF_MEASURE);
export type UnitOfMeasure = z.infer<typeof unitOfMeasureSchema>;

/**
 * Labels for the controlled unit list. A `Record` over the union means adding a
 * unit without a label is a compile error rather than a blank option.
 */
export const UNIT_OF_MEASURE_LABELS: Record<UnitOfMeasure, string> = {
  each: "Each",
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  kg: "Kilogram (kg)",
  g: "Gram (g)",
  l: "Liter (l)",
  ml: "Milliliter (ml)",
  m: "Meter (m)",
  cm: "Centimeter (cm)",
  mm: "Millimeter (mm)",
  sqm: "Square Meter (sqm)",
  cum: "Cubic Meter (cum)",
  box: "Box",
  pack: "Pack",
  roll: "Roll",
  bundle: "Bundle",
};

/** A rate row inside a tax category (0–1 fraction, e.g. 0.16 for 16%). */
const taxRateSchema = z.object({
  id: z.string().uuid().optional(),
  categoryId: z.string().uuid("Invalid tax category"),
  name: z.string().min(1).max(100).trim(),
  rate: taxRateFractionSchema,
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
  isActive: z.boolean().default(true),
});

export const createTaxCategorySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  name: z.string().min(1, "Name is required").max(100).trim(),
  description: z.string().max(500).optional().or(z.literal("")),
  isDefault: z.boolean().default(false),
  rates: z.array(taxRateSchema).min(1, "At least one tax rate is required"),
});

/**
 * `tenantId` stays required: it is re-authorized on every call and is never
 * taken from the row being edited.
 */
export const updateTaxCategorySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  categoryId: z.string().uuid("Invalid tax category ID"),
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).optional().or(z.literal("")),
  isDefault: z.boolean().optional(),
});

export const taxCategoryLocatorSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  categoryId: z.string().uuid("Invalid tax category ID"),
});

export const taxCategoryQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

/**
 * Catalogue item fields, declared once and reused. `taxRateId` is the explicit
 * tax link: nothing is taxable by implicit default, an item with no tax rate is
 * treated as untaxed by the document engine.
 */
const itemFields = {
  type: itemTypeSchema.default("PRODUCT"),
  status: itemStatusSchema.default("ACTIVE"),
  name: z.string().min(1, "Name is required").max(200).trim(),
  sku: z.string().max(50).optional().or(z.literal("")),
  description: z.string().max(2000).optional().or(z.literal("")),
  unitOfMeasure: unitOfMeasureSchema.default("each"),
  unitPrice: moneySchema,
  currency: currencySchema.default("KES"),
  /**
   * `null` clears the tax link on an update; `undefined` leaves it untouched.
   * Nothing is taxable by implicit default.
   */
  taxRateId: z.string().uuid("Invalid tax rate ID").nullish(),
  notes: z.string().max(1000).optional().or(z.literal("")),
};

/**
 * A SKU that was clearly meant to carry text but contains only whitespace is a
 * typo, not an omission — an empty string legitimately means "no SKU".
 */
function rejectBlankSku(
  data: { sku?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (
    typeof data.sku === "string" &&
    data.sku.length > 0 &&
    data.sku.trim() === ""
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "SKU cannot be empty if provided",
      path: ["sku"],
    });
  }
}

export const createItemSchema = z
  .object({ tenantId: z.string().uuid("Invalid tenant ID"), ...itemFields })
  .superRefine((data, ctx) => rejectBlankSku(data, ctx));

export const updateItemSchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID"),
    itemId: z.string().uuid("Invalid item ID"),
    type: itemFields.type.optional(),
    status: itemFields.status.optional(),
    name: itemFields.name.optional(),
    sku: itemFields.sku.optional(),
    description: itemFields.description.optional(),
    unitOfMeasure: itemFields.unitOfMeasure.optional(),
    unitPrice: itemFields.unitPrice.optional(),
    currency: itemFields.currency.optional(),
    taxRateId: itemFields.taxRateId.optional(),
    notes: itemFields.notes.optional(),
  })
  .superRefine((data, ctx) => rejectBlankSku(data, ctx));

export const itemLocatorSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  itemId: z.string().uuid("Invalid item ID"),
});

/**
 * Form schema for the item dialog.
 *
 * Same rules as `createItemSchema`, but with no `.default()`/`.transform()` so
 * react-hook-form's field type and the `zodResolver` input type are identical.
 * Money stays a decimal STRING end to end; the value is only converted to
 * `Prisma.Decimal` by the Server Action, never by floating-point arithmetic.
 */
export const itemFormSchema = z
  .object({
    type: itemTypeSchema,
    status: itemStatusSchema,
    name: z.string().trim().min(1, "Name is required").max(200),
    sku: z.string().trim().max(50),
    description: z.string().trim().max(2000),
    unitOfMeasure: unitOfMeasureSchema,
    unitPrice: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,4})?$/, "Enter a number with up to 4 decimal places")
      .refine((value) => Number(value) < 1e12, "Amount is too large"),
    currency: z.enum(SUPPORTED_CURRENCIES),
    /** Empty string means "no tax rate"; `undefined` cannot be a form value. */
    taxRateId: z
      .string()
      .uuid("Invalid tax rate ID")
      .optional()
      .or(z.literal("")),
    notes: z.string().trim().max(1000),
  })
  .superRefine((data, ctx) => rejectBlankSku(data, ctx));

export const ITEM_FORM_DEFAULT_VALUES: ItemFormValues = {
  type: "PRODUCT",
  status: "ACTIVE",
  name: "",
  sku: "",
  description: "",
  unitOfMeasure: "each",
  unitPrice: "0.00",
  currency: "KES",
  taxRateId: "",
  notes: "",
};

/** `unitOfMeasure` is a free-text column; only a known unit is selectable. */
export function toUnitOfMeasure(value: string): UnitOfMeasure {
  return (UNIT_OF_MEASURE as readonly string[]).includes(value)
    ? (value as UnitOfMeasure)
    : "each";
}

export const itemQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  search: z.string().max(100).optional(),
  type: itemTypeSchema.optional(),
  status: itemStatusSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
  sortBy: z
    .enum(["createdAt", "updatedAt", "name", "sku", "unitPrice"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateTaxCategoryInput = z.infer<typeof createTaxCategorySchema>;
export type UpdateTaxCategoryInput = z.infer<typeof updateTaxCategorySchema>;
export type TaxCategoryLocatorInput = z.infer<typeof taxCategoryLocatorSchema>;
export type TaxCategoryQueryInput = z.infer<typeof taxCategoryQuerySchema>;
export type TaxRateInput = z.infer<typeof taxRateSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ItemFormValues = z.infer<typeof itemFormSchema>;
export type ItemLocatorInput = z.infer<typeof itemLocatorSchema>;
export type ItemQueryInput = z.infer<typeof itemQuerySchema>;
