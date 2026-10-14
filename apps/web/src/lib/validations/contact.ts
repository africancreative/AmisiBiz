import { z } from "zod";

export const contactTypeSchema = z.enum(["INDIVIDUAL", "BUSINESS"]);
export type ContactType = z.infer<typeof contactTypeSchema>;

export const contactStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export type ContactStatus = z.infer<typeof contactStatusSchema>;

/**
 * Contacts are soft-deleted: `ARCHIVED` hides them from routine lists while the
 * row (and every document that references it) stays intact. There is deliberately
 * no hard-delete path for contacts — see `archiveContactAction`.
 */
const addressSchema = z.object({
  type: z.enum(["POSTAL", "PHYSICAL"]),
  line1: z.string().min(1, "Address line 1 is required").max(200).trim(),
  line2: z.string().max(200).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  state: z.string().max(100).optional().or(z.literal("")),
  postalCode: z.string().max(20).optional().or(z.literal("")),
  country: z
    .string()
    .length(2, "Country must be a 2-letter ISO code")
    .optional()
    .or(z.literal("")),
  isDefault: z.boolean().default(false),
});

/**
 * The writable contact fields, declared once and reused by the create and the
 * update schema. `tenantId`, `contactId` and `status` are intentionally absent
 * here: the tenant comes from the authorized context, the id is a separate
 * locator, and status changes only through the archive/restore actions.
 */
const contactFields = {
  type: contactTypeSchema.default("INDIVIDUAL"),
  firstName: z.string().max(100).optional().or(z.literal("")),
  lastName: z.string().max(100).optional().or(z.literal("")),
  companyName: z.string().max(200).optional().or(z.literal("")),
  email: z
    .string()
    .email("Invalid email address")
    .max(254)
    .optional()
    .or(z.literal("")),
  phone: z.string().max(50).optional().or(z.literal("")),
  mobile: z.string().max(50).optional().or(z.literal("")),
  taxPin: z.string().max(50).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
  addresses: z.array(addressSchema).max(2).optional(),
};

/**
 * Identity rule for both create and (partial) update: an individual needs a
 * person name, a business needs a company name. On update the check only
 * applies when the relevant fields are actually being sent.
 */
function requireContactIdentity(
  data: {
    type?: z.infer<typeof contactTypeSchema> | undefined;
    firstName?: string | null | undefined;
    lastName?: string | null | undefined;
    companyName?: string | null | undefined;
  },
  ctx: z.RefinementCtx,
  path: ["type"] | ["companyName"],
): void {
  const type = data.type ?? "INDIVIDUAL";
  if (type === "INDIVIDUAL") {
    if (!data.firstName?.trim() && !data.lastName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Individual contacts require a first or last name",
        path: ["firstName"],
      });
    }
    return;
  }
  if (!data.companyName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Business contacts require a company name",
      path,
    });
  }
}

export const createContactSchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID"),
    ...contactFields,
  })
  .superRefine((data, ctx) =>
    requireContactIdentity(data, ctx, ["companyName"]),
  );

export const updateContactSchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID"),
    contactId: z.string().uuid("Invalid contact ID"),
    type: contactTypeSchema.optional(),
    firstName: contactFields.firstName.optional(),
    lastName: contactFields.lastName.optional(),
    companyName: contactFields.companyName.optional(),
    email: contactFields.email.optional(),
    phone: contactFields.phone.optional(),
    mobile: contactFields.mobile.optional(),
    taxPin: contactFields.taxPin.optional(),
    notes: contactFields.notes.optional(),
    addresses: contactFields.addresses.optional(),
  })
  .superRefine((data, ctx) => {
    // Only enforce identity when the caller touches a name-bearing field, so a
    // phone-only update never fails on data the user did not edit.
    const touchesIdentity =
      data.type !== undefined ||
      data.firstName !== undefined ||
      data.lastName !== undefined ||
      data.companyName !== undefined;
    if (touchesIdentity) requireContactIdentity(data, ctx, ["companyName"]);
  });

/**
 * Form-facing schemas.
 *
 * These mirror `createContactSchema` but deliberately carry no `.default()` and
 * no `.transform()`, so react-hook-form's field-values type and the
 * `zodResolver` input/output types stay identical (a default makes the output
 * required while the input is still optional, which breaks the resolver
 * generic under `exactOptionalPropertyTypes`). The Server Action validates
 * again with the strict schema; the form rules exist only to give immediate
 * feedback with the same messages.
 */
export const addressFormSchema = z.object({
  type: z.enum(["POSTAL", "PHYSICAL"]),
  line1: z.string().trim().min(1, "Address line 1 is required").max(200),
  line2: z.string().trim().max(200),
  city: z.string().trim().max(100),
  state: z.string().trim().max(100),
  postalCode: z.string().trim().max(20),
  country: z
    .string()
    .trim()
    .max(2, "Country must be a 2-letter ISO code")
    .refine((value) => value === "" || /^[A-Za-z]{2}$/.test(value), {
      message: "Country must be a 2-letter ISO code",
    }),
  isDefault: z.boolean(),
});

export const contactFormSchema = z
  .object({
    type: contactTypeSchema,
    firstName: z.string().trim().max(100),
    lastName: z.string().trim().max(100),
    companyName: z.string().trim().max(200),
    email: z
      .string()
      .trim()
      .max(254)
      .refine(
        (value) => value === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
        {
          message: "Please enter a valid email address",
        },
      ),
    phone: z.string().trim().max(50),
    mobile: z.string().trim().max(50),
    taxPin: z.string().trim().max(50),
    notes: z.string().trim().max(2000),
    addresses: z.array(addressFormSchema).max(2, "At most two addresses"),
  })
  .superRefine((data, ctx) =>
    requireContactIdentity(
      {
        type: data.type,
        firstName: data.firstName,
        lastName: data.lastName,
        companyName: data.companyName,
      },
      ctx,
      ["companyName"],
    ),
  );

export const CONTACT_FORM_DEFAULT_VALUES: ContactFormValues = {
  type: "INDIVIDUAL",
  firstName: "",
  lastName: "",
  companyName: "",
  email: "",
  phone: "",
  mobile: "",
  taxPin: "",
  notes: "",
  addresses: [],
};

export const archiveContactSchema = z.object({
  contactId: z.string().uuid("Invalid contact ID"),
  tenantId: z.string().uuid("Invalid tenant ID"),
});

export const restoreContactSchema = archiveContactSchema;

export const contactLocatorSchema = archiveContactSchema;

export const contactQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  search: z.string().max(100).optional(),
  type: contactTypeSchema.optional(),
  status: contactStatusSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
  sortBy: z
    .enum([
      "createdAt",
      "updatedAt",
      "firstName",
      "lastName",
      "companyName",
      "email",
    ])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type AddressFormValues = z.infer<typeof addressFormSchema>;
export type ContactFormValues = z.infer<typeof contactFormSchema>;
export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type ArchiveContactInput = z.infer<typeof archiveContactSchema>;
export type ContactLocatorInput = z.infer<typeof contactLocatorSchema>;
export type ContactQueryInput = z.infer<typeof contactQuerySchema>;
export type AddressInput = z.infer<typeof addressSchema>;
