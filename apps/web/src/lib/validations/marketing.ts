import { z } from "zod";
import { moneySchema } from "@amisibiz/domain";

/**
 * Marketing validation (AGENT 03 module B — campaigns, content, publish, media,
 * analytics).
 *
 * Same security posture as `integration.ts` / `inbox.ts`: every server-owned
 * field is ABSENT from every payload, so Zod's object stripping means a forged
 * `tenantId`, `id`, `status` on create, `approvedById` / `approvedAt`, `aiDraft`
 * provenance, `providerRef`, `viewCount` or a `blobUrl` simply never reaches the
 * service. Lifecycle transitions are TYPED operations (submit/approve/reject/
 * schedule/publish), never free-form status edits, and money is a decimal
 * STRING end to end (`moneySchema`).
 */

const uuid = z.string().uuid("Invalid ID");
const trim120 = z.string().trim().min(1).max(120);
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(""));

/* --------------------------------- enums ----------------------------------- */

export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
] as const;
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatusValue = z.infer<typeof campaignStatusSchema>;

export const CONTENT_POST_CHANNELS = ["FACEBOOK_PAGE", "INSTAGRAM"] as const;
export const contentPostChannelSchema = z.enum(CONTENT_POST_CHANNELS);
export type ContentPostChannelValue = z.infer<typeof contentPostChannelSchema>;

export const CONTENT_KINDS = ["POST", "STORY", "REEL"] as const;
export const contentKindSchema = z.enum(CONTENT_KINDS);
export type ContentKindValue = z.infer<typeof contentKindSchema>;

// The full column vocabulary is exposed for read filters only; WRITE payloads
// never carry `status` (transitions are typed operations).
export const CONTENT_POST_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "SCHEDULED",
  "PUBLISHED",
  "PUBLISH_FAILED",
] as const;

export const MEDIA_ASSET_KINDS = ["IMAGE", "VIDEO"] as const;

/* -------------------------------- campaigns -------------------------------- */

export const createCampaignSchema = z.object({
  tenantId: uuid,
  name: trim120,
  objective: optionalText(300),
  utmSource: optionalText(200),
  utmMedium: optionalText(200),
  utmCampaign: optionalText(200),
  // Budget is INFORMATIONAL money; a decimal string, never a gate. `status`
  // is absent — a new campaign is DRAFT by column default and only the
  // activate/pause/archive operations move it.
  budgetCurrency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Currency must be ISO-3")
    .default("KES"),
  budgetAmount: moneySchema.optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z.object({
  tenantId: uuid,
  campaignId: uuid,
  name: trim120.optional(),
  objective: optionalText(300),
  utmSource: optionalText(200),
  utmMedium: optionalText(200),
  utmCampaign: optionalText(200),
  budgetCurrency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Currency must be ISO-3")
    .optional(),
  budgetAmount: moneySchema.nullable().optional(),
});
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

export const campaignLocatorSchema = z.object({
  tenantId: uuid,
  campaignId: uuid,
});
export type CampaignLocatorInput = z.infer<typeof campaignLocatorSchema>;

export const listCampaignsSchema = z.object({
  tenantId: uuid,
  status: campaignStatusSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});
export type ListCampaignsInput = z.infer<typeof listCampaignsSchema>;

/* ------------------------------- content posts ------------------------------ */

/**
 * A content draft. `mediaAssetIds` are validated against the tenant server-side
 * (a forged id from another workspace finds no row); `status`,
 * `approvedById`/`approvedAt`, `aiDraft` and `createdById` are all absent — the
 * draft begins DRAFT, approval is a separate gated verb, provenance and author
 * are server-set.
 */
export const createContentPostSchema = z.object({
  tenantId: uuid,
  campaignId: uuid.nullish(),
  channel: contentPostChannelSchema,
  kind: contentKindSchema,
  title: optionalText(200),
  body: z.string().trim().min(1, "A post needs content").max(8000),
  mediaAssetIds: z.array(uuid).max(20).default([]),
  scheduledFor: z.coerce.date().optional(),
});
export type CreateContentPostInput = z.infer<typeof createContentPostSchema>;

export const updateContentPostSchema = z.object({
  tenantId: uuid,
  contentPostId: uuid,
  campaignId: uuid.nullish(),
  channel: contentPostChannelSchema.optional(),
  kind: contentKindSchema.optional(),
  title: optionalText(200),
  body: z.string().trim().min(1).max(8000).optional(),
  mediaAssetIds: z.array(uuid).max(20).optional(),
  // Only a DRAFT may re-time itself; SCHEDULED moves through its own verb.
  scheduledFor: z.coerce.date().nullish(),
});
export type UpdateContentPostInput = z.infer<typeof updateContentPostSchema>;

export const contentPostLocatorSchema = z.object({
  tenantId: uuid,
  contentPostId: uuid,
});
export type ContentPostLocatorInput = z.infer<typeof contentPostLocatorSchema>;

export const listContentPostsSchema = z.object({
  tenantId: uuid,
  campaignId: uuid.optional(),
  status: z.enum(CONTENT_POST_STATUSES).optional(),
  channel: contentPostChannelSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});
export type ListContentPostsInput = z.infer<typeof listContentPostsSchema>;

/** DRAFT → IN_REVIEW. */
export const submitContentPostForReviewSchema = contentPostLocatorSchema;

/**
 * IN_REVIEW → APPROVED | REJECTED. A distinct gated verb (`marketing.publish`);
 * `approvedById`/`approvedAt` are set server-side from the actor, never here.
 */
export const reviewContentPostSchema = z.object({
  tenantId: uuid,
  contentPostId: uuid,
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: optionalText(500),
});
export type ReviewContentPostInput = z.infer<typeof reviewContentPostSchema>;

/** APPROVED → SCHEDULED (a future time). */
export const scheduleContentPostSchema = z.object({
  tenantId: uuid,
  contentPostId: uuid,
  scheduledFor: z.coerce.date(),
});
export type ScheduleContentPostInput = z.infer<
  typeof scheduleContentPostSchema
>;

/**
 * Request an attempt against a live channel. The service refuses unless the
 * post is APPROVED or SCHEDULED and the connection is CONNECTED, then creates a
 * QUEUED PublishJob; nothing here can force a publish on an unapproved draft.
 */
export const publishContentPostSchema = z.object({
  tenantId: uuid,
  contentPostId: uuid,
  connectionId: uuid,
});
export type PublishContentPostInput = z.infer<typeof publishContentPostSchema>;

/* ---------------------------------- media ----------------------------------- */

/**
 * Registers a media asset. `blobUrl` is NOT a client field: the service uploads
 * through the fail-closed Blob seam and writes the URL it returns. The client
 * supplies the file plus descriptive metadata only.
 */
export const uploadMediaAssetSchema = z.object({
  tenantId: uuid,
  alt: optionalText(200),
  kind: z.enum(MEDIA_ASSET_KINDS).default("IMAGE"),
  file: z.instanceof(File),
});
export type UploadMediaAssetInput = z.infer<typeof uploadMediaAssetSchema>;

export const mediaAssetLocatorSchema = z.object({
  tenantId: uuid,
  mediaAssetId: uuid,
});
export type MediaAssetLocatorInput = z.infer<typeof mediaAssetLocatorSchema>;

export const listMediaAssetsSchema = z.object({
  tenantId: uuid,
  kind: z.enum(MEDIA_ASSET_KINDS).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(50),
});
export type ListMediaAssetsInput = z.infer<typeof listMediaAssetsSchema>;

/* -------------------------------- analytics --------------------------------- */

export const marketingAnalyticsSchema = z.object({
  tenantId: uuid,
  campaignId: uuid.optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
export type MarketingAnalyticsInput = z.infer<typeof marketingAnalyticsSchema>;
