import { z } from "zod";
import { moneySchema } from "@amisibiz/domain";
import { documentLineInputSchema } from "./document-write";

/**
 * Lead & conversion validation (AGENT 02 Phase 2A).
 *
 * Rules that make this file the security boundary:
 *
 *  - **Server-owned fields are never client-set.** `id`, `tenantId` (except as
 *    the locator that gets re-authorized), `revision`, `status` on a create,
 *    `convertedAt` / `convertedContactId` / `convertedDocumentId` / `lostAt`
 *    are absent from every payload schema — Zod strips unknown keys, and the
 *    services build Prisma data field-by-field, so a mass-assignment attempt
 *    simply never reaches the row.
 *  - **Status changes are typed operations, not field edits.** Status moves
 *    through the dedicated stage/lose/reopen/convert payloads; the free-form
 *    update schema has no `status` key at all.
 *  - **Money stays a decimal STRING end to end.** `estimatedValue` accepts a
 *    string or a number and coerces numbers to their exact decimal-string form
 *    before the money regex runs; only the Server Action converts to
 *    `Prisma.Decimal` — never floating-point arithmetic.
 *  - **Currency is explicit.** The `Lead.currency` column carries a KES
 *    default, but no schema here defaults it: §4 of the design spec demands
 *    an explicit selection on every price surface. The code is validated as
 *    3 uppercase ISO-4217 letters.
 */

/* --------------------------------- enums ---------------------------------- */

/** Mirrors the Prisma `LeadSource` enum values exactly. */
export const LEAD_SOURCES = [
  "WEB_FORM",
  "REFERRAL",
  "SOCIAL",
  "CAMPAIGN",
  "WALK_IN",
  "PHONE",
  "EMAIL",
  "IMPORT",
  "OTHER",
] as const;
export const leadSourceSchema = z.enum(LEAD_SOURCES);
export type LeadSourceValue = z.infer<typeof leadSourceSchema>;

/** Mirrors the Prisma `LeadStatus` enum values exactly (query filters only). */
export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "CONVERTED",
  "LOST",
] as const;
export const leadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatusValue = z.infer<typeof leadStatusSchema>;

/** Mirrors the Prisma `LeadPriority` enum (shared with tasks). */
export const LEAD_PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export const leadPrioritySchema = z.enum(LEAD_PRIORITIES);
export type LeadPriorityValue = z.infer<typeof leadPrioritySchema>;

/* --------------------------------- money ----------------------------------- */

/**
 * A 3-letter ISO 4217 code, case-normalised. Deliberately NOT the shared
 * `currencySchema` (which is pinned to the tenant-currency rollout): the
 * directive for leads is ISO shape validation, explicit on every payload.
 */
export const leadCurrencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), {
    message: "Currency must be a 3-letter ISO 4217 code",
  });

/**
 * Estimated value: string-or-number coerced to a decimal STRING with at most
 * 4 decimal places, >= 0, bounded like the document engine's money rule.
 * `1e3` and `1,200.00` are rejected: the number branch only accepts values
 * whose `String()` form is already a plain decimal.
 */
export const leadMoneySchema = z.preprocess(
  (value) => (typeof value === "number" ? String(value) : value),
  moneySchema,
);

/* ------------------------------- lead fields ------------------------------- */

const optionalText = (max: number) =>
  z.string().max(max).optional().or(z.literal(""));

/** The writable lead fields, declared once and reused by create and update. */
const leadFields = {
  firstName: optionalText(100),
  lastName: optionalText(100),
  companyName: optionalText(200),
  email: z
    .string()
    .trim()
    .email("Invalid email address")
    .max(254)
    .optional()
    .or(z.literal("")),
  phone: optionalText(50),
  description: optionalText(2000),
  priority: leadPrioritySchema.optional(),
  currency: leadCurrencySchema,
  estimatedValue: leadMoneySchema.nullish(),
  sourceDetail: optionalText(500),
  utmSource: optionalText(100),
  utmMedium: optionalText(100),
  utmCampaign: optionalText(100),
};

/** Idempotency keys match the document engine's shape rule. */
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid idempotency key");

export const createLeadSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  source: leadSourceSchema,
  /** Placement at capture time; the service proves tenant ownership. */
  pipelineStageId: z.string().uuid("Invalid stage ID").nullish(),
  assignedToUserId: z.string().uuid("Invalid user ID").nullish(),
  /** Existing-customer link; the service proves tenant ownership. */
  contactId: z.string().uuid("Invalid contact ID").nullish(),
  ...leadFields,
  idempotencyKey: idempotencyKeySchema.optional(),
  externalId: z.string().max(200).optional(),
});

/**
 * A patch update: only absent fields are untouched. `status`,
 * `pipelineStageId`, `assignedToUserId`, `lostReason`, `converted*` and
 * `revision` are deliberately absent — those move through the dedicated
 * stage/assign/lose/reopen/convert actions, never through free-form edit.
 */
export const updateLeadSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  leadId: z.string().uuid("Invalid lead ID"),
  firstName: leadFields.firstName,
  lastName: leadFields.lastName,
  companyName: leadFields.companyName,
  email: leadFields.email,
  phone: leadFields.phone,
  description: leadFields.description,
  priority: leadFields.priority,
  currency: leadFields.currency.optional(),
  estimatedValue: leadFields.estimatedValue,
  sourceDetail: leadFields.sourceDetail,
  utmSource: leadFields.utmSource,
  utmMedium: leadFields.utmMedium,
  utmCampaign: leadFields.utmCampaign,
});

export const leadLocatorSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  leadId: z.string().uuid("Invalid lead ID"),
});

export const moveLeadStageSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  leadId: z.string().uuid("Invalid lead ID"),
  stageId: z.string().uuid("Invalid stage ID"),
});

/** `null` unassigns; `undefined` leaves the assignment untouched. */
export const assignLeadSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  leadId: z.string().uuid("Invalid lead ID"),
  assignedToUserId: z.string().uuid("Invalid user ID").nullable(),
});

/** A loss without a reason is not auditable — the reason is mandatory. */
export const loseLeadSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  leadId: z.string().uuid("Invalid lead ID"),
  lostReason: z
    .string()
    .trim()
    .min(3, "A lost reason is required")
    .max(500, "Keep the reason under 500 characters"),
});

export const reopenLeadSchema = leadLocatorSchema;

/* ------------------------------- conversion -------------------------------- */

/**
 * The convert payload is a discriminated union: the operator explicitly chooses
 * to create a new contact or to link an existing one. The new-contact branch
 * carries the SAME field shape `createContactSchema` defines (minus the
 * tenant, which is server-set) — the conversion service re-validates it
 * against `createContactSchema` itself, so contact rules cannot drift.
 *
 * `draftLines` is optional ON PURPOSE: the document engine refuses a draft
 * with zero lines, and a conversion must never fake a quotation to satisfy a
 * flag. With no lines the conversion completes and the result tells the UI to
 * open the document editor.
 */
const conversionCommon = {
  tenantId: z.string().uuid("Invalid tenant ID"),
  leadId: z.string().uuid("Invalid lead ID"),
  createDraft: z.enum(["quotation", "order"]).optional(),
  draftLines: z.array(documentLineInputSchema).min(1).max(1000).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
};

export const convertLeadSchema = z.discriminatedUnion("mode", [
  z.object({
    ...conversionCommon,
    mode: z.literal("newContact"),
    /** Validated against `createContactSchema` in the conversion service. */
    contact: z.record(z.unknown()),
  }),
  z.object({
    ...conversionCommon,
    mode: z.literal("existingContact"),
    contactId: z.string().uuid("Invalid contact ID"),
  }),
]);

/** Shape of the new-contact branch as it arrives (unvalidated blob). */
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

/**
 * Typed view of the contact blob after `createContactSchema` has validated it.
 * The conversion service re-validates `contact` against `createContactSchema`
 * directly, so contact rules cannot drift from `createContactAction`.
 */
export type { CreateContactInput } from "./contact";

/* --------------------------------- queries --------------------------------- */

export const leadQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  status: leadStatusSchema.optional(),
  stageId: z.string().uuid("Invalid stage ID").optional(),
  assignedTo: z
    .union([z.string().uuid("Invalid user ID"), z.literal("unassigned")])
    .optional(),
  priority: leadPrioritySchema.optional(),
  /** Free-text over names, company, email and phone. */
  q: z.string().max(100).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

export const leadMetricsQuerySchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID"),
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((data) => data.from.getTime() <= data.to.getTime(), {
    message: "`from` must not be after `to`",
    path: ["from"],
  });

export const dedupeQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(50).optional(),
  companyName: z.string().trim().max(200).optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type LeadLocatorInput = z.infer<typeof leadLocatorSchema>;
export type MoveLeadStageInput = z.infer<typeof moveLeadStageSchema>;
export type AssignLeadInput = z.infer<typeof assignLeadSchema>;
export type LoseLeadInput = z.infer<typeof loseLeadSchema>;
export type ReopenLeadInput = z.infer<typeof reopenLeadSchema>;
export type LeadQueryInput = z.infer<typeof leadQuerySchema>;
export type LeadMetricsQueryInput = z.infer<typeof leadMetricsQuerySchema>;
export type DedupeQueryInput = z.infer<typeof dedupeQuerySchema>;
