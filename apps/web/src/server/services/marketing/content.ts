import { Prisma, type ContentPostStatus } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import {
  PUBLISH_MAX_ATTEMPTS,
  PUBLISH_RETRY_LADDER_MS,
  type SocialErrorClass,
} from "@amisibiz/integrations";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { buildAdapterForRow } from "@/server/services/integrations/connections";
import {
  SOCIAL_AUDIT_ACTIONS,
  SocialServiceError,
} from "@/server/services/integrations/errors";
import type {
  CreateContentPostInput,
  ListContentPostsInput,
  ReviewContentPostInput,
  UpdateContentPostInput,
} from "@/lib/validations/marketing";

/**
 * Content posts + the publish ladder (AGENT 03 module B — `content.ts`).
 *
 * This file enforces the draft/publish SPLIT the design locks in:
 *
 *  - A `ContentPost` is the DRAFT half. It walks DRAFT → IN_REVIEW →
 *    APPROVED/REJECTED → SCHEDULED through typed operations only; `status`,
 *    `approvedById`/`approvedAt`, `aiDraft` and `createdById` are never client
 *    fields (the schemas strip them and this file sets them server-side).
 *  - A `PublishJob` is an ATTEMPT, created ONLY from an APPROVED or SCHEDULED
 *    post against a CONNECTED connection. `publishPost` on an unapproved draft
 *    or a disconnected channel is refused — no job exists, so a draft can never
 *    be "published".
 *  - The RETRY LADDER is 1m / 5m / 25m / 2h / 6h (maxAttempts 5) then ABANDONED,
 *    read from the SAME constants the adapters document
 *    (`PUBLISH_RETRY_LADDER_MS` / `PUBLISH_MAX_ATTEMPTS`). An AUTH-class failure
 *    stops the ladder IMMEDIATELY (ABANDONED): a revoked credential must not be
 *    retried into the provider.
 *  - HONESTY OF PUBLISH: a `ContentPost` flips to PUBLISHED ONLY when a job
 *    returns a VERIFIED, provider-sourced reference. A mock (isLive:false) or an
 *    unconfigured connection physically cannot produce that, so the post lands
 *    PUBLISH_FAILED and the job is ABANDONED with a sanitised error class. The
 *    provider reference is never fabricated.
 *
 * There is no scheduler/cron in this build ("no cron", design §0): each call
 * performs ONE attempt; the queue UI (Phase 3) drives subsequent ladder steps by
 * calling `runPublishAttempt` when a job's `nextRetryAt` has passed. The ladder
 * schedule itself is fully computed here so the retry timing is a rule, not a
 * guess.
 */

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export type ContentPostRow = Prisma.ContentPostGetPayload<
  Record<string, never>
>;
export type PublishJobRow = Prisma.PublishJobGetPayload<Record<string, never>>;

/* ------------------------------- content CRUD ------------------------------- */

export async function createContentPost(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreateContentPostInput, "tenantId">,
): Promise<ContentPostRow> {
  if (input.campaignId) {
    await assertCampaignInTenant(authz, input.campaignId);
  }
  const mediaIds = await resolveMediaAssetIds(authz, input.mediaAssetIds);

  const created = await prisma.contentPost.create({
    data: {
      tenantId: authz.tenantId,
      campaignId: input.campaignId ?? null,
      channel: input.channel,
      kind: input.kind,
      title: text(input.title),
      body: input.body.trim(),
      mediaAssetIds: mediaIds as unknown as Prisma.InputJsonValue,
      // DRAFT by column default; approval/provenance/author are server-set.
      aiDraft: false,
      createdById: actorId,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    },
  });

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONTENT_POST_CREATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "ContentPost",
    resourceId: created.id,
    metadata: {
      channel: created.channel,
      kind: created.kind,
      status: created.status,
    },
  });

  return created;
}

export async function updateContentPost(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<UpdateContentPostInput, "tenantId">,
): Promise<ContentPostRow> {
  const post = await loadPost(authz, input.contentPostId);
  // Only a DRAFT is editable; once it is in review it must be pulled back
  // explicitly (no silent edit of an under-review or approved artefact).
  if (post.status !== "DRAFT" && post.status !== "REJECTED") {
    throw new SocialServiceError(
      "CONFLICT",
      "Only a draft or a rejected post can be edited.",
    );
  }
  if (input.campaignId) {
    await assertCampaignInTenant(authz, input.campaignId);
  }

  const data: Prisma.ContentPostUpdateInput = {};
  if (input.campaignId !== undefined) {
    // The checked update input has no `campaignId` scalar: linking goes
    // through the nested relation (`connect` / `disconnect`).
    data.campaign =
      input.campaignId === null
        ? { disconnect: true }
        : { connect: { id: input.campaignId } };
  }
  if (input.channel !== undefined) data.channel = input.channel;
  if (input.kind !== undefined) data.kind = input.kind;
  if (input.title !== undefined) data.title = text(input.title);
  if (input.body !== undefined) data.body = input.body.trim();
  if (input.mediaAssetIds !== undefined) {
    data.mediaAssetIds = (await resolveMediaAssetIds(
      authz,
      input.mediaAssetIds,
    )) as unknown as Prisma.InputJsonValue;
  }
  if (input.scheduledFor !== undefined) {
    data.scheduledFor = input.scheduledFor ?? null;
  }
  // Editing a rejected post returns it to DRAFT so it can re-enter review.
  if (post.status === "REJECTED") data.status = "DRAFT";

  const result = await prisma.contentPost.updateMany({
    where: { id: input.contentPostId, tenantId: authz.tenantId },
    data,
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Content post not found.");
  }
  return loadPost(authz, input.contentPostId);
}

/* ------------------------------ review lifecycle ---------------------------- */

/** DRAFT → IN_REVIEW. */
export async function submitForReview(
  authz: TenantAuthzContext,
  actorId: string,
  contentPostId: string,
): Promise<ContentPostRow> {
  const post = await loadPost(authz, contentPostId);
  if (post.status !== "DRAFT") {
    throw new SocialServiceError(
      "CONFLICT",
      "Only a draft can be submitted for review.",
    );
  }
  const result = await prisma.contentPost.updateMany({
    where: { id: contentPostId, tenantId: authz.tenantId },
    data: { status: "IN_REVIEW" },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Content post not found.");
  }
  return loadPost(authz, contentPostId);
}

/**
 * IN_REVIEW → APPROVED | REJECTED. `approvedById`/`approvedAt` are stamped from
 * the actor; a REJECT records no approval and keeps the reason out of the row
 * (audit metadata only, ids/enums — the reason text lives in the audit).
 */
export async function reviewContentPost(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<ReviewContentPostInput, "tenantId">,
): Promise<ContentPostRow> {
  const post = await loadPost(authz, input.contentPostId);
  if (post.status !== "IN_REVIEW") {
    throw new SocialServiceError(
      "CONFLICT",
      "Only a post in review can be approved or rejected.",
    );
  }
  const to: ContentPostStatus =
    input.decision === "APPROVE" ? "APPROVED" : "REJECTED";

  const result = await prisma.contentPost.updateMany({
    where: { id: input.contentPostId, tenantId: authz.tenantId },
    data:
      to === "APPROVED"
        ? { status: "APPROVED", approvedById: actorId, approvedAt: new Date() }
        : { status: "REJECTED", approvedById: null, approvedAt: null },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Content post not found.");
  }

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONTENT_POST_REVIEWED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "ContentPost",
    resourceId: input.contentPostId,
    metadata: { from: post.status, to },
  });

  return loadPost(authz, input.contentPostId);
}

/** APPROVED → SCHEDULED with a future time. */
export async function scheduleContentPost(
  authz: TenantAuthzContext,
  actorId: string,
  contentPostId: string,
  scheduledFor: Date,
): Promise<ContentPostRow> {
  const post = await loadPost(authz, contentPostId);
  if (post.status !== "APPROVED" && post.status !== "SCHEDULED") {
    throw new SocialServiceError(
      "CONFLICT",
      "Only an approved post can be scheduled.",
    );
  }
  if (scheduledFor.getTime() <= Date.now()) {
    throw new SocialServiceError(
      "VALIDATION",
      "A scheduled time must be in the future.",
      "scheduledFor",
    );
  }
  const result = await prisma.contentPost.updateMany({
    where: { id: contentPostId, tenantId: authz.tenantId },
    data: { status: "SCHEDULED", scheduledFor },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Content post not found.");
  }

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONTENT_POST_SCHEDULED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "ContentPost",
    resourceId: contentPostId,
    metadata: {},
  });

  return loadPost(authz, contentPostId);
}

/* --------------------------------- publishing -------------------------------- */

/**
 * Create a QUEUED PublishJob and run the FIRST attempt, ONLY from an APPROVED
 * or SCHEDULED post against a CONNECTED connection. The gate is checked before
 * any job row exists, so an unapproved draft can never be published.
 */
export async function publishContentPost(
  authz: TenantAuthzContext,
  actorId: string,
  contentPostId: string,
  connectionId: string,
): Promise<PublishJobRow> {
  const post = await loadPost(authz, contentPostId);
  if (post.status !== "APPROVED" && post.status !== "SCHEDULED") {
    throw new SocialServiceError(
      "CONFLICT",
      "Only an approved or scheduled post can be published.",
    );
  }

  const connection = await prisma.integrationConnection.findFirst({
    where: { id: connectionId, tenantId: authz.tenantId },
  });
  if (!connection) {
    throw new SocialServiceError(
      "VALIDATION",
      "The selected channel is not connected to this business.",
      "connectionId",
    );
  }
  if (connection.status !== "CONNECTED") {
    throw new SocialServiceError(
      "PROVIDER_UNAVAILABLE",
      "The channel is not connected right now. Reconnect and verify it before publishing.",
      "connectionId",
    );
  }

  const job = await prisma.publishJob.create({
    data: {
      tenantId: authz.tenantId,
      contentPostId,
      connectionId,
      attempt: 1,
      maxAttempts: PUBLISH_MAX_ATTEMPTS,
      status: "QUEUED",
      nextRetryAt: new Date(),
    },
  });

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.PUBLISH_JOB_QUEUED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "PublishJob",
    resourceId: job.id,
    metadata: { contentPostId, connectionId, attempt: 1 },
  });

  return runPublishAttempt(job.id);
}

/**
 * Execute one attempt for a QUEUED/FAILED-with-nextRetry job and settle the
 * honest outcome. Extracted so the Phase 3 queue worker can drive ladder steps
 * by re-invoking it once `nextRetryAt` has passed.
 */
export async function runPublishAttempt(jobId: string): Promise<PublishJobRow> {
  const job = await prisma.publishJob.findFirst({ where: { id: jobId } });
  if (!job) {
    throw new SocialServiceError("NOT_FOUND", "Publish job not found.");
  }
  const post = await loadPostById(job.contentPostId, job.tenantId);
  const connection = await prisma.integrationConnection.findFirst({
    where: { id: job.connectionId },
  });
  if (!connection) {
    return failAttempt(job, "AUTH", "The channel no longer exists.");
  }

  const mediaUrls = await mediaUrlsForPost(post);
  const { adapter, configured } = buildAdapterForRow(connection);

  // An unconfigured/disconnected channel is an AUTH-class stop: never hammer it,
  // and never pretend a mock published anything.
  if (!configured) {
    return failAttempt(job, "AUTH", "The channel credential is unavailable.");
  }

  const outcome = await adapter.publishPost(post.body, mediaUrls);

  if (outcome.status === "verified") {
    const ref = outcome.reference;
    const updated = await prisma.publishJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        providerRef: ref,
        startedAt: job.startedAt ?? new Date(),
        finishedAt: new Date(),
        nextRetryAt: null,
        errorClass: null,
        errorDetail: null,
      },
    });
    // ONLY a verified provider reference flips the draft to PUBLISHED.
    await prisma.contentPost.updateMany({
      where: { id: post.id, tenantId: job.tenantId },
      data: { status: "PUBLISHED" },
    });
    return updated;
  }

  // Not verified: classify the refusal and walk the ladder honestly.
  const errorClass = classFromOutcome(outcome.status);
  return failAttempt(job, errorClass, detailFromOutcome(outcome));
}

/**
 * Record a FAILED attempt: an AUTH failure abandons immediately; otherwise the
 * job either schedules the next ladder step or, at the last attempt, is
 * ABANDONED and the post marked PUBLISH_FAILED.
 */
async function failAttempt(
  job: PublishJobRow,
  errorClass: SocialErrorClass,
  detail: string,
): Promise<PublishJobRow> {
  const sanitised = sanitizeDetail(detail);
  const abandon = errorClass === "AUTH" || job.attempt >= job.maxAttempts;

  if (abandon) {
    const updated = await prisma.publishJob.update({
      where: { id: job.id },
      data: {
        status: "ABANDONED",
        errorClass,
        errorDetail: sanitised,
        nextRetryAt: null,
        startedAt: job.startedAt ?? new Date(),
        finishedAt: new Date(),
      },
    });
    // Never a silent PUBLISHED: an abandoned attempt leaves the draft failed.
    await prisma.contentPost.updateMany({
      where: { id: job.contentPostId, tenantId: job.tenantId },
      data: { status: "PUBLISH_FAILED" },
    });
    return updated;
  }

  const rung = PUBLISH_RETRY_LADDER_MS[job.attempt - 1];
  const lastRung = PUBLISH_RETRY_LADDER_MS[PUBLISH_RETRY_LADDER_MS.length - 1];
  const delay = rung ?? lastRung;
  if (delay === undefined) {
    // Unreachable for the shipped ladder (a non-empty module constant), but
    // fail closed rather than fabricating a retry timestamp from nothing.
    throw new SocialServiceError(
      "PROVIDER_UNAVAILABLE",
      "The publish retry ladder is misconfigured, so no next attempt can be scheduled.",
    );
  }
  const nextAttempt = job.attempt + 1;
  const updated = await prisma.publishJob.update({
    where: { id: job.id },
    data: {
      status: "FAILED",
      errorClass,
      errorDetail: sanitised,
      startedAt: job.startedAt ?? new Date(),
      finishedAt: new Date(),
      nextRetryAt: new Date(Date.now() + delay),
    },
  });

  // Queue the NEXT ladder rung as a fresh attempt row (attempt+1), so the ladder
  // is materialised and visible rather than implicit.
  await prisma.publishJob.create({
    data: {
      tenantId: job.tenantId,
      contentPostId: job.contentPostId,
      connectionId: job.connectionId,
      attempt: nextAttempt,
      maxAttempts: job.maxAttempts,
      status: "QUEUED",
      nextRetryAt: new Date(Date.now() + delay),
    },
  });

  return updated;
}

function classFromOutcome(status: string): SocialErrorClass {
  // The mock returns `unverified`; an unconfigured adapter returns `failed`.
  // Neither is a provider fact, and both mean "we cannot publish": treat the
  // mock/unconfigured case as AUTH (stop the ladder — do not hammer), a real
  // provider refusal is already handled by the verified/failed branch above.
  if (status === "unverified") return "AUTH";
  return "NETWORK";
}

function detailFromOutcome(outcome: {
  status: string;
  reason?: string;
  detail?: string;
}): string {
  return outcome.detail ?? outcome.reason ?? "publish not confirmed";
}

/** Strip a bounded, credential-free detail from a provider message. */
function sanitizeDetail(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/* ---------------------------------- reads ----------------------------------- */

export async function listContentPosts(
  authz: TenantAuthzContext,
  query: Omit<ListContentPostsInput, "tenantId">,
): Promise<{ posts: ContentPostRow[]; total: number }> {
  const where: Prisma.ContentPostWhereInput = {
    tenantId: authz.tenantId,
    ...(query.campaignId ? { campaignId: query.campaignId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
  };
  const [posts, total] = await Promise.all([
    prisma.contentPost.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.contentPost.count({ where }),
  ]);
  return { posts, total };
}

/** Single content post, tenant-pinned. The detail drawer's read path. */
export async function getContentPost(
  authz: TenantAuthzContext,
  contentPostId: string,
): Promise<ContentPostRow> {
  return loadPost(authz, contentPostId);
}

/* ---------------------------------- helpers --------------------------------- */

async function loadPost(
  authz: TenantAuthzContext,
  contentPostId: string,
): Promise<ContentPostRow> {
  const post = await prisma.contentPost.findFirst({
    where: { id: contentPostId, tenantId: authz.tenantId },
  });
  if (!post) {
    throw new SocialServiceError("NOT_FOUND", "Content post not found.");
  }
  return post;
}

async function loadPostById(
  contentPostId: string,
  tenantId: string,
): Promise<ContentPostRow> {
  const post = await prisma.contentPost.findFirst({
    where: { id: contentPostId, tenantId },
  });
  if (!post) {
    throw new SocialServiceError("NOT_FOUND", "Content post not found.");
  }
  return post;
}

async function assertCampaignInTenant(
  authz: TenantAuthzContext,
  campaignId: string,
): Promise<void> {
  const campaign = await prisma.marketingCampaign.findFirst({
    where: { id: campaignId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!campaign) {
    throw new SocialServiceError(
      "VALIDATION",
      "The selected campaign does not exist in this business.",
      "campaignId",
    );
  }
}

/**
 * Validate a proposed list of media asset ids against the tenant and return the
 * accepted subset (a forged id from another workspace resolves to nothing and
 * is dropped, never linked).
 */
async function resolveMediaAssetIds(
  authz: TenantAuthzContext,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = await prisma.mediaAsset.findMany({
    where: { id: { in: [...ids] }, tenantId: authz.tenantId },
    select: { id: true },
  });
  return found.map((asset) => asset.id);
}

/** Resolve a post's stored media ids to their blob URLs (publish inputs). */
async function mediaUrlsForPost(post: ContentPostRow): Promise<string[]> {
  const ids = Array.isArray(post.mediaAssetIds)
    ? (post.mediaAssetIds as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  if (ids.length === 0) return [];
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: ids }, tenantId: post.tenantId },
    select: { blobUrl: true },
  });
  return assets.map((asset) => asset.blobUrl);
}
