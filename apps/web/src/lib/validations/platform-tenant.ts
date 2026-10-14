import { z } from "zod";
import { isValidSlug } from "@/lib/tenancy/host";

/**
 * Provider-administration input (Phase 2).
 *
 * Every schema here carries an explicit `tenantId` because a platform action
 * addresses a specific workspace — and that id is only ever used to *scope* the
 * authorization (`authorizePlatformTenant`), never trusted as a fact about the
 * tenant. Nothing in this file accepts a status, an activation timestamp or a
 * suspension field from a caller: those are written by the lifecycle workflow
 * alone, which is also what the database enforces through
 * `tenant_provider_columns_guard_update`.
 */

const tenantIdField = z.string().uuid("Invalid tenant ID");

/**
 * A reason for a lifecycle transition.
 *
 * Required for every transition, not just suspension. The MVP suspends and
 * reactivates by hand, so the reason is the only record of the commercial or
 * operational situation the operator was acting on — and `TenantStatusHistory`
 * is the trail a later dispute is read from. An empty reason would make the
 * history a list of timestamps.
 */
export const statusTransitionSchema = z.object({
  tenantId: tenantIdField,
  reason: z
    .string()
    .trim()
    .min(3, "A reason is required for every status change")
    .max(500, "Reason is too long"),
});

export const platformUpdateTenantSchema = z.object({
  tenantId: tenantIdField,
  name: z.string().trim().min(2, "Name too short").max(100).optional(),
  /**
   * ISO codes are normalised here, once, so the database never holds two spellings
   * of the same country or currency (`KE`/`ke`, `kes`/`KES`).
   */
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Country must be a 2-letter ISO code")
    .transform((value) => value.toUpperCase())
    .optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter ISO code")
    .transform((value) => value.toUpperCase())
    .optional(),
  /**
   * A timezone must be a real IANA identifier: `Intl.DateTimeFormat` is what
   * throws on a made-up one, and a workspace whose timezone does not exist
   * cannot render its own document dates.
   */
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid timezone such as Africa/Nairobi")
    .optional(),
  locale: z.enum(["en", "fr", "sw"]).optional(),
});

export const assignTenantPlanSchema = z.object({
  tenantId: tenantIdField,
  /** null clears the label; the plan itself carries no entitlement. */
  planId: z.string().uuid("Invalid plan ID").nullable(),
});

/**
 * Branding input for the provider console is `updateTenantBrandingSchema`
 * itself — the same fields, the same rules, the same validated patch as the
 * workspace's own branding screen. A separate provider copy of that schema would
 * be a second place for the definition of "branding" to drift, and the point of
 * the design is that provider-set and self-set branding are indistinguishable to
 * a document template.
 */

const periodStyleSchema = z.enum(["NONE", "CALENDAR_YEAR", "FINANCIAL_YEAR"]);
const documentTypeSchema = z.enum(["QUOTATION", "INVOICE", "DELIVERY_NOTE"]);

export const documentNumberingSeriesSchema = z.object({
  type: documentTypeSchema,
  prefix: z
    .string()
    .trim()
    .min(1, "A numbering prefix is required")
    .max(12, "Prefix is too long")
    .regex(
      /^[A-Za-z][A-Za-z0-9_-]*$/,
      "Prefix must start with a letter and contain only letters, digits, hyphens or underscores",
    ),
  padding: z.coerce
    .number()
    .int()
    .min(3, "Sequence numbers need at least 3 digits")
    .max(10, "Sequence numbers may not exceed 10 digits"),
  separator: z.enum(["-", "/", "_", "."]).default("-"),
  periodStyle: periodStyleSchema.default("CALENDAR_YEAR"),
  fiscalStartMonth: z.coerce
    .number()
    .int()
    .min(1, "Fiscal year starts between month 1 and 12")
    .max(12, "Fiscal year starts between month 1 and 12")
    .default(1),
});

export const updateDocumentNumberingSchema = z.object({
  tenantId: tenantIdField,
  series: z
    .array(documentNumberingSeriesSchema)
    .min(1)
    .max(3, "There are three document types")
    .refine(
      (rows) => new Set(rows.map((row) => row.type)).size === rows.length,
      { message: "Each document type appears once" },
    ),
});

/**
 * Hostnames.
 *
 * A bare DNS name, lower-cased, no scheme and no path: stored as the matching
 * rule the request router compares `Host:` against. Format validation lives
 * here rather than in a database CHECK because the column already holds
 * operator-authored values that a failed `ADD CONSTRAINT` would not let deploy
 * past — and a rejected form is a better outcome than a rejected migration.
 */
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, "Hostname is too long")
  .regex(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "Enter a hostname such as invoices.example.co.ke",
  );

export const addTenantDomainSchema = z.object({
  tenantId: tenantIdField,
  hostname: hostnameSchema,
  setAsPrimary: z.boolean().default(false),
});

export const setPrimaryDomainSchema = z.object({
  tenantId: tenantIdField,
  hostname: hostnameSchema,
});

export const removeTenantDomainSchema = z.object({
  tenantId: tenantIdField,
  hostname: hostnameSchema,
});

export const updateTenantSlugSchema = z.object({
  tenantId: tenantIdField,
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => isValidSlug(value), {
      message:
        "Slug must be 2-63 lowercase letters, numbers or hyphens and not a reserved name",
    }),
});

/**
 * Assigning the initial owner.
 *
 * This creates (or refreshes) a TENANT_OWNER invitation for the address. It does
 * not create a membership: ownership only lands when a person signed in as that
 * address accepts the invitation, so a submitted email can never mint an owner —
 * the same rule `createTenantAction` has always followed.
 */
export const assignTenantOwnerSchema = z.object({
  tenantId: tenantIdField,
  email: z.string().trim().toLowerCase().email("Invalid email address"),
});

export const tenantSearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED"]).optional(),
  /**
   * A plan filter. `none` is the console's "no plan assigned yet" option, which is
   * a real answer operators need — an unassigned workspace is exactly the backlog
   * item they page through.
   */
  planId: z
    .union([z.literal("none"), z.string().uuid()])
    .nullable()
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type StatusTransitionInput = z.infer<typeof statusTransitionSchema>;
export type PlatformUpdateTenantInput = z.infer<
  typeof platformUpdateTenantSchema
>;
export type AssignTenantPlanInput = z.infer<typeof assignTenantPlanSchema>;
export type UpdateDocumentNumberingInput = z.infer<
  typeof updateDocumentNumberingSchema
>;
export type AddTenantDomainInput = z.infer<typeof addTenantDomainSchema>;
export type SetPrimaryDomainInput = z.infer<typeof setPrimaryDomainSchema>;
export type RemoveTenantDomainInput = z.infer<typeof removeTenantDomainSchema>;
export type UpdateTenantSlugInput = z.infer<typeof updateTenantSlugSchema>;
export type AssignTenantOwnerInput = z.infer<typeof assignTenantOwnerSchema>;
export type TenantSearchInput = z.infer<typeof tenantSearchSchema>;
