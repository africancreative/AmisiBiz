import { z } from "zod";
import { moneySchema } from "@amisibiz/domain";

/**
 * Catalogue validation (AGENT 02 module C).
 *
 * House rules this file keeps:
 *  - Money is a decimal STRING end to end (`moneySchema`: non-negative, up to
 *    4dp, bounded). Only the Server Action converts it to `Prisma.Decimal`;
 *    no floating-point arithmetic ever touches a price.
 *  - Currency on a variant is EXPLICIT ISO-3 and required on create: a variant
 *    row stores its own price and currency, nothing is inherited implicitly
 *    from the item (design spec §4).
 *  - `blobUrl` is never a client field. Image rows are created by the server
 *    upload path only (`services/item-images.ts`); the schemas here accept
 *    metadata (alt) and locators, never a URL.
 */

export const CATEGORY_NAME_MAX = 120;
export const VARIANT_SKU_MAX = 64;
export const IMAGE_ALT_MAX = 200;
export const ARCHIVE_REASON_MAX = 500;

const uuidSchema = z.string().uuid("Invalid ID");

/** Closed vocabulary matching the `VariantStatus` enum (never ARCHIVED). */
export const variantStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type VariantStatusValue = z.infer<typeof variantStatusSchema>;

/**
 * Explicit ISO-3 currency (uppercase after trim). Deliberately NOT
 * `currencySchema` from the domain package: that one restricts to the
 * currently supported set for DOCUMENTS, while a variant may carry any ISO-3
 * code the marketplace trades in — the point here is that it is stated, never
 * defaulted (design spec §4: "no hidden default").
 */
export const isoCurrencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), {
    message: "Currency must be an explicit 3-letter ISO 4217 code",
  });

/** A SKU that was clearly meant to carry text but is only whitespace is a typo. */
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

// ─── Categories ───────────────────────────────────────────────────────────────

export const createCategorySchema = z.object({
  tenantId: uuidSchema,
  name: z.string().min(1, "Name is required").max(CATEGORY_NAME_MAX).trim(),
  parentId: uuidSchema.nullish(),
});

export const updateCategorySchema = z.object({
  tenantId: uuidSchema,
  categoryId: uuidSchema,
  name: z.string().min(1).max(CATEGORY_NAME_MAX).trim().optional(),
  parentId: uuidSchema.nullish(),
});

export const categoryLocatorSchema = z.object({
  tenantId: uuidSchema,
  categoryId: uuidSchema,
});

export const categoryQuerySchema = z.object({
  tenantId: uuidSchema,
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(50),
});

// ─── Variants ─────────────────────────────────────────────────────────────────

export const createVariantSchema = z
  .object({
    tenantId: uuidSchema,
    itemId: uuidSchema,
    name: z.string().min(1, "Name is required").max(200).trim(),
    sku: z.string().max(VARIANT_SKU_MAX).optional().or(z.literal("")),
    unitPrice: moneySchema,
    currency: isoCurrencySchema,
    taxRateId: z.string().uuid("Invalid tax rate ID").nullish(),
    status: variantStatusSchema.default("ACTIVE"),
    position: z.number().int().default(0),
  })
  .superRefine((data, ctx) => rejectBlankSku(data, ctx));

export const updateVariantSchema = z
  .object({
    tenantId: uuidSchema,
    variantId: uuidSchema,
    itemId: uuidSchema.optional(),
    name: z.string().min(1).max(200).trim().optional(),
    sku: z.string().max(VARIANT_SKU_MAX).optional().or(z.literal("")),
    unitPrice: moneySchema.optional(),
    currency: isoCurrencySchema.optional(),
    taxRateId: z.string().uuid("Invalid tax rate ID").nullish(),
    status: variantStatusSchema.optional(),
    position: z.number().int().optional(),
  })
  .superRefine((data, ctx) => rejectBlankSku(data, ctx));

export const variantLocatorSchema = z.object({
  tenantId: uuidSchema,
  variantId: uuidSchema,
});

export const variantQuerySchema = z.object({
  tenantId: uuidSchema,
  itemId: uuidSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(50),
});

// ─── Item archive / restore ───────────────────────────────────────────────────

/**
 * Archiving an ITEM uses the `ItemStatus.ARCHIVED` value added by migration
 * 24b. There is deliberately no `archivedAt` column on `Item` (unlike Contact):
 * the status itself is the mechanism, and `updatedAt` records when it changed.
 * This is the documented deviation — nothing pretends a timestamp column exists.
 */
export const archiveItemSchema = z.object({
  tenantId: uuidSchema,
  itemId: uuidSchema,
  reason: z
    .string()
    .max(ARCHIVE_REASON_MAX)
    .trim()
    .optional()
    .or(z.literal("")),
});

export const restoreItemSchema = z.object({
  tenantId: uuidSchema,
  itemId: uuidSchema,
});

// ─── Images ───────────────────────────────────────────────────────────────────

/**
 * The upload input carries the FILE itself; the blob URL is produced by the
 * server-side storage seam and never accepted from the client. Zod's
 * `instanceof` check keeps a crafted object from reaching the storage path.
 */
export const uploadItemImageSchema = z.object({
  tenantId: uuidSchema,
  itemId: uuidSchema,
  alt: z.string().max(IMAGE_ALT_MAX).trim().optional().or(z.literal("")),
  file: z.instanceof(File),
});

export const imageLocatorSchema = z.object({
  tenantId: uuidSchema,
  imageId: uuidSchema,
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CategoryLocatorInput = z.infer<typeof categoryLocatorSchema>;
export type CategoryQueryInput = z.infer<typeof categoryQuerySchema>;
export type CreateVariantInput = z.infer<typeof createVariantSchema>;
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;
export type VariantLocatorInput = z.infer<typeof variantLocatorSchema>;
export type VariantQueryInput = z.infer<typeof variantQuerySchema>;
export type ArchiveItemInput = z.infer<typeof archiveItemSchema>;
export type RestoreItemInput = z.infer<typeof restoreItemSchema>;
export type UploadItemImageInput = z.infer<typeof uploadItemImageSchema>;
export type ImageLocatorInput = z.infer<typeof imageLocatorSchema>;
