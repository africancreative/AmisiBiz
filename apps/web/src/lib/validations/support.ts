import { z } from "zod";

/**
 * Provider support access validation (Phase 1, §5.6).
 *
 * A support grant is the ONLY way platform staff reach a customer's business
 * data, so the input shape refuses anything that would make it less
 * accountable: a reason is mandatory, and the lifetime is bounded. The grantee's
 * role is never taken from the form — the action re-reads it from the database.
 */

/** Longest lifetime a grant may be given (30 days). */
export const MAX_SUPPORT_GRANT_HOURS = 24 * 30;
export const DEFAULT_SUPPORT_GRANT_HOURS = 24;

const uuid = z.string().uuid("Invalid identifier");

export const grantSupportAccessSchema = z.object({
  tenantId: uuid,
  /** The SUPPORT staff account being authorized. */
  platformUserId: uuid,
  reason: z
    .string()
    .trim()
    .min(10, "A support grant needs a written business justification")
    .max(500, "Reason is too long"),
  durationHours: z
    .number()
    .int("Use whole hours")
    .min(1, "A grant must last at least one hour")
    .max(
      MAX_SUPPORT_GRANT_HOURS,
      `A support grant may not outlive ${MAX_SUPPORT_GRANT_HOURS / 24} days`,
    )
    .default(DEFAULT_SUPPORT_GRANT_HOURS),
});

export const revokeSupportAccessSchema = z.object({
  grantId: uuid,
  reason: z
    .string()
    .trim()
    .min(3, "Say why the access is being withdrawn")
    .max(500, "Reason is too long")
    .optional(),
});

export type GrantSupportAccessInput = z.infer<typeof grantSupportAccessSchema>;
export type RevokeSupportAccessInput = z.infer<
  typeof revokeSupportAccessSchema
>;
