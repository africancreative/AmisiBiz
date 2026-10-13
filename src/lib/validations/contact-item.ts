import { z } from "zod";

const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "Must be a valid decimal number with up to 4 decimal places")
  .transform((v) => v);

const discountPercentSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Must be a valid percentage with up to 2 decimal places")
  .refine((v) => parseFloat(v) >= 0 && parseFloat(v) <= 100, "Discount must be between 0 and 100")
  .transform((v) => v);

export const createContactItemSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  contactId: z.string().cuid("Invalid contact ID"),
  itemId: z.string().cuid("Invalid item ID"),
  customCode: z.string().max(50).optional().or(z.literal("")),
  customName: z.string().max(200).optional().or(z.literal("")),
  agreedPrice: decimalStringSchema.refine((v) => parseFloat(v) >= 0, "Price must be non-negative"),
  discountPercent: discountPercentSchema.default("0"),
  isAvailable: z.boolean().default(true),
});

export const updateContactItemSchema = createContactItemSchema
  .partial()
  .omit({ tenantId: true, contactId: true, itemId: true })
  .extend({
    contactItemId: z.string().cuid("Invalid contact item ID"),
  });

export const deleteContactItemSchema = z.object({
  contactItemId: z.string().cuid("Invalid contact item ID"),
  tenantId: z.string().cuid("Invalid tenant ID"),
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
export type DeleteContactItemInput = z.infer<typeof deleteContactItemSchema>;
export type ContactItemQueryInput = z.infer<typeof contactItemQuerySchema>;