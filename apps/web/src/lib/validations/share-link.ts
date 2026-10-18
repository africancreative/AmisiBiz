import { z } from "zod";

/**
 * Share-link validation (AGENT 02 modules C/E).
 *
 * The non-negotiable rule this file encodes: a token is NEVER a client
 * field. Create payloads carry a kind, its target id, an optional message,
 * an optional future expiry and optional UTM attribution strings — anything
 * else a caller slips in (`token`, `viewCount`, `active`, `tenantId`
 * overrides) is stripped by the object schema before the service runs.
 * The service generates the token server-side and stamps the tenant from
 * the authorization context.
 */

const uuidSchema = z.string().uuid("Invalid ID");

/**
 * Kinds a staff member can create here. `LEAD_FORM` links address the
 * tenant's public capture form and are created through the public/plumbing
 * surface, not by this mutation set (design spec §2 assigns that path to the
 * capture API); the phase-2C brief for this action covers PRODUCT and
 * ORDER_STATUS only.
 */
export const shareLinkCreatableKindSchema = z.enum(["PRODUCT", "ORDER_STATUS"]);
export type ShareLinkCreatableKind = z.infer<
  typeof shareLinkCreatableKindSchema
>;

export const createShareLinkSchema = z
  .object({
    tenantId: uuidSchema,
    kind: shareLinkCreatableKindSchema,
    itemId: uuidSchema.nullish(),
    documentId: uuidSchema.nullish(),
    message: z.string().max(2000).trim().optional().or(z.literal("")),
    /** ISO-8601 instant; when present it must be in the future. */
    expiresAt: z.string().datetime().optional(),
    utmSource: z.string().max(200).trim().optional().or(z.literal("")),
    utmMedium: z.string().max(200).trim().optional().or(z.literal("")),
    utmCampaign: z.string().max(200).trim().optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "PRODUCT") {
      if (!data.itemId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A PRODUCT link requires an item",
          path: ["itemId"],
        });
      }
      if (data.documentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A PRODUCT link cannot carry a document",
          path: ["documentId"],
        });
      }
    } else {
      if (!data.documentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An ORDER_STATUS link requires a document",
          path: ["documentId"],
        });
      }
      if (data.itemId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An ORDER_STATUS link cannot carry an item",
          path: ["itemId"],
        });
      }
    }

    if (data.expiresAt) {
      const when = new Date(data.expiresAt);
      if (!(when.getTime() > Date.now())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expiry must be in the future",
          path: ["expiresAt"],
        });
      }
    }
  });

export const shareLinkLocatorSchema = z.object({
  tenantId: uuidSchema,
  shareLinkId: uuidSchema,
});

export const listShareLinksSchema = z.object({
  tenantId: uuidSchema,
  kind: z.enum(["PRODUCT", "LEAD_FORM", "ORDER_STATUS"]).optional(),
  itemId: uuidSchema.optional(),
  documentId: uuidSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

/**
 * Expiry update. `null` clears the expiry (the link then runs until revoked);
 * a date must still be in the future — extending into the past is a revoke
 * dressed up as an edit, and revoke has its own audited verb.
 */
export const updateShareLinkExpirySchema = z
  .object({
    tenantId: uuidSchema,
    shareLinkId: uuidSchema,
    expiresAt: z.string().datetime().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.expiresAt !== null) {
      const when = new Date(data.expiresAt);
      if (!(when.getTime() > Date.now())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expiry must be in the future",
          path: ["expiresAt"],
        });
      }
    }
  });

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type ShareLinkLocatorInput = z.infer<typeof shareLinkLocatorSchema>;
export type ListShareLinksInput = z.infer<typeof listShareLinksSchema>;
export type UpdateShareLinkExpiryInput = z.infer<
  typeof updateShareLinkExpirySchema
>;
