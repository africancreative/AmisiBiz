import { z } from "zod";

export const itemTypeSchema = z.enum(["PRODUCT", "SERVICE"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

export const itemStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

// Decimal fields use string input to avoid floating-point issues
const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "Must be a valid decimal number with up to 4 decimal places")
  .transform((v) => v);

const taxRateSchema = z.object({
  id: z.string().cuid().optional(),
  categoryId: z.string().cuid("Invalid tax category"),
  name: z.string().min(1).max(100),
  rate: decimalStringSchema.refine((v) => parseFloat(v) >= 0 && parseFloat(v) <= 1, "Rate must be between 0 and 1"),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
  isActive: z.boolean().default(true),
});

export const createTaxCategorySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().max(500).optional().or(z.literal("")),
  isDefault: z.boolean().default(false),
  rates: z.array(taxRateSchema).min(1, "At least one tax rate is required"),
});

export const updateTaxCategorySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  categoryId: z.string().cuid("Invalid tax category ID"),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().or(z.literal("")),
  isDefault: z.boolean().optional(),
});

export const taxCategoryQuerySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

export type CreateTaxCategoryInput = z.infer<typeof createTaxCategorySchema>;
export type UpdateTaxCategoryInput = z.infer<typeof updateTaxCategorySchema>;
export type TaxCategoryQueryInput = z.infer<typeof taxCategoryQuerySchema>;
export type TaxRateInput = z.infer<typeof taxRateSchema>;

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

export const createItemSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  type: itemTypeSchema.default("PRODUCT"),
  status: itemStatusSchema.default("ACTIVE"),
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

export const updateItemSchema = createItemSchema.partial().omit({ tenantId: true }).extend({
  itemId: z.string().cuid("Invalid item ID"),
});

export const itemQuerySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  search: z.string().max(100).optional(),
  type: itemTypeSchema.optional(),
  status: itemStatusSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
  sortBy: z.enum(["createdAt", "updatedAt", "name", "sku", "unitPrice"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ItemQueryInput = z.infer<typeof itemQuerySchema>;