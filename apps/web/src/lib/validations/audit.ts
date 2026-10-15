import { z } from "zod";

/**
 * Audit-trail QUERY validation.
 *
 * The audit viewer is a read path over a table that records privilege: it must
 * be as strict as a write path, because its output is exactly what an
 * investigator trusts. Two rules drive the shape below:
 *
 *  - Filters are bounded. `pageSize` has a ceiling and free-text filters have a
 *    length, so a caller cannot turn the viewer into an unbounded scan.
 *  - `tenantId` is validated here and re-authorized in the action. Parsing is not
 *    authorization: the action overrides it with the tenant the caller is
 *    authorized for, so a forged id can never broaden a tenant read.
 */

/**
 * A calendar/timestamp bound accepted as `"YYYY-MM-DD"`, an ISO string, or a
 * `Date`; the empty forms collapse to `null` so "no lower/upper bound" is
 * explicit rather than an epoch accident.
 */
const optionalDateSchema = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z.coerce.date().nullable(),
);

const WINDOW_MESSAGE = "The 'from' date must not be after the 'to' date.";

function windowInOrder(data: {
  from?: Date | null | undefined;
  to?: Date | null | undefined;
}): boolean {
  if (!data.from || !data.to) return true;
  return data.from <= data.to;
}

const auditFilterFields = {
  /** Substring match against the canonical action name (e.g. `auth.signIn`). */
  action: z.string().trim().max(120).optional(),
  /** Substring match against the resource label (e.g. `Document`). */
  resource: z.string().trim().max(120).optional(),
  /** Exact actor id. */
  userId: z.string().uuid("Invalid user ID").optional(),
  from: optionalDateSchema,
  to: optionalDateSchema,
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
} as const;

/**
 * Tenant view: the caller reads one workspace's trail. The action replaces
 * `tenantId` with the authorized tenant, but requiring it keeps the contract
 * explicit at the call site.
 */
export const tenantAuditQuerySchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID"),
    ...auditFilterFields,
  })
  .refine(windowInOrder, { message: WINDOW_MESSAGE, path: ["to"] });

/**
 * Platform view: the provider reads across every workspace, optionally narrowed
 * to one tenant. `tenantId` being optional is the only difference from the
 * tenant schema — the permission differs, the filters do not.
 */
export const platformAuditQuerySchema = z
  .object({
    tenantId: z.string().uuid("Invalid tenant ID").optional(),
    ...auditFilterFields,
  })
  .refine(windowInOrder, { message: WINDOW_MESSAGE, path: ["to"] });

export type TenantAuditQueryInput = z.infer<typeof tenantAuditQuerySchema>;
export type PlatformAuditQueryInput = z.infer<typeof platformAuditQuerySchema>;
