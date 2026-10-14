import { z } from "zod";
import { moneySchema, percentSchema } from "@/lib/validation/common";

/**
 * Customer-specific catalogue assignments.
 *
 * These rows hold the agreed price for ONE contact. They never write back to
 * `Item.unitPrice`, so a customer-specific price cannot change the default price
 * anyone else sees (Phase 04 brief D).
 */
export const createContactItemSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  contactId: z.string().cuid("Invalid contact ID"),
  itemId: z.string().cuid("Invalid item ID"),
  customCode: z.string().max(50).optional().or(z.literal("")),
  customName: z.string().max(200).optional().or(z.literal("")),
  agreedPrice: moneySchema,
  discountPercent: percentSchema.default("0"),
  isAvailable: z.boolean().default(true),
});

/**
 * The immutable identity of an assignment (tenant/contact/item) is not
 * editable — re-assigning means removing and adding, which keeps the uniqueness
 * constraint honest. `tenantId` is still required so the action re-authorizes.
 */
export const updateContactItemSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  contactItemId: z.string().cuid("Invalid contact item ID"),
  customCode: z.string().max(50).optional().or(z.literal("")),
  customName: z.string().max(200).optional().or(z.literal("")),
  agreedPrice: moneySchema.optional(),
  discountPercent: percentSchema.optional(),
  isAvailable: z.boolean().optional(),
});

export const deleteContactItemSchema = z.object({
  contactItemId: z.string().cuid("Invalid contact item ID"),
  tenantId: z.string().cuid("Invalid tenant ID"),
});

/**
 * Decimal amount / percentage rules in their form shape: identical constraints
 * to `moneySchema` and `percentSchema` but without transforms, so the value
 * react-hook-form holds is exactly the value it validates. Prices stay decimal
 * strings; the Server Action alone converts them to `Prisma.Decimal`.
 */
export const decimalPriceFormSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,4})?$/, "Enter a number with up to 4 decimal places")
  .refine((value) => Number(value) < 1e12, "Amount is too large");

export const percentFormSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Enter a percentage with up to 2 decimal places")
  .refine((value) => Number(value) <= 100, "Must be between 0 and 100");

/**
 * Form schema for the customer-item dialog.
 *
 * Every field is required in form state (empty string means "not set"), because
 * optional-plus-transform shapes break `zodResolver` under
 * `exactOptionalPropertyTypes`. `itemId` only needs to be a cuid once the item
 * is chosen, so it accepts `""` for the initial "select an item" option.
 */
export const contactItemFormSchema = z.object({
  itemId: z.union([z.string().cuid("Please select an item"), z.literal("")]),
  customCode: z.string().trim().max(50, "Customer code is too long"),
  customName: z.string().trim().max(200, "Customer name is too long"),
  agreedPrice: decimalPriceFormSchema,
  discountPercent: percentFormSchema,
  isAvailable: z.boolean(),
});

export const CONTACT_ITEM_FORM_DEFAULT_VALUES: ContactItemFormValues = {
  itemId: "",
  customCode: "",
  customName: "",
  agreedPrice: "0.00",
  discountPercent: "0",
  isAvailable: true,
};

export const contactItemLocatorSchema = deleteContactItemSchema;
export const availableItemsQuerySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  contactId: z.string().cuid("Invalid contact ID"),
});

export const contactItemQuerySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  contactId: z.string().cuid("Invalid contact ID").optional(),
  itemId: z.string().cuid("Invalid item ID").optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

export type CreateContactItemInput = z.infer<typeof createContactItemSchema>;
export type UpdateContactItemInput = z.infer<typeof updateContactItemSchema>;
export type ContactItemFormValues = z.infer<typeof contactItemFormSchema>;
export type DeleteContactItemInput = z.infer<typeof deleteContactItemSchema>;
export type ContactItemLocatorInput = z.infer<typeof contactItemLocatorSchema>;
export type AvailableItemsQueryInput = z.infer<
  typeof availableItemsQuerySchema
>;
export type ContactItemQueryInput = z.infer<typeof contactItemQuerySchema>;
