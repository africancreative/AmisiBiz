import { z } from "zod";
import { moneySchema, percentSchema } from "@amisibiz/domain";

/**
 * A calendar date accepted from a form (`"YYYY-MM-DD"`), a server payload (an
 * ISO string or a `Date`) or "not set" (`""`/`null`/`undefined`). The empty
 * forms collapse to `null` so an open-ended validity bound stays open.
 */
const optionalDateSchema = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z.coerce.date().nullable(),
);

const VALIDITY_WINDOW_MESSAGE =
  "The valid-until date must not be before the valid-from date.";

/**
 * The validity window may be open at either end, but must not run backwards.
 * A single-sided or fully-absent window never expires.
 */
function validityWindowInOrder(data: {
  validFrom?: Date | null | undefined;
  validUntil?: Date | null | undefined;
}): boolean {
  if (!data.validFrom || !data.validUntil) return true;
  return data.validFrom <= data.validUntil;
}

/**
 * Customer-specific catalogue assignments.
 *
 * These rows hold the agreed price for ONE contact. They never write back to
 * `Item.unitPrice`, so a customer-specific price cannot change the default price
 * anyone else sees (Phase 04 brief D).
 */
export const createContactItemSchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID"),
    contactId: z.string().uuid("Invalid contact ID"),
    itemId: z.string().uuid("Invalid item ID"),
    customCode: z.string().max(50).optional().or(z.literal("")),
    customName: z.string().max(200).optional().or(z.literal("")),
    customUnitOfMeasure: z.string().max(20).optional().or(z.literal("")),
    agreedPrice: moneySchema,
    discountPercent: percentSchema.default("0"),
    isAvailable: z.boolean().default(true),
    validFrom: optionalDateSchema,
    validUntil: optionalDateSchema,
  })
  .refine(validityWindowInOrder, {
    message: VALIDITY_WINDOW_MESSAGE,
    path: ["validUntil"],
  });

/**
 * The immutable identity of an assignment (tenant/contact/item) is not
 * editable — re-assigning means removing and adding, which keeps the uniqueness
 * constraint honest. `tenantId` is still required so the action re-authorizes.
 */
export const updateContactItemSchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID"),
    contactItemId: z.string().uuid("Invalid contact item ID"),
    customCode: z.string().max(50).optional().or(z.literal("")),
    customName: z.string().max(200).optional().or(z.literal("")),
    customUnitOfMeasure: z.string().max(20).optional().or(z.literal("")),
    agreedPrice: moneySchema.optional(),
    discountPercent: percentSchema.optional(),
    isAvailable: z.boolean().optional(),
    // A one-sided edit is checked against the stored window in the action, so
    // the schema only rejects an already-inverted pair here.
    validFrom: optionalDateSchema.optional(),
    validUntil: optionalDateSchema.optional(),
  })
  .refine(validityWindowInOrder, {
    message: VALIDITY_WINDOW_MESSAGE,
    path: ["validUntil"],
  });

export const deleteContactItemSchema = z.object({
  contactItemId: z.string().uuid("Invalid contact item ID"),
  tenantId: z.string().uuid("Invalid tenant ID"),
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
 * A date in the shape a `type="date"` input emits (`YYYY-MM-DD`), or `""` for
 * "not set". Compared as text, which for this shape is chronological order.
 */
export const dateInputFormSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date")
  .or(z.literal(""));

/**
 * Form schema for the customer-item dialog.
 *
 * Every field is required in form state (empty string means "not set"), because
 * optional-plus-transform shapes break `zodResolver` under
 * `exactOptionalPropertyTypes`. `itemId` only needs to be a cuid once the item
 * is chosen, so it accepts `""` for the initial "select an item" option.
 */
export const contactItemFormSchema = z
  .object({
    itemId: z.union([z.string().uuid("Please select an item"), z.literal("")]),
    customCode: z.string().trim().max(50, "Customer code is too long"),
    customName: z.string().trim().max(200, "Customer name is too long"),
    customUnitOfMeasure: z.string().trim().max(20, "Unit is too long"),
    agreedPrice: decimalPriceFormSchema,
    discountPercent: percentFormSchema,
    isAvailable: z.boolean(),
    validFrom: dateInputFormSchema,
    validUntil: dateInputFormSchema,
  })
  .refine(
    ({ validFrom, validUntil }) =>
      !validFrom || !validUntil || validFrom <= validUntil,
    { message: VALIDITY_WINDOW_MESSAGE, path: ["validUntil"] },
  );

export const CONTACT_ITEM_FORM_DEFAULT_VALUES: ContactItemFormValues = {
  itemId: "",
  customCode: "",
  customName: "",
  customUnitOfMeasure: "",
  agreedPrice: "0.00",
  discountPercent: "0",
  isAvailable: true,
  validFrom: "",
  validUntil: "",
};

export const contactItemLocatorSchema = deleteContactItemSchema;
export const availableItemsQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  contactId: z.string().uuid("Invalid contact ID"),
});

export const contactItemQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  contactId: z.string().uuid("Invalid contact ID").optional(),
  itemId: z.string().uuid("Invalid item ID").optional(),
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
