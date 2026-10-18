"use server";

import { requireAuth } from "@/lib/auth/helpers";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  authorizeTenant,
  AuthorizationError,
} from "@/server/auth/authorization";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  campaignLocatorSchema,
  contentPostLocatorSchema,
  createCampaignSchema,
  createContentPostSchema,
  listCampaignsSchema,
  listContentPostsSchema,
  listMediaAssetsSchema,
  marketingAnalyticsSchema,
  mediaAssetLocatorSchema,
  publishContentPostSchema,
  reviewContentPostSchema,
  scheduleContentPostSchema,
  submitContentPostForReviewSchema,
  updateCampaignSchema,
  updateContentPostSchema,
  uploadMediaAssetSchema,
} from "@/lib/validations/marketing";
import {
  activateCampaign,
  archiveCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  updateCampaign,
  type CampaignRow,
} from "@/server/services/marketing/campaigns";
import {
  createContentPost,
  getContentPost,
  listContentPosts,
  publishContentPost,
  reviewContentPost,
  scheduleContentPost,
  submitForReview,
  updateContentPost,
  type ContentPostRow,
  type PublishJobRow,
} from "@/server/services/marketing/content";
import {
  deleteMediaAsset,
  listMediaAssets,
  uploadMediaAsset,
  type MediaAssetRow,
} from "@/server/services/marketing/media";
import { marketingFunnelCounts } from "@/server/services/marketing/events";
import {
  socialErrorActionCode,
  SocialServiceError,
} from "@/server/services/integrations/errors";

/**
 * Marketing Server Actions (AGENT 03 module C — campaigns, content, publish,
 * media, analytics).
 *
 * Same pipeline as `actions/lead.ts`: authenticate → validate (every server-owned
 * field is stripped by the schema — forged `tenantId`, ids, `status` on create,
 * `approvedById`/`approvedAt`, `aiDraft` provenance, `providerRef`, a `blobUrl`,
 * `viewCount`) → `authorizeTenant` with the verb-specific permission → delegate
 * to the marketing services, which take the authorized context and never a
 * client `tenantId`.
 *
 * Permission wiring:
 *  - campaigns / posts / media list & detail → MARKETING_READ
 *  - campaign & post create/edit/lifecycle (draft → review → schedule), media
 *    upload/delete → MARKETING_MANAGE
 *  - APPROVE/REJECT a post and request a PUBLISH attempt → MARKETING_PUBLISH,
 *    the distinct verb the reviewer/publisher split hinges on. A publish can
 *    ONLY start from an APPROVED/SCHEDULED post against a CONNECTED channel and
 *    is settled honestly inside the service (verified ⇒ PUBLISHED, else FAILED
 *    /ABANDONED on the ladder) — no action here can force a fabricated publish.
 *  - funnel analytics → ANALYTICS_READ.
 */

function marketingActionFailure(
  error: unknown,
  context: string,
): ActionResult<never> {
  if (error instanceof SocialServiceError) {
    return fail(error.message, {
      code: socialErrorActionCode(error.code),
      ...(error.field
        ? { fieldErrors: { [error.field]: [error.message] } }
        : {}),
    });
  }
  if (error instanceof AuthorizationError) {
    return authorizationFailure(error, context);
  }
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again later.", {
    code: "INTERNAL",
  });
}

/* -------------------------------- campaigns --------------------------------- */

export async function createCampaignAction(
  rawInput: unknown,
): Promise<ActionResult<{ campaign: CampaignRow }>> {
  const session = await requireAuth();

  const parsed = createCampaignSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "createCampaignAction");
  }

  try {
    const campaign = await createCampaign(context, session.user.id, data);
    return { success: true, data: { campaign } };
  } catch (err) {
    return marketingActionFailure(err, "createCampaignAction");
  }
}

export async function updateCampaignAction(
  rawInput: unknown,
): Promise<ActionResult<{ campaign: CampaignRow }>> {
  const session = await requireAuth();

  const parsed = updateCampaignSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateCampaignAction");
  }

  try {
    const campaign = await updateCampaign(context, session.user.id, data);
    return { success: true, data: { campaign } };
  } catch (err) {
    return marketingActionFailure(err, "updateCampaignAction");
  }
}

export async function activateCampaignAction(
  rawInput: unknown,
): Promise<ActionResult<{ campaign: CampaignRow }>> {
  const session = await requireAuth();

  const parsed = campaignLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, campaignId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "activateCampaignAction");
  }

  try {
    const campaign = await activateCampaign(
      context,
      session.user.id,
      campaignId,
    );
    return { success: true, data: { campaign } };
  } catch (err) {
    return marketingActionFailure(err, "activateCampaignAction");
  }
}

export async function pauseCampaignAction(
  rawInput: unknown,
): Promise<ActionResult<{ campaign: CampaignRow }>> {
  const session = await requireAuth();

  const parsed = campaignLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, campaignId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "pauseCampaignAction");
  }

  try {
    const campaign = await pauseCampaign(context, session.user.id, campaignId);
    return { success: true, data: { campaign } };
  } catch (err) {
    return marketingActionFailure(err, "pauseCampaignAction");
  }
}

export async function archiveCampaignAction(
  rawInput: unknown,
): Promise<ActionResult<{ campaign: CampaignRow }>> {
  const session = await requireAuth();

  const parsed = campaignLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, campaignId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "archiveCampaignAction");
  }

  try {
    const campaign = await archiveCampaign(
      context,
      session.user.id,
      campaignId,
    );
    return { success: true, data: { campaign } };
  } catch (err) {
    return marketingActionFailure(err, "archiveCampaignAction");
  }
}

export async function listCampaignsAction(rawInput: unknown): Promise<
  ActionResult<{
    campaigns: CampaignRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = listCampaignsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "listCampaignsAction");
  }

  try {
    const { campaigns, total } = await listCampaigns(context, query);
    return {
      success: true,
      data: {
        campaigns,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    return marketingActionFailure(err, "listCampaignsAction");
  }
}

export async function getCampaignAction(
  rawInput: unknown,
): Promise<ActionResult<{ campaign: CampaignRow }>> {
  const session = await requireAuth();

  const parsed = campaignLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      parsed.data.tenantId,
      PERMISSIONS.MARKETING_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getCampaignAction");
  }

  try {
    const campaign = await getCampaign(context, parsed.data.campaignId);
    return { success: true, data: { campaign } };
  } catch (err) {
    return marketingActionFailure(err, "getCampaignAction");
  }
}

/* ------------------------------ content posts ------------------------------- */

export async function createContentPostAction(
  rawInput: unknown,
): Promise<ActionResult<{ post: ContentPostRow }>> {
  const session = await requireAuth();

  const parsed = createContentPostSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "createContentPostAction");
  }

  try {
    const post = await createContentPost(context, session.user.id, data);
    return { success: true, data: { post } };
  } catch (err) {
    return marketingActionFailure(err, "createContentPostAction");
  }
}

export async function updateContentPostAction(
  rawInput: unknown,
): Promise<ActionResult<{ post: ContentPostRow }>> {
  const session = await requireAuth();

  const parsed = updateContentPostSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateContentPostAction");
  }

  try {
    const post = await updateContentPost(context, session.user.id, data);
    return { success: true, data: { post } };
  } catch (err) {
    return marketingActionFailure(err, "updateContentPostAction");
  }
}

export async function submitContentPostForReviewAction(
  rawInput: unknown,
): Promise<ActionResult<{ post: ContentPostRow }>> {
  const session = await requireAuth();

  const parsed = submitContentPostForReviewSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, contentPostId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "submitContentPostForReviewAction");
  }

  try {
    const post = await submitForReview(context, session.user.id, contentPostId);
    return { success: true, data: { post } };
  } catch (err) {
    return marketingActionFailure(err, "submitContentPostForReviewAction");
  }
}

/**
 * APPROVE / REJECT — the gated MARKETING_PUBLISH verb. `approvedById`/
 * `approvedAt` are stamped from the actor inside the service; a client can never
 * pre-approve its own draft or forge the reviewer identity.
 */
export async function reviewContentPostAction(
  rawInput: unknown,
): Promise<ActionResult<{ post: ContentPostRow }>> {
  const session = await requireAuth();

  const parsed = reviewContentPostSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_PUBLISH,
    );
  } catch (err) {
    return authorizationFailure(err, "reviewContentPostAction");
  }

  try {
    const post = await reviewContentPost(context, session.user.id, data);
    return { success: true, data: { post } };
  } catch (err) {
    return marketingActionFailure(err, "reviewContentPostAction");
  }
}

export async function scheduleContentPostAction(
  rawInput: unknown,
): Promise<ActionResult<{ post: ContentPostRow }>> {
  const session = await requireAuth();

  const parsed = scheduleContentPostSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, contentPostId, scheduledFor } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "scheduleContentPostAction");
  }

  try {
    const post = await scheduleContentPost(
      context,
      session.user.id,
      contentPostId,
      scheduledFor,
    );
    return { success: true, data: { post } };
  } catch (err) {
    return marketingActionFailure(err, "scheduleContentPostAction");
  }
}

/**
 * Request a publish ATTEMPT. The service refuses unless the post is
 * APPROVED/SCHEDULED and the channel is CONNECTED, then creates a QUEUED job and
 * runs the first attempt. The returned job status is the honest outcome (a mock
 * or unconfigured channel yields FAILED/ABANDONED + PUBLISH_FAILED, never
 * SUCCEEDED).
 */
export async function publishContentPostAction(
  rawInput: unknown,
): Promise<ActionResult<{ job: PublishJobRow }>> {
  const session = await requireAuth();

  const parsed = publishContentPostSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, contentPostId, connectionId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_PUBLISH,
    );
  } catch (err) {
    return authorizationFailure(err, "publishContentPostAction");
  }

  try {
    const job = await publishContentPost(
      context,
      session.user.id,
      contentPostId,
      connectionId,
    );
    return { success: true, data: { job } };
  } catch (err) {
    return marketingActionFailure(err, "publishContentPostAction");
  }
}

export async function listContentPostsAction(rawInput: unknown): Promise<
  ActionResult<{
    posts: ContentPostRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = listContentPostsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "listContentPostsAction");
  }

  try {
    const { posts, total } = await listContentPosts(context, query);
    return {
      success: true,
      data: {
        posts,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    return marketingActionFailure(err, "listContentPostsAction");
  }
}

export async function getContentPostAction(
  rawInput: unknown,
): Promise<ActionResult<{ post: ContentPostRow }>> {
  const session = await requireAuth();

  const parsed = contentPostLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      parsed.data.tenantId,
      PERMISSIONS.MARKETING_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getContentPostAction");
  }

  try {
    const post = await getContentPost(context, parsed.data.contentPostId);
    return { success: true, data: { post } };
  } catch (err) {
    return marketingActionFailure(err, "getContentPostAction");
  }
}

/* ---------------------------------- media ----------------------------------- */

export async function uploadMediaAssetAction(
  rawInput: unknown,
): Promise<ActionResult<{ asset: MediaAssetRow }>> {
  const session = await requireAuth();

  const parsed = uploadMediaAssetSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid media upload.");
  }

  const { tenantId, file, alt, kind } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "uploadMediaAssetAction");
  }

  try {
    // `blobUrl` is produced ONLY by the fail-closed Blob seam inside the
    // service; the payload carries a file + descriptive metadata and nothing
    // that can name a storage location.
    const asset = await uploadMediaAsset(context, session.user.id, {
      file,
      alt: alt ?? null,
      kind,
    });
    return { success: true, data: { asset } };
  } catch (err) {
    return marketingActionFailure(err, "uploadMediaAssetAction");
  }
}

export async function deleteMediaAssetAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = mediaAssetLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, mediaAssetId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "deleteMediaAssetAction");
  }

  try {
    await deleteMediaAsset(context, session.user.id, mediaAssetId);
    return { success: true };
  } catch (err) {
    return marketingActionFailure(err, "deleteMediaAssetAction");
  }
}

export async function listMediaAssetsAction(rawInput: unknown): Promise<
  ActionResult<{
    assets: MediaAssetRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = listMediaAssetsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.MARKETING_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "listMediaAssetsAction");
  }

  try {
    // exactOptionalPropertyTypes: `kind` is only passed when present, never as
    // an explicit `undefined` (the service types it as `kind?: "IMAGE" | "VIDEO"`).
    const { assets, total } = await listMediaAssets(context, {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
    });
    return {
      success: true,
      data: {
        assets,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    return marketingActionFailure(err, "listMediaAssetsAction");
  }
}

/* -------------------------------- analytics --------------------------------- */

export async function getMarketingAnalyticsAction(
  rawInput: unknown,
): Promise<ActionResult<{ counts: Record<string, number> }>> {
  const session = await requireAuth();

  const parsed = marketingAnalyticsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid analytics query.");
  }

  const { tenantId, campaignId, from, to } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ANALYTICS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getMarketingAnalyticsAction");
  }

  try {
    const counts = await marketingFunnelCounts(
      context,
      { from, to },
      campaignId,
    );
    return { success: true, data: { counts } };
  } catch (err) {
    return marketingActionFailure(err, "getMarketingAnalyticsAction");
  }
}
