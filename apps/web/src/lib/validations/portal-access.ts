import { z } from "zod";

/**
 * Customer portal access management (AGENT 4, section A).
 *
 * A portal login is granted by exactly one column: `Contact.portalUserId`. These
 * schemas are the only payloads that may touch it, and each of them is a locator
 * plus a target — never a contact field. A caller cannot change a customer's
 * name, prices or document history through this surface, and cannot name the
 * tenant it acts inside except as the id the authorization layer verifies.
 */

const tenantIdSchema = z.string().uuid("Invalid tenant ID");
const contactIdSchema = z.string().uuid("Invalid contact ID");
const portalUserIdSchema = z.string().uuid("Invalid portal account ID");

/**
 * Overview query. `pageSize` is capped lower than the contact list's because
 * this screen shows a page of linkable customers beside every portal account and
 * a long page would push the accounts off the screen.
 */
export const portalAccessQuerySchema = z.object({
  tenantId: tenantIdSchema,
  search: z.string().trim().max(100).optional().or(z.literal("")),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(50).default(25),
});

/**
 * Grant: link one existing portal account of THIS tenant to one customer.
 *
 * There is deliberately no `createUser`, `role` or `email` field here. The
 * account must already exist and already hold the CUSTOMER_PORTAL_USER
 * membership — created through the invitation flow on the Team page, which is
 * where role assignment and its guard triggers live. Minting an identity from a
 * settings screen would put a second, weaker path to the same privilege in the
 * app.
 */
export const grantPortalAccessSchema = z.object({
  tenantId: tenantIdSchema,
  contactId: contactIdSchema,
  portalUserId: portalUserIdSchema,
});

/** Revoke: clear the link. The customer row itself is untouched. */
export const revokePortalAccessSchema = z.object({
  tenantId: tenantIdSchema,
  contactId: contactIdSchema,
});

export type PortalAccessQueryInput = z.infer<typeof portalAccessQuerySchema>;
export type GrantPortalAccessInput = z.infer<typeof grantPortalAccessSchema>;
export type RevokePortalAccessInput = z.infer<typeof revokePortalAccessSchema>;
