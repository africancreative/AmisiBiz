-- Migration: AGENT 02 (24b) — CRM & commerce: leads & pipeline, tasks, the
-- unified activity timeline, share links, catalogue extensions, the Contact
-- capture/consent columns, the Document/ORDER lifecycle swaps, the permission
-- catalogue delta (57 -> 74), RLS, the public SECURITY DEFINER read/capture
-- functions, and the runtime grants.
-- Created: 2026-10-31
--
-- Basis: docs/implementation/orchestration/agent-02-design.md §1 (design
-- locked 2026-10-18). The enum half of the DocumentType extension lives in
-- 20261031000000_agent02_document_type_order_enum because PostgreSQL refuses
-- to let a new enum value be used in the same transaction that adds it; this
-- file is that follow-up transaction and may therefore reference 'ORDER'.
--
-- Rules this file keeps, copied from the chain it extends:
--   * Orders are `Document` rows of type ORDER — no Order table. The existing
--     engine (numbering, snapshot-on-issue, immutability, derived payment
--     statuses) is extended by CHECKs, not duplicated.
--   * Every new tenant table: ENABLE ROW LEVEL SECURITY + the 4-policy
--     app_read/insert/update/delete DO-loop on "tenantId" (20261018000002 §4),
--     an explicit verb grant to `amisibiz_app` (default privileges no longer
--     exist there), and an entry in the successor anon/authenticated revoke
--     block. FORCE RLS is not used anywhere (same acknowledged posture).
--   * Children carrying their own tenantId get the single-tenant match
--     trigger (item_tax_rate_is_single_tenant shape).
--   * Append-only tables raise from a BEFORE UPDATE OR DELETE trigger
--     (document_status_event_is_append_only shape) and hold SELECT+INSERT only.
--   * Lead/Task carry `revision` + the existing public.amisibiz_bump_revision
--     trigger (20261023000000 §3) so the sync layer can adopt them without
--     another schema pass.
--   * Public unauthenticated reads go through SECURITY DEFINER app_public_*
--     functions returning minimized jsonb (app_find_user_id_by_email
--     precedent); nothing anonymous reaches the tables; EXECUTE is granted to
--     `amisibiz_app` and revoked from PUBLIC/anon/authenticated.
--   * Permission seeding is idempotent (ON CONFLICT DO NOTHING) with
--     exact-count ASSERTs in-migration (20261030000000 H1 pattern). The
--     numbers below are generated from packages/auth/src/permissions.ts, not
--     hand-written: 17 new tenant keys, 66 new matrix rows, totals 74 and 188,
--     per-tenant-role counts 48/48/27/17/19/12 (OWNER/ADMIN/SALES/FINANCE/
--     OPERATIONS/VIEWER).

-- ─── 1. Enums ─────────────────────────────────────────────────────────────────
-- The six AGENT 02 enums, values exactly as the Prisma schema declares them.
-- `Contact.source` deliberately reuses LeadSource (one capture-channel
-- vocabulary, not two that can drift); Task priority reuses LeadPriority.
-- `ActivityEvent.eventType` stays TEXT: an open vocabulary, so future agents
-- never migrate an enum per event kind.

CREATE TYPE "public"."LeadSource" AS ENUM (
    'WEB_FORM', 'REFERRAL', 'SOCIAL', 'CAMPAIGN', 'WALK_IN', 'PHONE', 'EMAIL', 'IMPORT', 'OTHER'
);

CREATE TYPE "public"."LeadStatus" AS ENUM (
    'NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'
);

CREATE TYPE "public"."LeadPriority" AS ENUM (
    'LOW', 'MEDIUM', 'HIGH'
);

CREATE TYPE "public"."ContactChannel" AS ENUM (
    'PHONE', 'WHATSAPP', 'SMS', 'EMAIL', 'PORTAL', 'OTHER'
);

CREATE TYPE "public"."ShareLinkKind" AS ENUM (
    'PRODUCT', 'LEAD_FORM', 'ORDER_STATUS'
);

CREATE TYPE "public"."VariantStatus" AS ENUM (
    'ACTIVE', 'INACTIVE'
);

-- Catalogue archiving is an item-level decision (design spec §1.3). The value
-- is only ADDED here, never referenced by a statement in this transaction, so
-- it is legal in this file — unlike the DocumentType ORDER value, which CHECKs
-- in §8 consume and which therefore lives in the committed-first 20261031000000.
ALTER TYPE "public"."ItemStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

-- ─── 2. Contact capture/consent columns and Item/DocumentLine pointers ───────
-- All additive; existing rows keep working untouched. `supersededById` is the
-- merge survivor pointer: a merged-away contact keeps its row, is set ARCHIVED
-- by the merge action, and points at the survivor. Never hard-deleted.

ALTER TABLE "Contact" ADD COLUMN "source" "LeadSource";
ALTER TABLE "Contact" ADD COLUMN "sourceDetail" TEXT;
ALTER TABLE "Contact" ADD COLUMN "sourceCampaign" TEXT;
ALTER TABLE "Contact" ADD COLUMN "preferredChannel" "ContactChannel";
ALTER TABLE "Contact" ADD COLUMN "marketingConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "marketingConsentAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "supersededById" UUID;

-- Catalogue category pointer (SetNull: deleting a category never eats items).
ALTER TABLE "Item" ADD COLUMN "categoryId" UUID;

-- Variant provenance on document lines. Mirrors `itemId`: provenance only —
-- the printed line always comes from the snapshot columns, and RESTRICT keeps
-- a sold-through variant from being deleted out from under a document. The FK
-- is added in §5, after ProductVariant exists.
ALTER TABLE "DocumentLine" ADD COLUMN "variantId" UUID;

CREATE INDEX "Contact_tenantId_source_idx" ON "Contact"("tenantId", "source");
CREATE INDEX "Item_tenantId_categoryId_idx" ON "Item"("tenantId", "categoryId");

COMMENT ON COLUMN "Contact"."sourceCampaign" IS 'UTM campaign text only; campaign entities are AGENT 04 territory — there is no Campaign table.';
COMMENT ON COLUMN "Contact"."supersededById" IS 'Merge survivor pointer. Set only by the explicit two-step merge action; never automatic dedupe.';
COMMENT ON COLUMN "DocumentLine"."variantId" IS 'Provenance of the catalogue variant a line was built from. Snapshot columns remain the print authority.';

-- ─── 3. New tables ────────────────────────────────────────────────────────────
-- Shapes exactly as `prisma migrate diff` against schema.prisma produces them:
-- UUID ids with gen_random_uuid(), TIMESTAMP(3) WITHOUT TIME ZONE timestamps,
-- DEFAULT CURRENT_TIMESTAMP only on createdAt (@updatedAt columns are written
-- by the application, as everywhere in this chain).

CREATE TABLE "CatalogueCategory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogueCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Tag" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- Junction table carrying its own tenantId because the RLS policy template
-- keys on "tenantId" directly (DocumentLine/DocumentPayment precedent); §7 adds
-- the trigger proving the tenant matches both parents.
CREATE TABLE "ContactTag" (
    "tenantId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("contactId","tagId")
);

-- Images ride the owner's Vercel Blob seam (lib/logo-storage.ts pattern,
-- BLOB_READ_WRITE_TOKEN fail-closed); blobUrl is the resulting public read URL.
-- No fake local storage.
CREATE TABLE "ItemImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "blobUrl" TEXT NOT NULL,
    "alt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "taxRateId" UUID,
    "status" "VariantStatus" NOT NULL DEFAULT 'ACTIVE',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Pipeline" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PipelineStage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "isWin" BOOLEAN NOT NULL DEFAULT false,
    "isLost" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Lead" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "priority" "LeadPriority" NOT NULL DEFAULT 'MEDIUM',
    "pipelineStageId" UUID,
    "assignedToUserId" UUID,
    "firstName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "estimatedValue" DECIMAL(18,4),
    "source" "LeadSource" NOT NULL,
    "sourceDetail" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "contactId" UUID,
    "lostReason" TEXT,
    "lostAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "convertedContactId" UUID,
    "convertedDocumentId" UUID,
    "idempotencyKey" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "priority" "LeadPriority" NOT NULL DEFAULT 'MEDIUM',
    "assigneeId" UUID,
    "leadId" UUID,
    "contactId" UUID,
    "documentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShareLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "kind" "ShareLinkKind" NOT NULL,
    "token" TEXT NOT NULL,
    "itemId" UUID,
    "documentId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "message" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- Unified activity timeline (module F). APPEND-ONLY by design: no updatedAt
-- column, SELECT+INSERT grants only (§12) and a refuse-everything trigger (§7)
-- mirroring DocumentStatusEvent.
CREATE TABLE "ActivityEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" UUID,
    "leadId" UUID,
    "contactId" UUID,
    "documentId" UUID,
    "taskId" UUID,
    "shareLinkId" UUID,
    "payload" JSONB,
    "source" TEXT,
    "sourceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- ─── 4. Indexes and uniques ───────────────────────────────────────────────────

CREATE UNIQUE INDEX "CatalogueCategory_tenantId_name_key" ON "CatalogueCategory"("tenantId", "name");
CREATE INDEX "CatalogueCategory_tenantId_idx" ON "CatalogueCategory"("tenantId");
CREATE INDEX "CatalogueCategory_tenantId_parentId_idx" ON "CatalogueCategory"("tenantId", "parentId");

CREATE UNIQUE INDEX "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");
CREATE INDEX "Tag_tenantId_idx" ON "Tag"("tenantId");

CREATE INDEX "ContactTag_tenantId_idx" ON "ContactTag"("tenantId");
CREATE INDEX "ContactTag_tagId_idx" ON "ContactTag"("tagId");
CREATE INDEX "ContactTag_tenantId_tagId_idx" ON "ContactTag"("tenantId", "tagId");

CREATE UNIQUE INDEX "ItemImage_tenantId_itemId_position_key" ON "ItemImage"("tenantId", "itemId", "position");
CREATE INDEX "ItemImage_tenantId_idx" ON "ItemImage"("tenantId");
CREATE INDEX "ItemImage_tenantId_itemId_idx" ON "ItemImage"("tenantId", "itemId");

-- Plain unique: Postgres treats NULLs as distinct, so variants without a SKU
-- are unconstrained — exactly the partial-index behaviour the spec asks for
-- without a hand-written WHERE.
CREATE UNIQUE INDEX "ProductVariant_tenantId_sku_key" ON "ProductVariant"("tenantId", "sku");
CREATE INDEX "ProductVariant_tenantId_idx" ON "ProductVariant"("tenantId");
CREATE INDEX "ProductVariant_tenantId_itemId_idx" ON "ProductVariant"("tenantId", "itemId");

CREATE INDEX "Pipeline_tenantId_idx" ON "Pipeline"("tenantId");

CREATE UNIQUE INDEX "PipelineStage_tenantId_pipelineId_position_key" ON "PipelineStage"("tenantId", "pipelineId", "position");
CREATE INDEX "PipelineStage_tenantId_idx" ON "PipelineStage"("tenantId");
CREATE INDEX "PipelineStage_tenantId_pipelineId_idx" ON "PipelineStage"("tenantId", "pipelineId");

-- "Prevent duplicate leads from retries": plain uniques with NULLS DISTINCT
-- semantics — a NULL idempotencyKey/externalId never collides.
CREATE UNIQUE INDEX "Lead_tenantId_idempotencyKey_key" ON "Lead"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "Lead_tenantId_source_externalId_key" ON "Lead"("tenantId", "source", "externalId");
CREATE INDEX "Lead_tenantId_idx" ON "Lead"("tenantId");
CREATE INDEX "Lead_tenantId_status_idx" ON "Lead"("tenantId", "status");
CREATE INDEX "Lead_tenantId_createdAt_idx" ON "Lead"("tenantId", "createdAt");
CREATE INDEX "Lead_tenantId_email_idx" ON "Lead"("tenantId", "email");
CREATE INDEX "Lead_tenantId_phone_idx" ON "Lead"("tenantId", "phone");

CREATE INDEX "Task_tenantId_idx" ON "Task"("tenantId");
CREATE INDEX "Task_tenantId_dueAt_idx" ON "Task"("tenantId", "dueAt");
CREATE INDEX "Task_tenantId_contactId_idx" ON "Task"("tenantId", "contactId");
CREATE INDEX "Task_tenantId_leadId_idx" ON "Task"("tenantId", "leadId");

-- Retry-dedup identity for the single timeline writer: a writer names itself
-- (source) and keys the exact mutation (sourceKey); the unique makes a retry
-- land once.
CREATE UNIQUE INDEX "ActivityEvent_tenantId_source_sourceKey_key" ON "ActivityEvent"("tenantId", "source", "sourceKey");
CREATE INDEX "ActivityEvent_tenantId_idx" ON "ActivityEvent"("tenantId");
CREATE INDEX "ActivityEvent_tenantId_occurredAt_idx" ON "ActivityEvent"("tenantId", "occurredAt");
CREATE INDEX "ActivityEvent_tenantId_contactId_idx" ON "ActivityEvent"("tenantId", "contactId");
CREATE INDEX "ActivityEvent_tenantId_leadId_idx" ON "ActivityEvent"("tenantId", "leadId");
CREATE INDEX "ActivityEvent_tenantId_documentId_idx" ON "ActivityEvent"("tenantId", "documentId");

CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");
CREATE INDEX "ShareLink_tenantId_idx" ON "ShareLink"("tenantId");
CREATE INDEX "ShareLink_tenantId_kind_idx" ON "ShareLink"("tenantId", "kind");

-- ─── 5. Functional / partial indexes Prisma cannot express ───────────────────
-- These carry the spec's "one per tenant" rules that a plain @@unique cannot
-- state. They are deliberately invisible to the datamodel (the schema comments
-- flag them); the migrate-diff gate tolerates them exactly as it tolerates the
-- existing partial uniques (TenantDomain_one_primary_per_tenant,
-- document_one_invoice_per_source).

-- Tag names collide case-insensitively inside a tenant ("VIP" and "vip" are
-- one tag). The plain (tenantId, name) unique above stays — it is what the
-- Prisma datamodel declares; this is the stricter one the product needs.
CREATE UNIQUE INDEX "tag_one_name_per_tenant_case_insensitive"
    ON "Tag"("tenantId", lower("name"));

-- One default pipeline per live workspace; archiving releases the slot.
CREATE UNIQUE INDEX "pipeline_one_default_per_tenant"
    ON "Pipeline"("tenantId") WHERE "isDefault" AND "archivedAt" IS NULL;

-- One active product page per item, one active status page per order. The
-- kind predicate already implies the id column is set; revoked or expired
-- links (active = false) free the slot for a fresh share.
CREATE UNIQUE INDEX "share_link_one_active_product_link_per_item"
    ON "ShareLink"("tenantId", "itemId") WHERE "kind" = 'PRODUCT' AND "active";
CREATE UNIQUE INDEX "share_link_one_active_order_status_link_per_document"
    ON "ShareLink"("tenantId", "documentId") WHERE "kind" = 'ORDER_STATUS' AND "active";

COMMENT ON INDEX "tag_one_name_per_tenant_case_insensitive" IS
    'Tag names are unique inside a tenant regardless of case: one "VIP", not three spellings of it.';
COMMENT ON INDEX "pipeline_one_default_per_tenant" IS
    'Exactly one default pipeline per live workspace; an archived default releases the slot.';
COMMENT ON INDEX "share_link_one_active_product_link_per_item" IS
    'One active public page per item; revoking (active = false) frees the slot for a fresh token.';
COMMENT ON INDEX "share_link_one_active_order_status_link_per_document" IS
    'One active status page per order; revoking frees the slot.';

-- ─── 6. Foreign keys ──────────────────────────────────────────────────────────
-- Referential actions mirror schema.prisma exactly: catalogue/CRM children
-- cascade on their tenant; every nullable pointer is SetNull; variant
-- provenance RESTRICTs so a sold-through variant cannot be deleted away.

ALTER TABLE "Contact"       ADD CONSTRAINT "Contact_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Item"          ADD CONSTRAINT "Item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CatalogueCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentLine"  ADD CONSTRAINT "DocumentLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogueCategory" ADD CONSTRAINT "CatalogueCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CatalogueCategory" ADD CONSTRAINT "CatalogueCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CatalogueCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Tag" ADD CONSTRAINT "Tag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ItemImage" ADD CONSTRAINT "ItemImage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ItemImage" ADD CONSTRAINT "ItemImage_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_pipelineStageId_fkey" FOREIGN KEY ("pipelineStageId") REFERENCES "PipelineStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedContactId_fkey" FOREIGN KEY ("convertedContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedDocumentId_fkey" FOREIGN KEY ("convertedDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 7. Constraints and integrity triggers ────────────────────────────────────

ALTER TABLE "Task"
    ADD CONSTRAINT "task_participant_is_required"
        CHECK ("leadId" IS NOT NULL OR "contactId" IS NOT NULL OR "documentId" IS NOT NULL);

ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_estimatedValue_check"
        CHECK ("estimatedValue" IS NULL OR "estimatedValue" >= 0);

-- Mirrors `Item_unitPrice_check` (20261014000000): the same price floor on the
-- variant price surface.
ALTER TABLE "ProductVariant"
    ADD CONSTRAINT "ProductVariant_unitPrice_check"
        CHECK ("unitPrice" >= 0);

ALTER TABLE "PipelineStage"
    ADD CONSTRAINT "pipeline_stage_position_is_non_negative"
        CHECK ("position" >= 0);

-- The junction row's tenant must match BOTH parents — the
-- item_tax_rate_is_single_tenant shape (20261014000000): a forged id from
-- another tenant is rejected even by a query that forgot its predicate.
CREATE OR REPLACE FUNCTION contact_tag_is_single_tenant() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Contact" c
        WHERE c."id" = NEW."contactId" AND c."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'ContactTag.contactId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "Tag" t
        WHERE t."id" = NEW."tagId" AND t."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'ContactTag.tagId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactTag_single_tenant_parents"
    BEFORE INSERT OR UPDATE OF "contactId", "tagId", "tenantId" ON "ContactTag"
    FOR EACH ROW EXECUTE FUNCTION contact_tag_is_single_tenant();

-- Activity events are the audit trail of the CRM: append-only, like document
-- status events (document_status_event_is_append_only shape, 20261015000000).
CREATE OR REPLACE FUNCTION activity_event_is_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Activity events are append-only; event % cannot be changed or removed',
        OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_event_is_append_only
    BEFORE UPDATE OR DELETE ON "ActivityEvent"
    FOR EACH ROW EXECUTE FUNCTION activity_event_is_append_only();

-- Offline/sync posture (design spec §5): Lead and Task carry `revision` with
-- the SAME trigger the device-authored tables use, so the sync registry can
-- adopt them in a later pass without another schema change. The function is
-- reused as-is from 20261023000000 §3; only the triggers are new.
CREATE TRIGGER lead_bump_revision
    BEFORE UPDATE ON "Lead"
    FOR EACH ROW EXECUTE FUNCTION public.amisibiz_bump_revision();

CREATE TRIGGER task_bump_revision
    BEFORE UPDATE ON "Task"
    FOR EACH ROW EXECUTE FUNCTION public.amisibiz_bump_revision();

COMMENT ON CONSTRAINT "task_participant_is_required" ON "Task" IS
    'A task always belongs to something: at least one of leadId / contactId / documentId must be set.';
COMMENT ON CONSTRAINT "Lead_estimatedValue_check" ON "Lead" IS
    'An estimated value, when present, is money: never negative (Item_unitPrice_check family).';
COMMENT ON CONSTRAINT "ProductVariant_unitPrice_check" ON "ProductVariant" IS
    'Variant prices are money: never negative (Item_unitPrice_check family).';
COMMENT ON FUNCTION contact_tag_is_single_tenant() IS
    'A contact-tag row must belong to the same tenant as both its contact and its tag, even if a query forgets its tenant predicate.';
COMMENT ON FUNCTION activity_event_is_append_only() IS
    'Timeline events are corrected by writing another event, never by editing or deleting, mirroring document status events.';

-- ─── 8. Document / ORDER extension ────────────────────────────────────────────
-- Orders are Document rows of type ORDER (design spec §0/§1.8): the lifecycle
-- CHECK family, the void rule, the derivation rule and the one-invoice-per-
-- source guarantee are re-stated with the ORDER branch. The immutability,
-- snapshot, totals-consistency and numbering CHECK families are type-agnostic
-- and survive untouched — ORDER inherits every one of them, which is the
-- point of not building an Order table.

ALTER TABLE "Document" DROP CONSTRAINT "document_status_matches_type";
ALTER TABLE "Document"
    ADD CONSTRAINT "document_status_matches_type"
        CHECK (
            ("type" = 'QUOTATION'
                AND "status" IN ('DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
         OR ("type" = 'INVOICE'
                AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID'))
         OR ("type" = 'DELIVERY_NOTE'
                AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED'))
         OR ("type" = 'ORDER'
                AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'VOID'))
        );

-- VOID becomes the issued-order correction path, exactly as for invoices; the
-- constraint is renamed so the rule and its name agree.
ALTER TABLE "Document" DROP CONSTRAINT "document_void_only_applies_to_invoices";
ALTER TABLE "Document"
    ADD CONSTRAINT "document_void_applies_to_invoices_or_orders"
        CHECK ("status" <> 'VOID' OR "type" IN ('INVOICE', 'ORDER'));

-- Which derived types may name a source: quotations never do; invoices and
-- delivery notes derive from sales documents; an order is the conversion of a
-- quotation (design spec §0: `convertQuotationToOrder` mirrors
-- `convertQuotationToInvoice`). Which SOURCE types pair with which derived
-- type is a cross-row rule a CHECK cannot express — §7's
-- `document_source_type_is_compatible` trigger carries it.
ALTER TABLE "Document" DROP CONSTRAINT "document_only_sales_documents_carry_a_source";
ALTER TABLE "Document"
    ADD CONSTRAINT "document_only_sales_documents_carry_a_source"
        CHECK ("sourceDocumentId" IS NULL OR "type" IN ('INVOICE', 'DELIVERY_NOTE', 'ORDER'));

CREATE OR REPLACE FUNCTION document_source_type_is_compatible()
RETURNS trigger AS $$
DECLARE
    v_source_type   "DocumentType";
    v_source_tenant uuid;
BEGIN
    IF NEW."sourceDocumentId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT d."type", d."tenantId" INTO v_source_type, v_source_tenant
      FROM "Document" d
     WHERE d."id" = NEW."sourceDocumentId";

    -- Absent or foreign source: leave the refusal to
    -- document_references_belong_to_tenant, whose message the tests and
    -- operators already know ("does not belong to tenant").
    IF v_source_type IS NULL OR v_source_tenant IS DISTINCT FROM NEW."tenantId" THEN
        RETURN NEW;
    END IF;

    IF NOT (
           (NEW."type" = 'INVOICE'       AND v_source_type IN ('QUOTATION', 'ORDER'))
        OR (NEW."type" = 'DELIVERY_NOTE' AND v_source_type IN ('INVOICE', 'ORDER'))
        OR (NEW."type" = 'ORDER'         AND v_source_type = 'QUOTATION')
    ) THEN
        RAISE EXCEPTION 'A % cannot be derived from a %', NEW."type", v_source_type
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_source_type_is_compatible
    BEFORE INSERT OR UPDATE OF "sourceDocumentId", "type" ON "Document"
    FOR EACH ROW EXECUTE FUNCTION document_source_type_is_compatible();

-- Retried conversions must not create a second invoice for the same source —
-- any source, quotation or order. The predicate is the old one (still keyed
-- purely on the derived row), so extending it to order-sourced invoices is
-- this rename plus the source-pairing trigger above.
DROP INDEX IF EXISTS "document_one_invoice_per_source";
CREATE UNIQUE INDEX "document_one_derived_invoice_per_source" ON "Document"("sourceDocumentId")
    WHERE "type" = 'INVOICE' AND "sourceDocumentId" IS NOT NULL;

COMMENT ON CONSTRAINT "document_status_matches_type" ON "Document" IS
    'Each document type owns its lifecycle: a quotation cannot be PAID, an invoice cannot be ACCEPTED, and an order walks the money path (DRAFT to ISSUED to PARTIALLY_PAID/PAID/OVERDUE, with CANCELLED/VOID exits).';
COMMENT ON CONSTRAINT "document_void_applies_to_invoices_or_orders" ON "Document" IS
    'VOID is the correction path of issued money documents only: invoices and orders.';
COMMENT ON CONSTRAINT "document_only_sales_documents_carry_a_source" ON "Document" IS
    'Only derived sales documents name a source: invoices, delivery notes and converted orders. Quotations are always original.';
COMMENT ON INDEX "document_one_derived_invoice_per_source" IS
    'A source document converts to at most one invoice, whichever kind it is. Partial deliveries stay allowed: delivery notes are excluded and rely on the idempotency key instead.';
COMMENT ON FUNCTION document_source_type_is_compatible() IS
    'The derivation table of the sales engine: INVOICE from QUOTATION or ORDER, DELIVERY_NOTE from INVOICE or ORDER, ORDER from QUOTATION. Nothing else derives.';

-- Numbering functions: recreated with the ORDER default case. Bodies are
-- copied verbatim from their current definitions — document_number_period from
-- 20261015000000 §G, allocate_document_number from 20261019000000 §9 (the
-- suspension gate included), peek_document_number from 20261018000000 — with
-- exactly one change each where a per-type default prefix is decided: ORDER
-- defaults to 'ORD', padding 4, separator '-', calendar-year period, the same
-- defaults QUOTATION and INVOICE get. DocumentNumbering rows stay per
-- (tenant, type) and lazily defaulted, so nothing is backfilled.
-- DROP + recreate (not CREATE OR REPLACE) so the signature story is explicit;
-- privileges were granted on the old objects and are re-granted below.

DROP FUNCTION IF EXISTS public.document_number_period("DocumentPeriodStyle", integer, date);
CREATE OR REPLACE FUNCTION public.document_number_period(
    p_period_style "DocumentPeriodStyle",
    p_fiscal_start_month integer,
    p_date date
) RETURNS text AS $$
DECLARE
    v_year integer;
BEGIN
    IF p_date IS NULL THEN
        RAISE EXCEPTION 'A date is required to resolve a document number period'
            USING ERRCODE = 'check_violation';
    END IF;

    IF p_period_style = 'NONE' THEN
        RETURN '';
    END IF;

    IF p_period_style = 'CALENDAR_YEAR' THEN
        RETURN to_char(p_date, 'YYYY');
    END IF;

    -- FINANCIAL_YEAR: the year the books start in, written as 2026/27.
    v_year := EXTRACT(YEAR FROM p_date)::integer;
    IF EXTRACT(MONTH FROM p_date)::integer < COALESCE(p_fiscal_start_month, 1) THEN
        v_year := v_year - 1;
    END IF;

    RETURN v_year::text || '/' || lpad(((v_year + 1) % 100)::text, 2, '0');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DROP FUNCTION IF EXISTS public.allocate_document_number(uuid, "DocumentType", date);
CREATE OR REPLACE FUNCTION public.allocate_document_number(
    p_tenant_id uuid,
    p_type "DocumentType",
    p_date date
) RETURNS text AS $$
DECLARE
    v_prefix     text;
    v_padding    integer;
    v_separator  text;
    v_style      "DocumentPeriodStyle";
    v_fiscal     integer;
    v_period     text;
    v_value      integer;
    v_number     text;
BEGIN
    IF p_tenant_id IS NULL OR p_type IS NULL THEN
        RAISE EXCEPTION 'allocate_document_number requires a tenant and a document type'
            USING ERRCODE = 'check_violation';
    END IF;

    -- The issuance transaction must carry the tenant's own context: numbers
    -- are allocated inside a tenant scope, never from a bare platform or
    -- unset context.
    IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'Document numbers can only be allocated in the context of the tenant they belong to'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF public.app_tenant_role(p_tenant_id) IS NULL
       OR public.app_tenant_role(p_tenant_id) NOT IN
          ('TENANT_OWNER', 'TENANT_ADMIN', 'SALES', 'FINANCE', 'OPERATIONS') THEN
        RAISE EXCEPTION 'This membership role cannot issue documents'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Issuing is a write, and a suspended workspace does not accept writes.
    -- Checked after the role tests so that an unprivileged caller still gets
    -- the pre-existing, already-tested refusal.
    IF NOT public.app_tenant_accepts_writes(p_tenant_id) THEN
        RAISE EXCEPTION 'This workspace is suspended and cannot allocate document numbers'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A tenant that never opened the numbering screen still has to be able to
    -- issue, so the series is created on first use with the documented defaults
    -- (INV-2026-0001 / QUO-2026-0001 / DN-2026-0001 / ORD-2026-0001). The row
    -- id is a fresh UUID; "create if absent" is guaranteed by the
    -- (tenantId, type) unique constraint, not by a deterministic id.
    INSERT INTO "DocumentNumbering"
            ("id", "tenantId", "type", "prefix", "padding", "separator",
             "periodStyle", "fiscalStartMonth", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(),
            p_tenant_id, p_type,
            CASE p_type WHEN 'INVOICE' THEN 'INV' WHEN 'QUOTATION' THEN 'QUO' WHEN 'ORDER' THEN 'ORD' ELSE 'DN' END,
            4, '-', 'CALENDAR_YEAR', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "type") DO NOTHING;

    SELECT n."prefix", n."padding", n."separator", n."periodStyle", n."fiscalStartMonth"
      INTO v_prefix, v_padding, v_separator, v_style, v_fiscal
      FROM "DocumentNumbering" n
     WHERE n."tenantId" = p_tenant_id AND n."type" = p_type;

    v_period := public.document_number_period(v_style, v_fiscal, p_date);

    INSERT INTO "DocumentNumberSequence"
            ("id", "tenantId", "type", "period", "nextValue", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(),
            p_tenant_id, p_type, v_period, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "type", "period") DO NOTHING;

    -- This row lock is what makes concurrent issuance safe. Two transactions
    -- allocating from the same series serialise here instead of both reading
    -- the same counter; the unique index on the document number is the backstop
    -- if the lock is ever bypassed.
    SELECT s."nextValue" INTO v_value
      FROM "DocumentNumberSequence" s
     WHERE s."tenantId" = p_tenant_id AND s."type" = p_type AND s."period" = v_period
       FOR UPDATE;

    -- Rather than silently widening the number (which would let a 5-digit value
    -- collide with a differently formatted series), stop and make the operator
    -- reconfigure the padding.
    IF v_value::numeric >= (10::numeric ^ v_padding) THEN
        RAISE EXCEPTION 'Document number series % / % / % is exhausted at %',
            p_type, p_tenant_id, v_period, v_value
            USING ERRCODE = 'program_limit_exceeded';
    END IF;

    UPDATE "DocumentNumberSequence"
       SET "nextValue" = "nextValue" + 1, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "tenantId" = p_tenant_id AND "type" = p_type AND "period" = v_period;

    -- The separator joins the parts that exist. Joining with `array_to_string`
    -- instead of concatenating means a `NONE` period produces `ACME.001` rather
    -- than `ACME001`, and an empty prefix never leaves a leading separator.
    v_number := array_to_string(
        ARRAY[NULLIF(v_prefix, ''), NULLIF(v_period, ''), lpad(v_value::text, v_padding, '0')],
        v_separator);

    IF v_number !~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$' THEN
        RAISE EXCEPTION 'Generated document number % is not a safe identifier', v_number
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP FUNCTION IF EXISTS public.peek_document_number(uuid, "DocumentType", date);
CREATE OR REPLACE FUNCTION public.peek_document_number(
    p_tenant_id uuid,
    p_type "DocumentType",
    p_date date
) RETURNS text AS $$
DECLARE
    v_prefix    text;
    v_padding   integer;
    v_separator text;
    v_style     "DocumentPeriodStyle";
    v_fiscal    integer;
    v_period    text;
    v_value     integer;
BEGIN
    IF p_tenant_id IS NULL OR p_type IS NULL THEN
        RAISE EXCEPTION 'peek_document_number requires a tenant and a document type'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT n."prefix", n."padding", n."separator", n."periodStyle", n."fiscalStartMonth"
      INTO v_prefix, v_padding, v_separator, v_style, v_fiscal
      FROM "DocumentNumbering" n
     WHERE n."tenantId" = p_tenant_id AND n."type" = p_type;

    IF v_prefix IS NULL THEN
        v_prefix := CASE p_type WHEN 'INVOICE' THEN 'INV' WHEN 'QUOTATION' THEN 'QUO' WHEN 'ORDER' THEN 'ORD' ELSE 'DN' END;
        v_padding := 4;
        v_separator := '-';
        v_style := 'CALENDAR_YEAR';
        v_fiscal := 1;
    END IF;

    v_period := document_number_period(v_style, v_fiscal, p_date);

    SELECT s."nextValue" INTO v_value
      FROM "DocumentNumberSequence" s
     WHERE s."tenantId" = p_tenant_id AND s."type" = p_type AND s."period" = v_period;

    v_value := COALESCE(v_value, 1);

    -- Same composition rule as `allocate_document_number()`; the two must never
    -- disagree, or the preview on the numbering screen would lie.
    RETURN array_to_string(
        ARRAY[NULLIF(v_prefix, ''), NULLIF(v_period, ''), lpad(v_value::text, v_padding, '0')],
        v_separator);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Re-establish the privilege posture the originals carried (recreation hands
-- EXECUTE back to PUBLIC by default — closed again in the same transaction):
-- no PUBLIC reach, the runtime role holds the two allocator entry points, and
-- the period helper stays reachable only from inside the definers.
REVOKE ALL ON FUNCTION public.allocate_document_number(uuid, "DocumentType", date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.peek_document_number(uuid, "DocumentType", date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_number_period("DocumentPeriodStyle", integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_document_number(uuid, "DocumentType", date) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.peek_document_number(uuid, "DocumentType", date) TO amisibiz_app;

COMMENT ON FUNCTION public.allocate_document_number(uuid, "DocumentType", date) IS
    'Allocates the next document number for a tenant series inside the caller''s transaction, locking the counter row with SELECT ... FOR UPDATE. Never called from the browser; the number it returns is the only authoritative one. ORDER series default to ORD-<year>-0001, lazily created like every other type.';
COMMENT ON FUNCTION public.peek_document_number(uuid, "DocumentType", date) IS
    'Returns the number the series would use next without taking it. Display only and not authoritative.';

-- ─── 9. Permission catalogue delta: 57 -> 74 keys, 122 -> 188 matrix rows ─────
-- Idempotent additive reseed in the 20261030000000 (H1) pattern. Every key,
-- domain, area and description below is copied from the
-- PERMISSION_DEFINITIONS entries in packages/auth/src/permissions.ts, and the
-- matrix rows from TENANT_ROLE_PERMISSIONS: OWNER and ADMIN hold all 17,
-- SALES 14 (everything except documents.order.void and data.import),
-- FINANCE 6 (leads.read, tasks.read, activities.read, and the order money
-- path create/issue/void), OPERATIONS 7 (leads.read, tasks x2,
-- activities.read, share_links.read, orders create/update_draft), VIEWER 5
-- (the five new reads). PORTAL / SUPPORT / SUPER_ADMIN gain nothing.
-- All 17 keys are tenant-domain, so H1 §0's explicit-membership domain CHECK
-- stays satisfied unchanged.
--
-- Derived counts (generated from permissions.ts, see the phase-1 report):
--   Permission total          74  (57 baseline + 17 new)
--   RolePermission total     188  (122 baseline + 66 new: 17+17+14+6+7+5)
--   TENANT_OWNER 48 | TENANT_ADMIN 48 | SALES 27 | FINANCE 17 |
--   OPERATIONS 19 | VIEWER 12

DO $$
BEGIN
    INSERT INTO "Permission" ("id", "key", "domain", "area", "description")
    SELECT gen_random_uuid(), v."key", v."domain", v."area", v."description"
      FROM (VALUES
        -- Tenant domain (AGENT 02),
        ('documents.order.create', 'tenant', 'documents.order', 'Create orders'),
        ('documents.order.update_draft', 'tenant', 'documents.order', 'Edit draft orders'),
        ('documents.order.issue', 'tenant', 'documents.order', 'Issue orders'),
        ('documents.order.void', 'tenant', 'documents.order', 'Void orders'),
        ('leads.read', 'tenant', 'leads', 'View leads and the sales pipeline board'),
        ('leads.create', 'tenant', 'leads', 'Create leads (including public-form capture attribution)'),
        ('leads.update', 'tenant', 'leads', 'Update leads: details, stage moves, assignment, loss'),
        ('leads.delete', 'tenant', 'leads', 'Delete leads'),
        ('leads.convert', 'tenant', 'leads', 'Convert a lead to a contact and optional draft document'),
        ('pipelines.read', 'tenant', 'pipelines', 'View pipeline and stage configuration'),
        ('pipelines.manage', 'tenant', 'pipelines', 'Create and edit pipelines and their stages'),
        ('tasks.read', 'tenant', 'tasks', 'View tasks'),
        ('tasks.manage', 'tenant', 'tasks', 'Create, update, complete and reopen tasks'),
        ('activities.read', 'tenant', 'activities', 'View the unified activity timeline'),
        ('share_links.read', 'tenant', 'share_links', 'View share links and their stats'),
        ('share_links.manage', 'tenant', 'share_links', 'Create and revoke share links'),
        ('data.import', 'tenant', 'data', 'Import business data from files (contacts and catalogue)')
      ) AS v("key", "domain", "area", "description")
     ON CONFLICT ("key") DO NOTHING;

    INSERT INTO "RolePermission" ("id", "roleKey", "domain", "permissionId")
    SELECT gen_random_uuid(), m."roleKey", p."domain", p."id"
      FROM (VALUES
        -- TENANT_OWNER (all 17 new)
        ('TENANT_OWNER', 'documents.order.create'),
        ('TENANT_OWNER', 'documents.order.update_draft'),
        ('TENANT_OWNER', 'documents.order.issue'),
        ('TENANT_OWNER', 'documents.order.void'),
        ('TENANT_OWNER', 'leads.read'),
        ('TENANT_OWNER', 'leads.create'),
        ('TENANT_OWNER', 'leads.update'),
        ('TENANT_OWNER', 'leads.delete'),
        ('TENANT_OWNER', 'leads.convert'),
        ('TENANT_OWNER', 'pipelines.read'),
        ('TENANT_OWNER', 'pipelines.manage'),
        ('TENANT_OWNER', 'tasks.read'),
        ('TENANT_OWNER', 'tasks.manage'),
        ('TENANT_OWNER', 'activities.read'),
        ('TENANT_OWNER', 'share_links.read'),
        ('TENANT_OWNER', 'share_links.manage'),
        ('TENANT_OWNER', 'data.import'),
        -- TENANT_ADMIN (all 17 new)
        ('TENANT_ADMIN', 'documents.order.create'),
        ('TENANT_ADMIN', 'documents.order.update_draft'),
        ('TENANT_ADMIN', 'documents.order.issue'),
        ('TENANT_ADMIN', 'documents.order.void'),
        ('TENANT_ADMIN', 'leads.read'),
        ('TENANT_ADMIN', 'leads.create'),
        ('TENANT_ADMIN', 'leads.update'),
        ('TENANT_ADMIN', 'leads.delete'),
        ('TENANT_ADMIN', 'leads.convert'),
        ('TENANT_ADMIN', 'pipelines.read'),
        ('TENANT_ADMIN', 'pipelines.manage'),
        ('TENANT_ADMIN', 'tasks.read'),
        ('TENANT_ADMIN', 'tasks.manage'),
        ('TENANT_ADMIN', 'activities.read'),
        ('TENANT_ADMIN', 'share_links.read'),
        ('TENANT_ADMIN', 'share_links.manage'),
        ('TENANT_ADMIN', 'data.import'),
        -- SALES (14 new: everything except documents.order.void and data.import)
        ('SALES', 'leads.read'),
        ('SALES', 'leads.create'),
        ('SALES', 'leads.update'),
        ('SALES', 'leads.delete'),
        ('SALES', 'leads.convert'),
        ('SALES', 'pipelines.read'),
        ('SALES', 'tasks.read'),
        ('SALES', 'tasks.manage'),
        ('SALES', 'activities.read'),
        ('SALES', 'share_links.read'),
        ('SALES', 'share_links.manage'),
        ('SALES', 'documents.order.create'),
        ('SALES', 'documents.order.update_draft'),
        ('SALES', 'documents.order.issue'),
        -- FINANCE (6 new: read context plus the order money path)
        ('FINANCE', 'leads.read'),
        ('FINANCE', 'tasks.read'),
        ('FINANCE', 'activities.read'),
        ('FINANCE', 'documents.order.create'),
        ('FINANCE', 'documents.order.issue'),
        ('FINANCE', 'documents.order.void'),
        -- OPERATIONS (7 new: fulfilment context plus order preparation)
        ('OPERATIONS', 'leads.read'),
        ('OPERATIONS', 'tasks.read'),
        ('OPERATIONS', 'tasks.manage'),
        ('OPERATIONS', 'activities.read'),
        ('OPERATIONS', 'share_links.read'),
        ('OPERATIONS', 'documents.order.create'),
        ('OPERATIONS', 'documents.order.update_draft'),
        -- VIEWER (5 new: reads)
        ('VIEWER', 'leads.read'),
        ('VIEWER', 'pipelines.read'),
        ('VIEWER', 'tasks.read'),
        ('VIEWER', 'activities.read'),
        ('VIEWER', 'share_links.read')
        -- CUSTOMER_PORTAL_USER, SUPPORT, SUPER_ADMIN: no new rows by design
      ) AS m("roleKey", "permission")
      JOIN "Permission" p ON p."key" = m."permission"
     ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

    -- Exact-count asserts (H1 pattern): a total above the expectation means the
    -- database holds a row outside the code catalogue — additive reseed cannot
    -- fix that, so fail loud and roll the migration back.
    IF (SELECT count(*) FROM "Permission") <> 74 THEN
        RAISE EXCEPTION
            'AGENT 02 reseed: "Permission" holds % row(s) after the upsert, expected exactly 74 — a key in the database is not in the code catalog (additive reseed cannot remove it)',
            (SELECT count(*) FROM "Permission")
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission") <> 188 THEN
        RAISE EXCEPTION
            'AGENT 02 reseed: "RolePermission" holds % row(s) after the upsert, expected exactly 188 — the database carries a matrix row outside the code catalog',
            (SELECT count(*) FROM "RolePermission")
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_OWNER') <> 48 THEN
        RAISE EXCEPTION 'AGENT 02 reseed: TENANT_OWNER holds % permissions, expected exactly 48',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_OWNER')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_ADMIN') <> 48 THEN
        RAISE EXCEPTION 'AGENT 02 reseed: TENANT_ADMIN holds % permissions, expected exactly 48',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_ADMIN')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SALES') <> 27 THEN
        RAISE EXCEPTION 'AGENT 02 reseed: SALES holds % permissions, expected exactly 27',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SALES')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'FINANCE') <> 17 THEN
        RAISE EXCEPTION 'AGENT 02 reseed: FINANCE holds % permissions, expected exactly 17',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'FINANCE')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'OPERATIONS') <> 19 THEN
        RAISE EXCEPTION 'AGENT 02 reseed: OPERATIONS holds % permissions, expected exactly 19',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'OPERATIONS')
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'VIEWER') <> 12 THEN
        RAISE EXCEPTION 'AGENT 02 reseed: VIEWER holds % permissions, expected exactly 12',
            (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'VIEWER')
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── 10. Row level security ──────────────────────────────────────────────────
-- One policy set per new tenant table, exactly the 20261018000002 §4 pattern:
-- every policy targets `amisibiz_app` only; read = the read family, write =
-- the write family. Roles with no matching policy see nothing.

ALTER TABLE "CatalogueCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tag"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactTag"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ItemImage"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductVariant"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Pipeline"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PipelineStage"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActivityEvent"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShareLink"         ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'CatalogueCategory', 'Tag', 'ContactTag', 'ItemImage', 'ProductVariant',
        'Pipeline', 'PipelineStage', 'Lead', 'Task', 'ActivityEvent', 'ShareLink'
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

-- ─── 11. Public surfaces: SECURITY DEFINER functions ─────────────────────────
-- `/s/[token]` is a resource route: the token resolves a ShareLink row
-- server-side and the row carries the tenantId — tenant resolution never uses
-- paths, and anonymous readers have no RLS context, so they reach nothing
-- except through these four functions. Each validates its own input (only the
-- token / payload, never a client-supplied tenant, id, status or revision),
-- returns a minimized jsonb payload, and refuses an unresolvable or revoked
-- token with the SAME error an expired one gets — guessing attacks learn
-- nothing. This follows the `app_find_user_id_by_email` precedent
-- (20261018000002 §1): PUBLIC keeps no EXECUTE; only `amisibiz_app` has it.

-- The resolver: token -> {tenantId, id, kind, itemId?|documentId?} plus the
-- viewCount bump. VOLATILE because it bumps the counter; retry double-count is
-- tolerated and documented (design spec §1.7) — no client-supplied attribution.
CREATE OR REPLACE FUNCTION public.app_public_share_link_resolve(p_token text)
RETURNS jsonb AS $$
DECLARE
    v_link "ShareLink";
BEGIN
    IF p_token IS NULL OR btrim(p_token) = '' THEN
        RAISE EXCEPTION 'A share token is required'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_link
      FROM "ShareLink" s
     WHERE s."token" = btrim(p_token)
       AND s."active"
       AND (s."expiresAt" IS NULL OR s."expiresAt" > CURRENT_TIMESTAMP);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'This share link does not resolve to an active page'
            USING ERRCODE = 'P0002';
    END IF;

    UPDATE "ShareLink"
       SET "viewCount" = "viewCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = v_link."id";

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'tenantId',   v_link."tenantId",
        'id',         v_link."id",
        'kind',       v_link."kind"::text,
        'itemId',     v_link."itemId",
        'documentId', v_link."documentId"));
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp;

-- The public product page: name, description, unit, explicit currency, and the
-- ACTIVE variants' price list — plus only the brand fields a customer-facing
-- page needs. PRODUCT links only; nothing else about the workspace leaks.
CREATE OR REPLACE FUNCTION public.app_public_product_view(p_token text)
RETURNS jsonb AS $$
DECLARE
    v_link     "ShareLink";
    v_item     jsonb;
    v_tenant   jsonb;
    v_variants jsonb;
BEGIN
    SELECT * INTO v_link
      FROM "ShareLink" s
     WHERE s."token" = btrim(p_token)
       AND s."kind" = 'PRODUCT'
       AND s."active"
       AND (s."expiresAt" IS NULL OR s."expiresAt" > CURRENT_TIMESTAMP)
       AND s."itemId" IS NOT NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'This share link does not resolve to an active product page'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT jsonb_build_object(
               'id',            i."id",
               'name',          i."name",
               'description',   i."description",
               'sku',           i."sku",
               'unitOfMeasure', i."unitOfMeasure",
               'currency',      i."currency",
               'status',        i."status"::text)
      INTO v_item
      FROM "Item" i
     WHERE i."id" = v_link."itemId"
       AND i."tenantId" = v_link."tenantId";

    IF v_item IS NULL THEN
        -- The item vanished underneath the link (a RESTRICT-free hard delete):
        -- the page is gone, said the same way a revoked token is.
        RAISE EXCEPTION 'This share link does not resolve to an active product page'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT jsonb_build_object(
               'name',         t."name",
               'displayName',  b."displayName",
               'logoUrl',      b."logoUrl",
               'contactEmail', b."contactEmail",
               'contactPhone', b."contactPhone",
               'website',      b."website")
      INTO v_tenant
      FROM "Tenant" t
      LEFT JOIN "TenantBranding" b ON b."tenantId" = t."id"
     WHERE t."id" = v_link."tenantId";

    SELECT COALESCE(
               jsonb_agg(jsonb_build_object(
                   'id',        v."id",
                   'name',      v."name",
                   'sku',       v."sku",
                   'unitPrice', v."unitPrice",
                   'currency',  v."currency")
                   ORDER BY v."position", v."name"),
               '[]'::jsonb)
      INTO v_variants
      FROM "ProductVariant" v
     WHERE v."itemId" = v_link."itemId"
       AND v."tenantId" = v_link."tenantId"
       AND v."status" = 'ACTIVE';

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'tenantId',    v_link."tenantId",
        'shareLinkId', v_link."id",
        'expiresAt',   v_link."expiresAt",
        'message',     v_link."message",
        'item',        v_item,
        'variants',    v_variants,
        'tenant',      v_tenant));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- The public order-status page: number, status, explicit currency, total,
-- dates, and the delivery ratio DERIVED from the line counters — never the
-- lines themselves, never a DRAFT. ISSUED-or-later only: a draft order is not
-- public information yet.
CREATE OR REPLACE FUNCTION public.app_public_order_status(p_token text)
RETURNS jsonb AS $$
DECLARE
    v_link  "ShareLink";
    v_doc   jsonb;
    v_qty   numeric;
    v_del   numeric;
BEGIN
    SELECT * INTO v_link
      FROM "ShareLink" s
     WHERE s."token" = btrim(p_token)
       AND s."kind" = 'ORDER_STATUS'
       AND s."active"
       AND (s."expiresAt" IS NULL OR s."expiresAt" > CURRENT_TIMESTAMP)
       AND s."documentId" IS NOT NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'This share link does not resolve to an active order page'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT jsonb_build_object(
               'id',        d."id",
               'number',    d."number",
               'status',    d."status"::text,
               'currency',  d."currency",
               'total',     d."total",
               'issueDate', to_char(d."issueDate", 'YYYY-MM-DD'),
               'dueDate',   to_char(d."dueDate", 'YYYY-MM-DD'))
      INTO v_doc
      FROM "Document" d
     WHERE d."id" = v_link."documentId"
       AND d."tenantId" = v_link."tenantId"
       AND d."type" = 'ORDER'
       AND d."status" <> 'DRAFT';

    IF v_doc IS NULL THEN
        RAISE EXCEPTION 'This share link does not resolve to an issued order'
            USING ERRCODE = 'P0002';
    END IF;

    -- Delivery truth is the accumulated deliveredQuantity on the lines
    -- (design spec §0): a ratio, not an availability claim.
    SELECT COALESCE(sum(l."quantity"), 0), COALESCE(sum(l."deliveredQuantity"), 0)
      INTO v_qty, v_del
      FROM "DocumentLine" l
     WHERE l."documentId" = v_link."documentId";

    RETURN jsonb_strip_nulls(v_doc || jsonb_build_object(
        'tenantId',         v_link."tenantId",
        'shareLinkId',      v_link."id",
        'expiresAt',        v_link."expiresAt",
        'message',          v_link."message",
        'quantity',         v_qty,
        'deliveredQuantity', v_del,
        'deliveredRatio',   CASE WHEN v_qty > 0 THEN round(v_del / v_qty, 4) ELSE 0 END,
        'fullyDelivered',   v_qty > 0 AND v_del >= v_qty));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- The public capture form: the only anonymous write in the system, and even
-- it writes exactly one thing — a NEW Lead from a whitelisted payload. Tenant
-- resolution is a valid active LEAD_FORM link (its UTM attribution wins) or a
-- real tenant id; nothing else is trusted: status is forced NEW, priority and
-- currency are validated, every field is trimmed and bounded, and the
-- idempotency key / (source, externalId) identity makes a retry return the
-- original lead with duplicateSuspect instead of creating a second one.
CREATE OR REPLACE FUNCTION public.app_public_lead_capture(p_payload jsonb)
RETURNS jsonb AS $$
DECLARE
    v_link        "ShareLink";
    v_tenant      uuid;
    v_raw_tenant  text;
    v_raw_token   text;
    v_source      "LeadSource" := 'WEB_FORM';
    v_currency    text         := 'KES';
    v_key         text;
    v_external    text;
    v_email       text;
    v_phone       text;
    v_first       text;
    v_last        text;
    v_company     text;
    v_description text;
    v_detail      text;
    v_utm_source  text;
    v_utm_medium  text;
    v_utm_campaign text;
    v_lead_id     uuid;
    v_duplicate   boolean := false;
BEGIN
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'Lead capture requires a JSON object payload'
            USING ERRCODE = 'check_violation';
    END IF;

    v_key      := nullif(btrim(coalesce(p_payload->>'idempotencyKey', '')), '');
    v_external := nullif(btrim(coalesce(p_payload->>'externalId', '')), '');

    -- Tenant resolution: a share token wins outright (the capture page reached
    -- its tenant through the link, not through the browser). A raw tenantId is
    -- accepted only when it is a well-formed id of an existing workspace.
    v_raw_token  := nullif(btrim(coalesce(p_payload->>'shareToken', '')), '');
    v_raw_tenant := nullif(btrim(coalesce(p_payload->>'tenantId', '')), '');

    IF v_raw_token IS NOT NULL THEN
        SELECT * INTO v_link
          FROM "ShareLink" s
         WHERE s."token" = v_raw_token
           AND s."kind" = 'LEAD_FORM'
           AND s."active"
           AND (s."expiresAt" IS NULL OR s."expiresAt" > CURRENT_TIMESTAMP);

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Lead capture requires a valid share token or tenant'
                USING ERRCODE = 'P0002';
        END IF;

        v_tenant := v_link."tenantId";
        -- Attribution comes from the link first; a form may add detail, not
        -- overwrite the channel that earned the lead.
        v_utm_source   := coalesce(nullif(btrim(coalesce(p_payload->>'utmSource', '')), ''),   v_link."utmSource");
        v_utm_medium   := coalesce(nullif(btrim(coalesce(p_payload->>'utmMedium', '')), ''),   v_link."utmMedium");
        v_utm_campaign := coalesce(nullif(btrim(coalesce(p_payload->>'utmCampaign', '')), ''), v_link."utmCampaign");
    ELSE
        IF v_raw_tenant IS NULL
           OR v_raw_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Lead capture requires a valid share token or tenant'
                USING ERRCODE = 'P0002';
        END IF;

        v_tenant := v_raw_tenant::uuid;

        IF NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t."id" = v_tenant) THEN
            RAISE EXCEPTION 'Lead capture requires a valid share token or tenant'
                USING ERRCODE = 'P0002';
        END IF;

        v_utm_source   := nullif(btrim(coalesce(p_payload->>'utmSource', '')), '');
        v_utm_medium   := nullif(btrim(coalesce(p_payload->>'utmMedium', '')), '');
        v_utm_campaign := nullif(btrim(coalesce(p_payload->>'utmCampaign', '')), '');
    END IF;

    -- Closed-vocabulary fields validated, not trusted: an unknown source is
    -- the form default, never a server error the prober can read.
    IF coalesce(p_payload->>'source', '') IN
       ('WEB_FORM', 'REFERRAL', 'SOCIAL', 'CAMPAIGN', 'WALK_IN', 'PHONE', 'EMAIL', 'IMPORT', 'OTHER') THEN
        v_source := (p_payload->>'source')::"LeadSource";
    END IF;

    IF coalesce(p_payload->>'currency', '') ~ '^[A-Z]{3}$' THEN
        v_currency := p_payload->>'currency';
    END IF;

    v_email       := left(nullif(btrim(coalesce(p_payload->>'email', '')), ''),        254);
    v_phone       := left(nullif(btrim(coalesce(p_payload->>'phone', '')), ''),        32);
    v_first       := left(nullif(btrim(coalesce(p_payload->>'firstName', '')), ''),    100);
    v_last        := left(nullif(btrim(coalesce(p_payload->>'lastName', '')), ''),     100);
    v_company     := left(nullif(btrim(coalesce(p_payload->>'companyName', '')), ''),  160);
    v_description := left(nullif(btrim(coalesce(p_payload->>'description', '')), ''),  2000);
    v_detail      := left(nullif(btrim(coalesce(p_payload->>'sourceDetail', '')), ''), 500);
    v_utm_source   := left(v_utm_source, 200);
    v_utm_medium   := left(v_utm_medium, 200);
    v_utm_campaign := left(v_utm_campaign, 200);

    -- Targetless ON CONFLICT DO NOTHING covers BOTH retry identities at once
    -- ((tenantId, idempotencyKey) and (tenantId, source, externalId)); a
    -- collision returns the original instead of raising.
    INSERT INTO "Lead"
            ("id", "tenantId", "status", "priority", "firstName", "lastName",
             "companyName", "email", "phone", "description", "currency",
             "source", "sourceDetail", "utmSource", "utmMedium", "utmCampaign",
             "idempotencyKey", "externalId", "createdAt", "updatedAt", "revision")
    VALUES (gen_random_uuid(), v_tenant, 'NEW', 'MEDIUM',
            v_first, v_last, v_company, v_email, v_phone, v_description, v_currency,
            v_source, v_detail, v_utm_source, v_utm_medium, v_utm_campaign,
            v_key, v_external, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
    ON CONFLICT DO NOTHING
    RETURNING "id" INTO v_lead_id;

    IF v_lead_id IS NULL THEN
        -- Replay: name the row that blocked the insert.
        SELECT l."id" INTO v_lead_id
          FROM "Lead" l
         WHERE l."tenantId" = v_tenant
           AND (   (v_key      IS NOT NULL AND l."idempotencyKey" = v_key)
                OR (v_external IS NOT NULL AND l."source" = v_source AND l."externalId" = v_external))
         ORDER BY l."createdAt"
         LIMIT 1;

        IF v_lead_id IS NULL THEN
            -- A collision with no visible original (e.g. a same-email unique we
            -- do not own): refuse rather than guess.
            RAISE EXCEPTION 'Lead capture collided with a lead it cannot resolve'
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN jsonb_build_object('leadId', v_lead_id, 'duplicateSuspect', true);
    END IF;

    -- A fresh lead is never auto-merged: a strong identity overlap (exact
    -- normalized email or phone) only raises the suspect flag for human
    -- review (design spec §0).
    SELECT EXISTS (
        SELECT 1
          FROM "Lead" l
         WHERE l."tenantId" = v_tenant
           AND l."id" <> v_lead_id
           AND (   (v_email IS NOT NULL AND lower(l."email") = lower(v_email))
                OR (v_phone IS NOT NULL AND l."phone" = v_phone))
    ) INTO v_duplicate;

    RETURN jsonb_build_object('leadId', v_lead_id, 'duplicateSuspect', v_duplicate);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp;

-- Privileges: PUBLIC gets none of these; the PostgREST-facing roles are
-- revoked where they exist (the vanilla-PG-safe loop of 20261019000000 §8);
-- only `amisibiz_app` can call them, and the route layer is the only caller.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.app_public_share_link_resolve(text) FROM %I', r.rolname);
        EXECUTE format('REVOKE ALL ON FUNCTION public.app_public_product_view(text) FROM %I', r.rolname);
        EXECUTE format('REVOKE ALL ON FUNCTION public.app_public_order_status(text) FROM %I', r.rolname);
        EXECUTE format('REVOKE ALL ON FUNCTION public.app_public_lead_capture(jsonb) FROM %I', r.rolname);
    END LOOP;
END
$$;

REVOKE ALL ON FUNCTION public.app_public_share_link_resolve(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_public_product_view(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_public_order_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_public_lead_capture(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.app_public_share_link_resolve(text) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_public_product_view(text) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_public_order_status(text) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_public_lead_capture(jsonb) TO amisibiz_app;

COMMENT ON FUNCTION public.app_public_share_link_resolve(text) IS 'Public token resolver: active and unexpired ShareLink -> minimized {tenantId, id, kind, itemId?|documentId?}, bumping viewCount. Unknown, revoked and expired tokens get the same refusal.';
COMMENT ON FUNCTION public.app_public_product_view(text) IS 'Public product page for a PRODUCT link: item essentials, ACTIVE variant prices with explicit currency, and the brand fields a customer page needs. Nothing else about the workspace leaks.';
COMMENT ON FUNCTION public.app_public_order_status(text) IS 'Public status page for an ORDER_STATUS link: number, status, currency, total, dates and the line-derived delivery ratio. ISSUED-or-later only — a draft order is never public.';
COMMENT ON FUNCTION public.app_public_lead_capture(jsonb) IS 'The only anonymous write: one NEW Lead from a whitelisted payload, tenant resolved through an active LEAD_FORM link or a real workspace; retry identities return the original with duplicateSuspect.';

-- ─── 12. Runtime grants ──────────────────────────────────────────────────────
-- Explicit, because no default privileges exist for the runtime role any more
-- (20261018000002 §8). Verb lists are the ceiling the application can use;
-- RLS policies narrow within them. The CRM writes through services and the
-- capture function, so Lead/Task lose DELETE; the timeline keeps
-- SELECT+INSERT — append-only at the privilege layer as well as the trigger.

REVOKE ALL ON "CatalogueCategory", "Tag", "ContactTag", "ItemImage",
              "ProductVariant", "Pipeline", "PipelineStage",
              "Lead", "Task", "ActivityEvent", "ShareLink"
    FROM amisibiz_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "CatalogueCategory" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Tag"               TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ContactTag"        TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ItemImage"         TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProductVariant"    TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Pipeline"          TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "PipelineStage"     TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ShareLink"         TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE         ON "Lead"              TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE         ON "Task"              TO amisibiz_app;
GRANT SELECT, INSERT                 ON "ActivityEvent"     TO amisibiz_app;

-- ─── 13. Anon / authenticated revoke (successor of 20261018000002 §8(d)) ─────
-- The PostgREST-facing roles must hold nothing on the new tables — the same
-- convention as the v_amisi list there, carried forward for the AGENT 02
-- additions. Conditional loop because a vanilla PostgreSQL has neither role.
DO $$
DECLARE
    r       record;
    t       text;
    v_amisi text[] := ARRAY[
        'CatalogueCategory', 'Tag', 'ContactTag', 'ItemImage', 'ProductVariant',
        'Pipeline', 'PipelineStage', 'Lead', 'Task', 'ActivityEvent', 'ShareLink'
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

COMMENT ON TABLE "CatalogueCategory" IS 'Tenant catalogue tree (AGENT 02): one name per tenant, self-parenting, item deletion never eats categories (SetNull).';
COMMENT ON TABLE "Tag" IS 'Tenant contact tags; case-insensitive name uniqueness by functional index, never tenant-global.';
COMMENT ON TABLE "ContactTag" IS 'Contact-tag junction carrying its own tenantId for the RLS template; a trigger proves both parents match.';
COMMENT ON TABLE "ItemImage" IS 'Catalogue images stored through the Vercel Blob seam (fail-closed without BLOB_READ_WRITE_TOKEN); blobUrl is the public read URL.';
COMMENT ON TABLE "ProductVariant" IS 'Priced variant of a catalogue item; explicit currency, ACTIVE/INACTIVE only — archiving is an item decision.';
COMMENT ON TABLE "Pipeline" IS 'Lead pipeline; one default per live workspace via partial unique.';
COMMENT ON TABLE "PipelineStage" IS 'Ordered stage within a pipeline; isWin/isLost terminal markers for metrics.';
COMMENT ON TABLE "Lead" IS 'Sales lead: NEW on arrival, CONVERTED/LOST terminal; retry identities (idempotencyKey, source+externalId) are the duplicate guard; conversion is explicit and never automatic.';
COMMENT ON TABLE "Task" IS 'Follow-up task that always belongs to something (participant CHECK); overdue is computed from timestamps at read, never a cron job.';
COMMENT ON TABLE "ActivityEvent" IS 'Unified append-only timeline (module F): open-vocabulary eventType, (tenantId, source, sourceKey) retry-dedup, SELECT+INSERT grants only.';
COMMENT ON TABLE "ShareLink" IS 'Public share links (/s/[token], resource route — never tenant routing): server-side base62 token, per-kind active uniques, viewCount bumped only by the resolver function.';
