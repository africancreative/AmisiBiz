import { z } from "zod";

export const contactTypeSchema = z.enum(["INDIVIDUAL", "BUSINESS"]);
export type ContactType = z.infer<typeof contactTypeSchema>;

export const contactStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export type ContactStatus = z.infer<typeof contactStatusSchema>;

const addressSchema = z.object({
  type: z.enum(["POSTAL", "PHYSICAL"]),
  line1: z.string().min(1, "Address line 1 is required").max(200),
  line2: z.string().max(200).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  state: z.string().max(100).optional().or(z.literal("")),
  postalCode: z.string().max(20).optional().or(z.literal("")),
  country: z.string().length(2, "Country must be a 2-letter ISO code").optional().or(z.literal("")),
  isDefault: z.boolean().default(false),
});

export const createContactSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  type: contactTypeSchema.default("INDIVIDUAL"),
  firstName: z.string().max(100).optional().or(z.literal("")),
  lastName: z.string().max(100).optional().or(z.literal("")),
  companyName: z.string().max(200).optional().or(z.literal("")),
  email: z.string().email("Invalid email address").max(254).optional().or(z.literal("")),
  phone: z.string().max(50).optional().or(z.literal("")),
  mobile: z.string().max(50).optional().or(z.literal("")),
  taxPin: z.string().max(50).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
  addresses: z.array(addressSchema).max(2).optional(),
}).refine(
  (data) => {
    if (data.type === "INDIVIDUAL") {
      return data.firstName?.trim() || data.lastName?.trim();
    }
    return data.companyName?.trim();
  },
  {
    message: "Individual contacts require a name; business contacts require a company name",
    path: ["type"],
  }
);

export const updateContactSchema = createContactSchema.partial().omit({ tenantId: true }).extend({
  contactId: z.string().cuid("Invalid contact ID"),
});

export const archiveContactSchema = z.object({
  contactId: z.string().cuid("Invalid contact ID"),
  tenantId: z.string().cuid("Invalid tenant ID"),
});

export const contactQuerySchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  search: z.string().max(100).optional(),
  type: contactTypeSchema.optional(),
  status: contactStatusSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
  sortBy: z.enum(["createdAt", "updatedAt", "firstName", "lastName", "companyName", "email"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type ArchiveContactInput = z.infer<typeof archiveContactSchema>;
export type ContactQueryInput = z.infer<typeof contactQuerySchema>;
export type AddressInput = z.infer<typeof addressSchema>;