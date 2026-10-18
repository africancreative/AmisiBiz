-- Migration: AGENT 03 (Phase 1, data layer) — social commerce & marketing:
-- integration connections & webhook ingestion, the shared inbox
-- (conversations/messages/notes/labels/quick replies), the append-only
-- marketing event stream, campaigns, the draft/publish split (ContentPost +
-- PublishJob), the media library, the ShareLink -> campaign pointer, the
-- permission catalogue delta (74 -> 83), RLS over every new tenant table, and
-- the runtime grants.
-- Created: 2026-11-01
--
-- Basis: docs/implementation/orchestration/agent-03-design.md §2 (design
-- locked 2026-10-18). Phase 1 is the DATA layer only: schema, RLS, grants and
-- the permission seed. No API route, no webhook handler, no provider call and
-- no SECURITY DEFINER ingestion function live here — those are Phase 2. Where
-- Phase 1 must leave a documented seam for Phase 2, it does so with an inline
-- comment.
--
-- Rules this file keeps, copied verbatim in shape from the chain it extends
-- (20261031000001_agent02_crm_commerce is the closest precedent):
--   * Additive-only. Nothing here edits a committed migration or drops an
--     existing object; the single existing-table touch is an additive
--     `ShareLink.campaignId` column plus its index and FK.
--   * Every new tenant table: ENABLE ROW LEVEL SECURITY + the 4-policy
--     app_read/insert/update/delete DO-loop keyed on "tenantId" via
--     has_tenant_read_access / has_tenant_write_access (20261018000002 §4), an
--     explicit verb grant to `amisibiz_app` (no default privileges exist there
--     any more), and an entry in the successor anon/authenticated revoke block.
--     FORCE RLS is not used anywhere (the same acknowledged posture the rest of
--     the chain carries; the harness connects as the table owner only to build
--     fixtures).
--   * The one two-parent junction (`ConversationLabel`) carries its own
--     tenantId for the RLS template AND a single-tenant match trigger
--     (contact_tag_is_single_tenant shape). The remaining tables are
--     tenantId + parent-FK children that the AGENT 02 chain deliberately left
--     to RLS + FK (Lead/Task/ActivityEvent/ShareLink carry no match trigger),
--     so they follow that precedent and gain no trigger here.
--   * Append-only tables raise from a BEFORE UPDATE OR DELETE trigger
--     (activity_event_is_append_only shape) and hold SELECT (+ INSERT) only.
--   * Functional/partial indexes Prisma cannot express are added in raw SQL and
--     are invisible to the datamodel; the migrate-diff gate tolerates them
--     exactly as it tolerates tag_one_name_per_tenant_case_insensitive and the
--     document/share_link partial uniques already in the chain.
--   * No secret material appears in this file. `credentialCiphertext` is a
--     `bytea` column holding AES-256-GCM output keyed on the `INTEGRATION_SECRET`
--     ENVIRONMENT variable; that key never enters the database, and the API
--     surface (Phase 2) exposes neither the ciphertext nor the raw token. Only
--     the KEY NAME is referenced, in comments, never a value.
--   * Permission seeding is idempotent (ON CONFLICT DO NOTHING) with exact-count
--     ASSERTs in-migration (H1 / AGENT 02 §9 pattern). The numbers below are
--     generated from packages/auth/src/permissions.ts, not hand-written: 9 new
--     tenant keys, 30 new matrix rows, totals 83 and 218, per-tenant-role counts
--     57/57/32/17/23/15 (OWNER/ADMIN/SALES/FINANCE/OPERATIONS/VIEWER). No
--     platform-domain key is added, so SUPER_ADMIN/SUPPORT gain nothing and the
--     committed 20261031000001 assert of 74/188 stays true against the DB it
--     built; only THIS migration asserts the new 83/218 totals.

-- ─── 1. Enums ─────────────────────────────────────────────────────────────────
-- The fifteen AGENT 03 enums, values exactly as schema.prisma declares them and
-- in the same member order (Prisma's generated type and the datamodel diff both
-- key on membership, not order, but the order is kept stable for readability).
-- `ConversationChannel` is deliberately distinct from `IntegrationProvider`: a
-- META_FB_PAGE connection can carry both a Page post and a Messenger thread.

CREATE TYPE "public"."IntegrationProvider" AS ENUM (
    'META_WHATSAPP', 'META_FB_PAGE', 'META_INSTAGRAM'
);

CREATE TYPE "public"."ConnectionStatus" AS ENUM (
    'UNVERIFIED', 'PENDING_VERIFICATION', 'CONNECTED', 'DISCONNECTED', 'ERROR'
);

CREATE TYPE "public"."WebhookRoutingStatus" AS ENUM (
    'PARKED', 'APPLIED', 'IGNORED'
);

CREATE TYPE "public"."ConversationChannel" AS ENUM (
    'WHATSAPP', 'MESSENGER', 'INSTAGRAM'
);

CREATE TYPE "public"."ConversationStatus" AS ENUM (
    'OPEN', 'PENDING', 'CLOSED'
);

CREATE TYPE "public"."MessageDirection" AS ENUM (
    'INBOUND', 'OUTBOUND'
);

CREATE TYPE "public"."MessageStatus" AS ENUM (
    'SENT', 'DELIVERED', 'READ', 'FAILED'
);

CREATE TYPE "public"."MarketingEventType" AS ENUM (
    'CAMPAIGN_LINK_CLICK', 'PRODUCT_PAGE_VIEW', 'ENQUIRY_SUBMITTED', 'LEAD_CREATED',
    'QUOTATION_ACCEPTED', 'ORDER_CREATED', 'PAYMENT_VERIFIED', 'ORDER_FULFILLED'
);

CREATE TYPE "public"."CampaignStatus" AS ENUM (
    'DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'
);

CREATE TYPE "public"."ContentPostChannel" AS ENUM (
    'FACEBOOK_PAGE', 'INSTAGRAM'
);

CREATE TYPE "public"."ContentKind" AS ENUM (
    'POST', 'STORY', 'REEL'
);

CREATE TYPE "public"."ContentPostStatus" AS ENUM (
    'DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'PUBLISH_FAILED'
);

CREATE TYPE "public"."PublishJobStatus" AS ENUM (
    'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED'
);

CREATE TYPE "public"."PublishErrorClass" AS ENUM (
    'AUTH', 'RATE_LIMIT', 'PERMISSION', 'CONTENT', 'NETWORK', 'UNKNOWN'
);

CREATE TYPE "public"."MediaAssetKind" AS ENUM (
    'IMAGE', 'VIDEO'
);

-- ─── 2. Additive existing-table changes ───────────────────────────────────────
-- ShareLink gains a structured campaign grouping pointer. The design's AGENT 02
-- note called Campaign "AGENT 04 territory"; the AGENT 03 directive grants the
-- campaign entity here, so the link that was left open is closed. Nullable +
-- SetNull: archiving a campaign must never eat an already-distributed link, and
-- the UTM text stays the attribution authority (campaignId is grouping only).
-- The FK is added in §6, after MarketingCampaign exists.

ALTER TABLE "ShareLink" ADD COLUMN "campaignId" UUID;
CREATE INDEX "ShareLink_tenantId_campaignId_idx" ON "ShareLink"("tenantId", "campaignId");

COMMENT ON COLUMN "ShareLink"."campaignId" IS
    'Structured campaign grouping (AGENT 03). UTM text stays the attribution authority; archiving a campaign never revokes a distributed link (SetNull).';

-- ─── 3. New tables ────────────────────────────────────────────────────────────
-- Shapes exactly as `prisma migrate diff` against schema.prisma produces them:
-- UUID ids with gen_random_uuid(), TIMESTAMP(3) WITHOUT TIME ZONE timestamps,
-- DEFAULT CURRENT_TIMESTAMP only on createdAt (@updatedAt columns are written
-- by the application, as everywhere in this chain). Json maps to jsonb, Bytes
-- to bytea, Decimal(18,4) to numeric(18,4).

-- One row per (tenant, provider). Holds the ENCRYPTED credential
-- (`credentialCiphertext`, AES-256-GCM keyed on the INTEGRATION_SECRET env —
-- the plaintext access token never touches this column) plus non-secret
-- `credentialMeta` (phone_number_id, page_id, instagram_user_id, expiry, scopes)
-- and a SHA-256 of the webhook verify token (never the raw token, mirroring
-- Invitation.tokenHash). `providerExternalId` is the id a webhook routes on; its
-- global uniqueness is §5's partial index.
CREATE TABLE "IntegrationConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "webhookVerifyTokenHash" TEXT,
    "credentialCiphertext" BYTEA,
    "credentialMeta" JSONB,
    "providerExternalId" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "lastError" JSONB,
    "connectedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- The raw webhook envelope, retained for the audit trail and dedup. `eventId`
-- is required so the (provider, eventId) unique (§4) is Meta's retry spine.
-- `tenantId` is NULL until routed: an authentic-but-unresolvable event PARKs
-- with no tenant.
--   PHASE 2 SEAM: parked rows cannot be claimed by `amisibiz_app` through the
--   §9 RLS policies — the INSERT policy keys on has_tenant_write_access("tenantId")
--   and the UPDATE-from-parked policy keys on has_tenant_write_access of a row
--   whose tenantId is still NULL, neither of which an unauthenticated webhook
--   route can satisfy. The global write/route path is a Phase 2 SECURITY
--   DEFINER ingestion concern, deliberately out of Phase 1 scope.
CREATE TABLE "IntegrationWebhookEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "provider" "IntegrationProvider" NOT NULL,
    "deliveryId" TEXT,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "routingStatus" "WebhookRoutingStatus" NOT NULL DEFAULT 'PARKED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- A customer thread on one channel of one connection. `externalId` is the
-- provider-side conversation key (phone number, PSID, IG-scoped id); the
-- (connectionId, externalId) unique (§4) is how the webhook upsert finds the
-- thread. contactId/leadId are nullable SetNull links into the CRM; a
-- conversation may exist before the contact is known.
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "channel" "ConversationChannel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "contactId" UUID,
    "leadId" UUID,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToUserId" UUID,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- A message in a thread. `connectionId` is denormalised from the conversation
-- so the (connectionId, providerMessageId) idempotent-inbound unique (§4) is
-- expressible in the datamodel; the application keeps the two in the same
-- tenant/connection (Phase 2 write path). `providerMessageId` is NULL for
-- internally-originated messages not yet acknowledged by the provider, and
-- Postgres treats NULLs as distinct, so the unique is effectively partial
-- without a hand-written WHERE. `body` is the provider-native normalized
-- payload; `textPlain` is the searchable/renderable projection.
CREATE TABLE "ConversationMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "providerMessageId" TEXT,
    "body" JSONB NOT NULL,
    "textPlain" TEXT NOT NULL,
    "mediaRefs" JSONB,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "statusAt" TIMESTAMP(3),
    "optOutSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "aiDraft" BOOLEAN NOT NULL DEFAULT false,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- Internal (never-sent) notes on a thread. Kept in their own table — NOT a
-- MessageDirection member — so an internal note can never be rendered as an
-- outbound message.
CREATE TABLE "ConversationNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

-- Tenant inbox label. No @updatedAt column (a label is created and renamed; the
-- chain's Label analogue is create/mutation-only). The plain (tenantId, name)
-- unique below is what the datamodel declares; §5 adds the stricter
-- case-insensitive one the product needs (Tag precedent).
CREATE TABLE "Label" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- Junction carrying its own tenantId for the RLS policy template; §7 adds the
-- trigger proving the tenant matches both its conversation and its label
-- (ContactTag precedent). No id column — the (conversationId, labelId) PK is the
-- identity.
CREATE TABLE "ConversationLabel" (
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "labelId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationLabel_pkey" PRIMARY KEY ("conversationId","labelId")
);

-- A tenant's canned replies. `shortcut` is the trigger token;
-- `aiProvenance` is the provenance seam marking an AI-generated canned reply.
CREATE TABLE "QuickReply" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "aiProvenance" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- Append-only marketing event stream (design §0: its own table, not
-- ActivityEvent — different consent surface, volume and retention). The single
-- `appendMarketingEvent` writer (Phase 2) dedups via (tenantId, eventType,
-- uniqueEventId) with P2002-swallow for retry safety. `contactId` is written
-- ONLY when Contact.marketingConsent is true (server rule, Phase 2); otherwise
-- the event stays de-identified and `consented` records which branch it took.
-- `sourceMeta` holds de-identified referrer/device class only — NEVER an IP.
CREATE TABLE "MarketingEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "eventType" "MarketingEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uniqueEventId" TEXT NOT NULL,
    "shareLinkId" UUID,
    "campaignId" UUID,
    "contactId" UUID,
    "leadId" UUID,
    "documentId" UUID,
    "itemId" UUID,
    "clickId" TEXT,
    "sourceMeta" JSONB,
    "consented" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingEvent_pkey" PRIMARY KEY ("id")
);

-- A marketing campaign: informational budget only (mirrors the Plan
-- informational posture — a budget is never an entitlement or a gate), UTM
-- fields as the attribution authority carried on links, and a lifecycle status.
CREATE TABLE "MarketingCampaign" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "objective" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "budgetCurrency" TEXT NOT NULL DEFAULT 'KES',
    "budgetAmount" DECIMAL(18,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- The DRAFT half of the content lifecycle. A ContentPost walks DRAFT ->
-- IN_REVIEW -> APPROVED/REJECTED -> SCHEDULED; only a verified PublishJob
-- outcome flips it to PUBLISHED in Phase 2 (nothing here claims a live publish,
-- and a draft is never rendered published). `mediaAssetIds` is an ordered JSON
-- array of MediaAsset ids, kept flexible. `aiDraft` is the provenance seam.
CREATE TABLE "ContentPost" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "campaignId" UUID,
    "channel" "ContentPostChannel" NOT NULL,
    "kind" "ContentKind" NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "mediaAssetIds" JSONB,
    "status" "ContentPostStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "aiDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPost_pkey" PRIMARY KEY ("id")
);

-- An ATTEMPT against a provider — separate from the draft on purpose. The
-- retry ladder is 1m/5m/25m/2h/6h (maxAttempts 5) then ABANDONED; an AUTH-class
-- failure stops the ladder immediately (a revoked credential must not be
-- retried into the provider). `providerRef` is set only by a VERIFIED outcome
-- and is the only thing that can mark the post PUBLISHED — never fabricated.
-- `errorDetail` is sanitised: no raw credential, no provider secret.
-- connectionId RESTRICTs so a connection with publish history cannot be deleted
-- out from under the audit trail; disconnecting is a status change, not a delete.
CREATE TABLE "PublishJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "contentPostId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3),
    "status" "PublishJobStatus" NOT NULL DEFAULT 'QUEUED',
    "providerRef" TEXT,
    "errorClass" "PublishErrorClass",
    "errorDetail" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishJob_pkey" PRIMARY KEY ("id")
);

-- The media library. `blobUrl` rides the same Vercel Blob seam as ItemImage
-- (fail-closed without BLOB_READ_WRITE_TOKEN); there is no fake local storage.
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "blobUrl" TEXT NOT NULL,
    "alt" TEXT,
    "kind" "MediaAssetKind" NOT NULL,
    "bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- ─── 4. Indexes and uniques ───────────────────────────────────────────────────
-- Names exactly match Prisma's generated defaults (`<Model>_<cols>_key` for
-- @@unique, `<Model>_<cols>_idx` for @@index) so the migrate-diff gate against
-- the datamodel finds no difference.

CREATE UNIQUE INDEX "IntegrationConnection_tenantId_provider_key" ON "IntegrationConnection"("tenantId", "provider");
CREATE INDEX "IntegrationConnection_tenantId_idx" ON "IntegrationConnection"("tenantId");
CREATE INDEX "IntegrationConnection_tenantId_status_idx" ON "IntegrationConnection"("tenantId", "status");

-- The dedup spine: Meta retries the same eventId for up to 7 days; the non-null
-- eventId makes this a real (not NULLs-distinct) unique.
CREATE UNIQUE INDEX "IntegrationWebhookEvent_provider_eventId_key" ON "IntegrationWebhookEvent"("provider", "eventId");
CREATE INDEX "IntegrationWebhookEvent_tenantId_idx" ON "IntegrationWebhookEvent"("tenantId");
CREATE INDEX "IntegrationWebhookEvent_provider_receivedAt_idx" ON "IntegrationWebhookEvent"("provider", "receivedAt");

CREATE UNIQUE INDEX "Conversation_connectionId_externalId_key" ON "Conversation"("connectionId", "externalId");
CREATE INDEX "Conversation_tenantId_idx" ON "Conversation"("tenantId");
CREATE INDEX "Conversation_tenantId_status_idx" ON "Conversation"("tenantId", "status");
CREATE INDEX "Conversation_tenantId_lastInboundAt_idx" ON "Conversation"("tenantId", "lastInboundAt");
CREATE INDEX "Conversation_tenantId_contactId_idx" ON "Conversation"("tenantId", "contactId");
CREATE INDEX "Conversation_tenantId_assignedToUserId_idx" ON "Conversation"("tenantId", "assignedToUserId");

CREATE UNIQUE INDEX "ConversationMessage_connectionId_providerMessageId_key" ON "ConversationMessage"("connectionId", "providerMessageId");
CREATE INDEX "ConversationMessage_tenantId_idx" ON "ConversationMessage"("tenantId");
CREATE INDEX "ConversationMessage_tenantId_conversationId_idx" ON "ConversationMessage"("tenantId", "conversationId");
CREATE INDEX "ConversationMessage_conversationId_createdAt_idx" ON "ConversationMessage"("conversationId", "createdAt");

CREATE INDEX "ConversationNote_tenantId_idx" ON "ConversationNote"("tenantId");
CREATE INDEX "ConversationNote_conversationId_createdAt_idx" ON "ConversationNote"("conversationId", "createdAt");

CREATE UNIQUE INDEX "Label_tenantId_name_key" ON "Label"("tenantId", "name");
CREATE INDEX "Label_tenantId_idx" ON "Label"("tenantId");

CREATE INDEX "ConversationLabel_tenantId_idx" ON "ConversationLabel"("tenantId");
CREATE INDEX "ConversationLabel_labelId_idx" ON "ConversationLabel"("labelId");
CREATE INDEX "ConversationLabel_tenantId_labelId_idx" ON "ConversationLabel"("tenantId", "labelId");

CREATE UNIQUE INDEX "QuickReply_tenantId_shortcut_key" ON "QuickReply"("tenantId", "shortcut");
CREATE INDEX "QuickReply_tenantId_idx" ON "QuickReply"("tenantId");
CREATE INDEX "QuickReply_tenantId_position_idx" ON "QuickReply"("tenantId", "position");

-- Retry-dedup identity for the single timeline writer, scoped per tenant so a
-- replay lands once; NULLs-distinct-free because uniqueEventId is required.
CREATE UNIQUE INDEX "MarketingEvent_tenantId_eventType_uniqueEventId_key" ON "MarketingEvent"("tenantId", "eventType", "uniqueEventId");
CREATE INDEX "MarketingEvent_tenantId_idx" ON "MarketingEvent"("tenantId");
CREATE INDEX "MarketingEvent_tenantId_occurredAt_idx" ON "MarketingEvent"("tenantId", "occurredAt");
CREATE INDEX "MarketingEvent_tenantId_campaignId_idx" ON "MarketingEvent"("tenantId", "campaignId");
CREATE INDEX "MarketingEvent_tenantId_shareLinkId_idx" ON "MarketingEvent"("tenantId", "shareLinkId");
CREATE INDEX "MarketingEvent_tenantId_contactId_idx" ON "MarketingEvent"("tenantId", "contactId");
CREATE INDEX "MarketingEvent_tenantId_eventType_idx" ON "MarketingEvent"("tenantId", "eventType");

CREATE INDEX "MarketingCampaign_tenantId_idx" ON "MarketingCampaign"("tenantId");
CREATE INDEX "MarketingCampaign_tenantId_status_idx" ON "MarketingCampaign"("tenantId", "status");

CREATE INDEX "ContentPost_tenantId_idx" ON "ContentPost"("tenantId");
CREATE INDEX "ContentPost_tenantId_status_idx" ON "ContentPost"("tenantId", "status");
CREATE INDEX "ContentPost_tenantId_scheduledFor_idx" ON "ContentPost"("tenantId", "scheduledFor");
CREATE INDEX "ContentPost_tenantId_campaignId_idx" ON "ContentPost"("tenantId", "campaignId");

CREATE UNIQUE INDEX "PublishJob_contentPostId_attempt_key" ON "PublishJob"("contentPostId", "attempt");
CREATE INDEX "PublishJob_tenantId_idx" ON "PublishJob"("tenantId");
CREATE INDEX "PublishJob_tenantId_status_idx" ON "PublishJob"("tenantId", "status");
CREATE INDEX "PublishJob_contentPostId_idx" ON "PublishJob"("contentPostId");
CREATE INDEX "PublishJob_tenantId_connectionId_idx" ON "PublishJob"("tenantId", "connectionId");
CREATE INDEX "PublishJob_status_nextRetryAt_idx" ON "PublishJob"("status", "nextRetryAt");

CREATE INDEX "MediaAsset_tenantId_idx" ON "MediaAsset"("tenantId");
CREATE INDEX "MediaAsset_tenantId_kind_idx" ON "MediaAsset"("tenantId", "kind");

-- ─── 5. Functional / partial indexes Prisma cannot express ────────────────────
-- Invisible to the datamodel; the migrate-diff gate tolerates them as it
-- tolerates the existing partial uniques. They carry the "global" and "case-
-- insensitive" rules a plain @@unique cannot state.

-- A given provider-side external id (a WhatsApp phoneNumberId, a pageId, an
-- instagram_user_id) maps to exactly ONE connection across the whole platform —
-- this is what webhook routing resolves on, so it cannot be merely per-tenant
-- unique (two tenants binding the same phone number would be a routing fork).
-- The partial WHERE lets an unbound connection (NULL) carry no constraint, so
-- many NULLs are allowed.
CREATE UNIQUE INDEX "integration_connection_one_row_per_provider_external_id"
    ON "IntegrationConnection"("provider", "providerExternalId") WHERE "providerExternalId" IS NOT NULL;

-- Label names collide case-insensitively inside a tenant ("VIP" and "vip" are
-- one label). The plain (tenantId, name) unique above is the datamodel's; this
-- is the stricter product rule, the same shape as Tag.
CREATE UNIQUE INDEX "label_one_name_per_tenant_case_insensitive"
    ON "Label"("tenantId", lower("name"));

COMMENT ON INDEX "integration_connection_one_row_per_provider_external_id" IS
    'One connection per provider-side external id platform-wide; it is the routing key a webhook resolves, so a fork across tenants is impossible. NULL (unbound) is unconstrained.';
COMMENT ON INDEX "label_one_name_per_tenant_case_insensitive" IS
    'Label names are unique inside a tenant regardless of case: one "VIP", not three spellings of it (Tag precedent).';

-- ─── 6. Foreign keys ──────────────────────────────────────────────────────────
-- Referential actions mirror schema.prisma exactly: every tenant child cascades
-- on its tenant; every nullable pointer is SetNull; PublishJob -> connection
-- RESTRICTs so a connection with publish history cannot be deleted away.

ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntegrationWebhookEvent" ADD CONSTRAINT "IntegrationWebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Label" ADD CONSTRAINT "Label_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketingEvent" ADD CONSTRAINT "MarketingEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingEvent" ADD CONSTRAINT "MarketingEvent_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingEvent" ADD CONSTRAINT "MarketingEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingEvent" ADD CONSTRAINT "MarketingEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingEvent" ADD CONSTRAINT "MarketingEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingEvent" ADD CONSTRAINT "MarketingEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingEvent" ADD CONSTRAINT "MarketingEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_contentPostId_fkey" FOREIGN KEY ("contentPostId") REFERENCES "ContentPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 7. Constraints, append-only and single-tenant triggers ───────────────────

-- An informational budget, when present, is money: never negative — the same
-- floor family as Item_unitPrice_check / Lead_estimatedValue_check.
ALTER TABLE "MarketingCampaign"
    ADD CONSTRAINT "MarketingCampaign_budgetAmount_check"
        CHECK ("budgetAmount" IS NULL OR "budgetAmount" >= 0);

-- Marketing events are the consent-gated analytics trail: append-only, corrected
-- by writing another event, never edited or removed (activity_event_is_append_only
-- shape). Holds SELECT+INSERT only (§10).
CREATE OR REPLACE FUNCTION marketing_event_is_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Marketing events are append-only; event % cannot be changed or removed',
        OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_event_is_append_only
    BEFORE UPDATE OR DELETE ON "MarketingEvent"
    FOR EACH ROW EXECUTE FUNCTION marketing_event_is_append_only();

-- Webhook events are the immutable inbound audit trail, but unlike a marketing
-- event a parked row MUST be routable: §2/§59 route it by setting tenantId,
-- routingStatus and appliedAt. So the trigger is a payload-immutability + row-
-- retention guard: it refuses DELETE outright and refuses UPDATE of the
-- immutable envelope (provider, eventId, deliveryId, payload, receivedAt,
-- createdAt) while permitting the routing annotation. This honours the design's
-- "append-only trigger" for the event content and the documented routing
-- transition at once. (Phase 2 does the routing through a SECURITY DEFINER
-- ingestion path; the app role cannot reach a parked row through RLS — see §3.)
CREATE OR REPLACE FUNCTION integration_webhook_event_is_append_only()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Webhook events are retained; event % cannot be removed',
            OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
       OR NEW."deliveryId" IS DISTINCT FROM OLD."deliveryId"
       OR NEW."payload" IS DISTINCT FROM OLD."payload"
       OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Webhook event % payload and envelope are immutable; only routing may be annotated',
            OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER integration_webhook_event_is_append_only
    BEFORE UPDATE OR DELETE ON "IntegrationWebhookEvent"
    FOR EACH ROW EXECUTE FUNCTION integration_webhook_event_is_append_only();

-- The junction row's tenant must match BOTH its conversation and its label —
-- the contact_tag_is_single_tenant shape: a forged id from another tenant is
-- rejected even by a query that forgot its predicate. This is the only AGENT 03
-- table with two tenant-owned parents, so it is the only one that needs it
-- (matching the AGENT 02 precedent where only ContactTag carried a match
-- trigger).
CREATE OR REPLACE FUNCTION conversation_label_is_single_tenant() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Conversation" c
        WHERE c."id" = NEW."conversationId" AND c."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'ConversationLabel.conversationId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "Label" l
        WHERE l."id" = NEW."labelId" AND l."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'ConversationLabel.labelId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConversationLabel_single_tenant_parents"
    BEFORE INSERT OR UPDATE OF "conversationId", "labelId", "tenantId" ON "ConversationLabel"
    FOR EACH ROW EXECUTE FUNCTION conversation_label_is_single_tenant();

COMMENT ON CONSTRAINT "MarketingCampaign_budgetAmount_check" ON "MarketingCampaign" IS
    'A campaign budget, when present, is informational money: never negative (Item_unitPrice_check family).';
COMMENT ON FUNCTION marketing_event_is_append_only() IS
    'Marketing analytics events are corrected by writing another event, never by editing or deleting, mirroring document status events and the CRM timeline.';
COMMENT ON FUNCTION integration_webhook_event_is_append_only() IS
    'The inbound webhook envelope (provider, eventId, payload, receivedAt) is immutable and the row is retained; only routing annotation (tenantId, routingStatus, appliedAt) may change. Phase 2 does the routing via a definer ingestion path.';
COMMENT ON FUNCTION conversation_label_is_single_tenant() IS
    'A conversation-label row must belong to the same tenant as both its conversation and its label, even if a query forgets its tenant predicate.';

-- ─── 8. Permission catalogue delta: 74 -> 83 keys, 188 -> 218 matrix rows ──────
-- Idempotent additive reseed in the 20261030000000 (H1) / AGENT 02 §9 pattern.
-- Every key, domain, area and description below is copied from the
-- PERMISSION_DEFINITIONS entries in packages/auth/src/permissions.ts, and the
-- matrix rows from TENANT_ROLE_PERMISSIONS. Design §2 matrix delta:
--   OWNER / ADMIN   +9  (the full social-commerce surface)
--   SALES           +5  (integrations.read, inbox.read/manage/converse, marketing.read)
--   OPERATIONS      +4  (integrations.read, inbox.read, inbox.converse, analytics.read)
--   VIEWER          +3  (inbox.read, marketing.read, analytics.read)
--   FINANCE / CUSTOMER_PORTAL_USER / SUPPORT / SUPER_ADMIN  +0
-- All 9 keys are tenant-domain (areas integrations/inbox/marketing/analytics),
-- so the explicit-membership domain CHECK and the platform-parity posture stay
-- satisfied unchanged; no platform key is added, so SUPER_ADMIN gains nothing.
--
-- Derived counts (generated from permissions.ts, see the phase-1 verification):
--   Permission total          83  (74 baseline + 9 new)
--   RolePermission total     218  (188 baseline + 30 new: 9+9+5+4+3)
--   TENANT_OWNER 57 | TENANT_ADMIN 57 | SALES 32 | FINANCE 17 |
--   OPERATIONS 23 | VIEWER 15

DO $$
BEGIN
    INSERT INTO "Permission" ("id", "key", "domain", "area", "description")
    SELECT gen_random_uuid(), v."key", v."domain", v."area", v."description"
      FROM (VALUES
        -- Tenant domain (AGENT 03), all nine keys.
        ('integrations.read', 'tenant', 'integrations', 'View integration connections, capability status and health'),
        ('integrations.manage', 'tenant', 'integrations', 'Connect, verify and disconnect social-commerce integrations'),
        ('inbox.read', 'tenant', 'inbox', 'View conversations, messages and internal notes'),
        ('inbox.manage', 'tenant', 'inbox', 'Assign, label and close conversations across the inbox'),
        ('inbox.converse', 'tenant', 'inbox', 'Send outbound messages and record notes in a conversation'),
        ('marketing.read', 'tenant', 'marketing', 'View campaigns, content posts and the media library'),
        ('marketing.manage', 'tenant', 'marketing', 'Create and edit campaigns, content drafts and media'),
        ('marketing.publish', 'tenant', 'marketing', 'Approve, schedule and publish content posts'),
        ('analytics.read', 'tenant', 'analytics', 'View marketing event analytics and per-link counts')
      ) AS v("key", "domain", "area", "description")
     ON CONFLICT ("key") DO NOTHING;

    INSERT INTO "RolePermission" ("id", "roleKey", "domain", "permissionId")
    SELECT gen_random_uuid(), m."roleKey", p."domain", p."id"
      FROM (VALUES
        -- TENANT_OWNER (all 9 new)
        ('TENANT_OWNER', 'integrations.read'),
        ('TENANT_OWNER', 'integrations.manage'),
        ('TENANT_OWNER', 'inbox.read'),
        ('TENANT_OWNER', 'inbox.manage'),
        ('TENANT_OWNER', 'inbox.converse'),
        ('TENANT_OWNER', 'marketing.read'),
        ('TENANT_OWNER', 'marketing.manage'),
        ('TENANT_OWNER', 'marketing.publish'),
        ('TENANT_OWNER', 'analytics.read'),
        -- TENANT_ADMIN (all 9 new, identical to OWNER)
        ('TENANT_ADMIN', 'integrations.read'),
        ('TENANT_ADMIN', 'integrations.manage'),
        ('TENANT_ADMIN', 'inbox.read'),
        ('TENANT_ADMIN', 'inbox.manage'),
        ('TENANT_ADMIN', 'inbox.converse'),
        ('TENANT_ADMIN', 'marketing.read'),
        ('TENANT_ADMIN', 'marketing.manage'),
        ('TENANT_ADMIN', 'marketing.publish'),
        ('TENANT_ADMIN', 'analytics.read'),
        -- SALES (5 new: read integrations, run the whole inbox, read marketing)
        ('SALES', 'integrations.read'),
        ('SALES', 'inbox.read'),
        ('SALES', 'inbox.manage'),
        ('SALES', 'inbox.converse'),
        ('SALES', 'marketing.read'),
        -- OPERATIONS (4 new: answer conversations + read integration/analytics
        -- context; deliberately NOT inbox.manage, which is an ownership action)
        ('OPERATIONS', 'integrations.read'),
        ('OPERATIONS', 'inbox.read'),
        ('OPERATIONS', 'inbox.converse'),
        ('OPERATIONS', 'analytics.read'),
        -- VIEWER (3 new: read-only inbox, marketing and analytics)
        ('VIEWER', 'inbox.read'),
        ('VIEWER', 'marketing.read'),
        ('VIEWER', 'analytics.read')
        -- FINANCE, CUSTOMER_PORTAL_USER, SUPPORT, SUPER_ADMIN: no new rows by design
      ) AS m("roleKey", "permission")
      JOIN "Permission" p ON p."key" = m."permission"
     ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

    -- Exact-count asserts (H1 pattern): a total above the expectation means the
    -- database holds a row outside the code catalogue — additive reseed cannot
    -- fix that, so fail loud and roll the migration back. These are THIS
    -- migration's totals only; the committed 20261031000001 assert of 74/188
    -- ran against the DB as it stood then and is untouched.
    IF (SELECT count(*) FROM "Permission") <> 83 THEN
        RAISE EXCEPTION
            'AGENT 03 reseed: "Permission" holds % row(s) after the upsert, expected exactly 83 — a key in the database is not in the code catalog (additive reseed cannot remove it)',
            (SELECT count(*) FROM "Permission")
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission") <> 218 THEN
        RAISE EXCEPTION
            'AGENT 03 reseed: "RolePermission" holds % row(s) after the upsert, expected exactly 218 — the database carries a matrix row outside the code catalog',
            (SELECT count(*) FROM "RolePermission")
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_OWNER') <> 57 THEN
        RAISE EXCEPTION 'AGENT 03 reseed: TENANT_OWNER holds % permissions, expected exactly 57',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_OWNER')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_ADMIN') <> 57 THEN
        RAISE EXCEPTION 'AGENT 03 reseed: TENANT_ADMIN holds % permissions, expected exactly 57',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_ADMIN')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SALES') <> 32 THEN
        RAISE EXCEPTION 'AGENT 03 reseed: SALES holds % permissions, expected exactly 32',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SALES')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'FINANCE') <> 17 THEN
        RAISE EXCEPTION 'AGENT 03 reseed: FINANCE holds % permissions, expected exactly 17',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'FINANCE')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'OPERATIONS') <> 23 THEN
        RAISE EXCEPTION 'AGENT 03 reseed: OPERATIONS holds % permissions, expected exactly 23',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'OPERATIONS')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'VIEWER') <> 15 THEN
        RAISE EXCEPTION 'AGENT 03 reseed: VIEWER holds % permissions, expected exactly 15',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'VIEWER')
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── 9. Row level security ───────────────────────────────────────────────────
-- One policy set per new tenant table, exactly the 20261018000002 §4 pattern:
-- every policy targets `amisibiz_app` only; read = the read family, write =
-- the write family. Roles with no matching policy see nothing. ENABLE RLS is
-- mandatory on EVERY table below (including the two append-only and the
-- null-tenant webhook table) because the harness asserts that no public
-- application table is left unprotected.
--   `IntegrationWebhookEvent.tenantId` is nullable: a parked (NULL) row fails
--   has_tenant_read_access/has_tenant_write_access, so it is invisible and
--   unwritable to `amisibiz_app` — the correct posture until Phase 2's definer
--   ingestion path claims it.

ALTER TABLE "IntegrationConnection"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IntegrationWebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationMessage"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationNote"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Label"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationLabel"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickReply"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketingEvent"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketingCampaign"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentPost"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishJob"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaAsset"              ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'IntegrationConnection', 'IntegrationWebhookEvent', 'Conversation',
        'ConversationMessage', 'ConversationNote', 'Label', 'ConversationLabel',
        'QuickReply', 'MarketingEvent', 'MarketingCampaign', 'ContentPost',
        'PublishJob', 'MediaAsset'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_read_' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_insert_' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_update_' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_delete_' || t, t);

        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR SELECT TO amisibiz_app USING (public.has_tenant_read_access("tenantId"))',
            'app_read_' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR INSERT TO amisibiz_app WITH CHECK (public.has_tenant_write_access("tenantId"))',
            'app_insert_' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE TO amisibiz_app USING (public.has_tenant_write_access("tenantId")) WITH CHECK (public.has_tenant_write_access("tenantId"))',
            'app_update_' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR DELETE TO amisibiz_app USING (public.has_tenant_write_access("tenantId"))',
            'app_delete_' || t, t);
    END LOOP;
END
$$;

-- ─── 10. Runtime grants ──────────────────────────────────────────────────────
-- Explicit, because no default privileges exist for the runtime role any more
-- (20261018000002 §8). Verb lists are the ceiling the application can use; RLS
-- policies narrow within them.
--   * `MarketingEvent` is append-only: SELECT+INSERT privilege, so a tamper is
--     refused at the privilege layer before it ever reaches a policy — the
--     §7 trigger is belt-and-suspenders, like ActivityEvent.
--   * `IntegrationWebhookEvent` needs UPDATE so a routed row can be annotated
--     (routingStatus/appliedAt/tenantId); DELETE is withheld, the §7 trigger also
--     refuses it, and RLS still gates which rows the app role can even see.
--   * The remaining mutable entity/config tables take full CUD; deletes of
--     business data are still governed by RLS write access.

REVOKE ALL ON "IntegrationConnection", "IntegrationWebhookEvent", "Conversation",
              "ConversationMessage", "ConversationNote", "Label", "ConversationLabel",
              "QuickReply", "MarketingEvent", "MarketingCampaign", "ContentPost",
              "PublishJob", "MediaAsset"
    FROM amisibiz_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "IntegrationConnection"   TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE         ON "IntegrationWebhookEvent" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Conversation"            TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ConversationMessage"     TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ConversationNote"        TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Label"                   TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ConversationLabel"       TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "QuickReply"              TO amisibiz_app;
GRANT SELECT, INSERT                 ON "MarketingEvent"          TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "MarketingCampaign"       TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ContentPost"             TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "PublishJob"              TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "MediaAsset"              TO amisibiz_app;

-- ─── 11. Anon / authenticated revoke (successor of 20261018000002 §8(d)) ──────
-- The PostgREST-facing roles must hold nothing on the new tables. Conditional
-- loop because a vanilla PostgreSQL (the CI/offline cluster) has neither role.
DO $$
DECLARE
    r       record;
    t       text;
    v_amisi text[] := ARRAY[
        'IntegrationConnection', 'IntegrationWebhookEvent', 'Conversation',
        'ConversationMessage', 'ConversationNote', 'Label', 'ConversationLabel',
        'QuickReply', 'MarketingEvent', 'MarketingCampaign', 'ContentPost',
        'PublishJob', 'MediaAsset'
    ];
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    LOOP
        FOREACH t IN ARRAY v_amisi
        LOOP
            EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r.rolname);
        END LOOP;
    END LOOP;
END
$$;

-- ─── Table comments ──────────────────────────────────────────────────────────

COMMENT ON TABLE "IntegrationConnection" IS
    'One (tenant, provider) Meta connection: holds the AES-256-GCM credential CIPHERTEXT (keyed on the INTEGRATION_SECRET env, which never enters the DB), non-secret credentialMeta, a webhook-verify-token hash and a routing external id. API surfaces expose metadata + masked status only, never the ciphertext or token.';
COMMENT ON TABLE "IntegrationWebhookEvent" IS
    'Raw inbound webhook envelope, retained for dedup and audit; (provider, eventId) unique is Meta''s retry spine. tenantId is NULL while PARKED; routing to a tenant is a Phase 2 definer concern.';
COMMENT ON TABLE "Conversation" IS
    'A customer thread on one channel of one connection; (connectionId, externalId) is the provider-side key the webhook upsert resolves.';
COMMENT ON TABLE "ConversationMessage" IS
    'Inbound/outbound message in a thread; connectionId is denormalised for the (connectionId, providerMessageId) idempotent-inbound unique. Internal notes are a separate table, never a direction here.';
COMMENT ON TABLE "ConversationNote" IS
    'Internal, never-sent note on a thread — its own table so it can never render as an outbound message.';
COMMENT ON TABLE "Label" IS
    'Tenant inbox label; case-insensitive name uniqueness by functional index, never tenant-global (Tag precedent).';
COMMENT ON TABLE "ConversationLabel" IS
    'Conversation-label junction carrying its own tenantId for the RLS template; a trigger proves both parents match.';
COMMENT ON TABLE "QuickReply" IS
    'Tenant canned reply keyed by shortcut; aiProvenance is the provenance seam for AI-generated canned text.';
COMMENT ON TABLE "MarketingEvent" IS
    'Append-only, consent-gated marketing stream (own table, not ActivityEvent): (tenantId, eventType, uniqueEventId) dedup, contactId attached only when Contact.marketingConsent is true. sourceMeta holds no IP.';
COMMENT ON TABLE "MarketingCampaign" IS
    'Marketing campaign with UTM attribution; budget is informational money (never a gate), same posture as Plan.';
COMMENT ON TABLE "ContentPost" IS
    'Content DRAFT half of the lifecycle: DRAFT to APPROVED to SCHEDULED; PUBLISHED is set only by a verified PublishJob outcome in Phase 2.';
COMMENT ON TABLE "PublishJob" IS
    'Publish attempt against a provider (separate from the draft): retry ladder 1m/5m/25m/2h/6h then ABANDONED; providerRef set only by a VERIFIED outcome; errorDetail sanitised.';
COMMENT ON TABLE "MediaAsset" IS
    'Media library entry stored through the Vercel Blob seam (fail-closed without BLOB_READ_WRITE_TOKEN); blobUrl is the public read URL (ItemImage precedent).';
