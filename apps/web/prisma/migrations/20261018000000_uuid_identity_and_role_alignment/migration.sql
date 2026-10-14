-- Migration: Phase 1 — UUID identity and role alignment.
-- Created: 2026-10-18
--
-- Why this file exists: the Phase 1 directive requires UUID primary keys,
-- foreign keys and unique constraints throughout the schema, and the 9-role
-- model. Until now every `id`/foreign-key column was TEXT holding cuid values
-- (the only exception being `User.id`, which has equalled the Supabase Auth
-- UUID since Phase 04.5a). This migration is the data-preserving conversion:
--
--   * `User.id` is cast in place (its values are already UUID strings —
--     guarded by the preflight block below, which refuses to run on a
--     database that would lose or corrupt identities).
--   * Every user-referencing column (`Tenant.activatedById`, …) is cast in
--     place too, for the same reason.
--   * Every business-entity id (`Tenant.id`, `Contact.id`, …) and every
--     reference to one (all `tenantId` columns, `DocumentLine.documentId`, …)
--     is remapped through a session mapping table: a new UUID is generated
--     per row and every foreign key follows the *join* to the new value, not
--     a re-guess from text shape. Row data is never dropped and no table is
--     recreated.
--   * `PlatformRole`/`TenantRole` are remapped to the Phase 1 model
--     (BUSINESS_OWNER → TENANT_OWNER, … ; platform USER → NULL).
--   * `Tenant.createdById` is added: the anchor that lets RLS prove a
--     registrant created the tenant they are claiming an owner membership
--     for (used by the policies in 20261018000002).
--
-- Row level security: every policy that exists today was written against the
-- TEXT columns and some of them (e.g. `tenant_member_self_update`) allow
-- exactly the self-elevation the directive forbids, so they are all dropped
-- here and the complete Phase 1 policy set is created in
-- 20261018000002_rls_enforcement_storage_and_grants. Between this migration
-- and that one the tables carry RLS with no policies; the migration chain is
-- applied as a unit and the policies exist again by the end of it.
--
-- Trigger functions that took TEXT id parameters, or compared a TEXT variable
-- with an id column, are reworked to the UUID types in the same file —
-- leaving them would make every tenant-consistency trigger raise a type
-- error on the first write.
--
-- NOTE: this migration expects an empty or dev-scale database. It is written
-- to be correct on a live database too (join-based backfill), but the
-- preflight deliberately fails loudly if identity data would be ambiguous.

-- ─── 0. Preflight ────────────────────────────────────────────────────────────
-- `User.id` and every user-referencing column must already hold UUID strings.
-- If any row does not, the conversion cannot be done by cast and this
-- migration stops with a message naming the offending column instead of
-- corrupting or silently nulling identities. (The documented reconciliation
-- for legacy cuid users is the seed's `reconcileProfile`, or a manual UPDATE
-- before deploying this migration.)

DO $$
DECLARE
    v_re      text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_tbl     text;
    v_col     text;
    v_count   bigint;
    v_checks  text[][] := ARRAY[
        ['User', 'id'],
        ['Tenant', 'activatedById'],
        ['Tenant', 'suspendedById'],
        ['TenantMember', 'userId'],
        ['Invitation', 'invitedBy'],
        ['AuditLog', 'userId'],
        ['Document', 'issuedById'],
        ['Document', 'voidedById'],
        ['DocumentPayment', 'reversedBy'],
        ['DocumentStatusEvent', 'actorId']
    ];
    i integer;
BEGIN
    FOR i IN 1..array_length(v_checks, 1) LOOP
        v_tbl := v_checks[i][1];
        v_col := v_checks[i][2];
        EXECUTE format(
            'SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND %I !~* %L',
            v_tbl, v_col, v_col, v_re
        ) INTO v_count;
        IF v_count > 0 THEN
            RAISE EXCEPTION
                'UUID conversion blocked: %.% holds % non-UUID value(s). Reconcile the user identity data before applying this migration.',
                v_tbl, v_col, v_count
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
END
$$;

-- Orphaned actor references: `DocumentStatusEvent.actorId` and
-- `DocumentPayment.reversedBy` carried no foreign key until this migration,
-- so a row can (in theory) point at a user that does not exist. The new
-- foreign keys would refuse such rows; catch that here with a clear message.
DO $$
DECLARE
    v_count bigint;
BEGIN
    SELECT count(*) INTO v_count
      FROM "DocumentStatusEvent" e
     WHERE e."actorId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = e."actorId");
    IF v_count > 0 THEN
        RAISE EXCEPTION
            'UUID conversion blocked: % DocumentStatusEvent row(s) reference a non-existent actor. Inspect and clear those actorIds before applying this migration.',
            v_count USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO v_count
      FROM "DocumentPayment" p
     WHERE p."reversedBy" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = p."reversedBy");
    IF v_count > 0 THEN
        RAISE EXCEPTION
            'UUID conversion blocked: % DocumentPayment row(s) reference a non-existent reverser. Inspect and clear those reversedBy values before applying this migration.',
            v_count USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── 1. Role enum remap (9-role model) ───────────────────────────────────────
-- New type + USING cast: the legacy values are mapped explicitly, an unknown
-- value fails the NOT NULL constraint loudly rather than being dropped.

ALTER TYPE "PlatformRole" RENAME TO "PlatformRole_legacy";
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT');

ALTER TABLE "User" ALTER COLUMN "platformRole" DROP DEFAULT;   -- was 'USER'
ALTER TABLE "User" ALTER COLUMN "platformRole" DROP NOT NULL;  -- NULL = no platform privileges
ALTER TABLE "User" ALTER COLUMN "platformRole" TYPE "PlatformRole"
    USING (CASE "platformRole"::text
        WHEN 'PLATFORM_ADMIN'   THEN 'SUPER_ADMIN'::"PlatformRole"
        WHEN 'PLATFORM_SUPPORT' THEN 'SUPPORT'::"PlatformRole"
        ELSE NULL            -- legacy 'USER'
    END);

DROP TYPE "PlatformRole_legacy";

ALTER TYPE "TenantRole" RENAME TO "TenantRole_legacy";
CREATE TYPE "TenantRole" AS ENUM (
    'TENANT_OWNER', 'TENANT_ADMIN', 'SALES', 'FINANCE', 'OPERATIONS', 'VIEWER', 'CUSTOMER_PORTAL_USER'
);

ALTER TABLE "TenantMember" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "TenantMember" ALTER COLUMN "role" TYPE "TenantRole"
    USING (CASE "role"::text
        WHEN 'BUSINESS_OWNER'   THEN 'TENANT_OWNER'::"TenantRole"
        WHEN 'BUSINESS_ADMIN'   THEN 'TENANT_ADMIN'::"TenantRole"
        WHEN 'DOCUMENT_MANAGER' THEN 'OPERATIONS'::"TenantRole"
        WHEN 'SALES_STAFF'      THEN 'SALES'::"TenantRole"
        WHEN 'VIEWER'           THEN 'VIEWER'::"TenantRole"
    END);
ALTER TABLE "TenantMember" ALTER COLUMN "role" SET DEFAULT 'VIEWER';

ALTER TABLE "Invitation" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Invitation" ALTER COLUMN "role" TYPE "TenantRole"
    USING (CASE "role"::text
        WHEN 'BUSINESS_OWNER'   THEN 'TENANT_OWNER'::"TenantRole"
        WHEN 'BUSINESS_ADMIN'   THEN 'TENANT_ADMIN'::"TenantRole"
        WHEN 'DOCUMENT_MANAGER' THEN 'OPERATIONS'::"TenantRole"
        WHEN 'SALES_STAFF'      THEN 'SALES'::"TenantRole"
        WHEN 'VIEWER'           THEN 'VIEWER'::"TenantRole"
    END);
ALTER TABLE "Invitation" ALTER COLUMN "role" SET DEFAULT 'VIEWER';

DROP TYPE "TenantRole_legacy";

-- ─── 2. Drop every existing RLS policy (recreated in migration 3) ────────────
-- Two of them are security defects in their own right:
--   * `tenant_member_self_update` lets a member change their OWN role;
--   * the `FOR ALL` tenant-isolation policies carry no role gates at all.
-- Nothing re-creates them: the Phase 1 policy set replaces them wholesale.

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT policyname, tablename
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = ANY (ARRAY[
               'Tenant', 'TenantSettings', 'TenantBranding', 'TenantDomain',
               'User', 'TenantMember', 'Invitation', 'AuditLog',
               'TaxCategory', 'TaxRate', 'Contact', 'ContactAddress',
               'Item', 'ContactItem', 'Document', 'DocumentLine',
               'DocumentPayment', 'DocumentStatusEvent',
               'DocumentNumbering', 'DocumentNumberSequence'
           ])
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
    END LOOP;
END
$$;

-- ─── 3. Drop every internal foreign key ──────────────────────────────────────
-- All of them reference a column being converted; they are recreated with
-- the final shapes in §12. Only FKs between this application's own tables are
-- touched — the shared Supabase project contains another application's tables
-- and their constraints are none of this migration's business.

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.conname, c.conrelid::regclass::text AS tbl
          FROM pg_constraint c
         WHERE c.contype = 'f'
           AND c.connamespace = 'public'::regnamespace
           AND c.conrelid = ANY (ARRAY[
               '"Tenant"', '"TenantSettings"', '"TenantBranding"', '"TenantDomain"',
               '"User"', '"TenantMember"', '"Invitation"', '"AuditLog"',
               '"TaxCategory"', '"TaxRate"', '"Contact"', '"ContactAddress"',
               '"Item"', '"ContactItem"', '"Document"', '"DocumentLine"',
               '"DocumentPayment"', '"DocumentStatusEvent"',
               '"DocumentNumbering"', '"DocumentNumberSequence"'
           ]::regclass[])
    LOOP
        EXECUTE format('ALTER TABLE public.%s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
END
$$;

-- Column-specific triggers (`BEFORE ... UPDATE OF "tenantId", …`) carry a
-- dependency on each listed column, and PostgreSQL refuses to drop a column
-- while such a trigger exists. They are dropped here and recreated in §13
-- against the converted columns. The trigger functions themselves are
-- unchanged: their comparisons are late-bound against the column types, so
-- they are already correct for UUIDs once the triggers are back.
DROP TRIGGER IF EXISTS "ContactItem_single_tenant_assignment" ON "ContactItem";
DROP TRIGGER IF EXISTS "Item_single_tenant_tax_rate" ON "Item";
DROP TRIGGER IF EXISTS "TaxRate_single_tenant_category" ON "TaxRate";

-- ─── 4. Join-based id mapping for every referenced entity ────────────────────
-- A fresh UUID is generated per row ONCE and every reference to that row is
-- backfilled by joining on the old value — the ids of a parent and its
-- children can never disagree. Session-scoped temp tables: they disappear
-- when the migration's session ends.

CREATE TEMP TABLE map_tenant       AS SELECT "id" AS old_id, gen_random_uuid() AS new_id FROM "Tenant";
CREATE TEMP TABLE map_taxcategory  AS SELECT "id" AS old_id, gen_random_uuid() AS new_id FROM "TaxCategory";
CREATE TEMP TABLE map_taxrate      AS SELECT "id" AS old_id, gen_random_uuid() AS new_id FROM "TaxRate";
CREATE TEMP TABLE map_contact      AS SELECT "id" AS old_id, gen_random_uuid() AS new_id FROM "Contact";
CREATE TEMP TABLE map_item         AS SELECT "id" AS old_id, gen_random_uuid() AS new_id FROM "Item";
CREATE TEMP TABLE map_document     AS SELECT "id" AS old_id, gen_random_uuid() AS new_id FROM "Document";
CREATE TEMP TABLE map_documentline AS SELECT "id" AS old_id, gen_random_uuid() AS new_id FROM "DocumentLine";

CREATE UNIQUE INDEX map_tenant_old       ON map_tenant (old_id);
CREATE UNIQUE INDEX map_taxcategory_old  ON map_taxcategory (old_id);
CREATE UNIQUE INDEX map_taxrate_old      ON map_taxrate (old_id);
CREATE UNIQUE INDEX map_contact_old      ON map_contact (old_id);
CREATE UNIQUE INDEX map_item_old         ON map_item (old_id);
CREATE UNIQUE INDEX map_document_old     ON map_document (old_id);
CREATE UNIQUE INDEX map_documentline_old ON map_documentline (old_id);

-- ─── 5. Identity columns: cast in place ──────────────────────────────────────
-- Authoritative Supabase Auth UUIDs are already in these columns; a cast is
-- the least invasive conversion and the preflight above guarantees it cannot
-- fail halfway.

ALTER TABLE "User" ALTER COLUMN "id" TYPE uuid USING ("id"::uuid);
-- The type change above leaves the column without a default (the old cuid ids
-- were generated by the client), while every other table's `id` gained
-- `gen_random_uuid()` below. schema.prisma declares `@default(uuid())` for User
-- too, so without this line the database and the datamodel drift apart and a
-- raw SQL insert that omits the id fails on NOT NULL.
ALTER TABLE "User" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "Tenant"
    ALTER COLUMN "activatedById" TYPE uuid USING ("activatedById"::uuid),
    ALTER COLUMN "suspendedById" TYPE uuid USING ("suspendedById"::uuid);

ALTER TABLE "TenantMember"
    ALTER COLUMN "userId" TYPE uuid USING ("userId"::uuid);

ALTER TABLE "Invitation"
    ALTER COLUMN "invitedBy" TYPE uuid USING ("invitedBy"::uuid);

ALTER TABLE "AuditLog"
    ALTER COLUMN "userId" TYPE uuid USING ("userId"::uuid);

ALTER TABLE "Document"
    ALTER COLUMN "issuedById" TYPE uuid USING ("issuedById"::uuid),
    ALTER COLUMN "voidedById" TYPE uuid USING ("voidedById"::uuid);

ALTER TABLE "DocumentPayment"
    ALTER COLUMN "reversedBy" TYPE uuid USING ("reversedBy"::uuid);

ALTER TABLE "DocumentStatusEvent"
    ALTER COLUMN "actorId" TYPE uuid USING ("actorId"::uuid);

-- ─── 6. Tenant.createdById (new) ─────────────────────────────────────────────
-- NULL for tenants that already exist ("who provisioned it" is unknowable
-- retroactively — inventing a value would be worse). New provisioning and
-- self-registration always set it from here on.

ALTER TABLE "Tenant" ADD COLUMN "createdById" uuid;

-- ─── 7. Business entity ids ──────────────────────────────────────────────────
-- Referenced entities: nullable column, backfilled through the mapping,
-- then constrained to the final shape.

ALTER TABLE "Tenant" ADD COLUMN "id_uuid" uuid;
UPDATE "Tenant" t SET "id_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."id";
ALTER TABLE "Tenant" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "Tenant" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();

ALTER TABLE "TaxCategory" ADD COLUMN "id_uuid" uuid;
UPDATE "TaxCategory" t SET "id_uuid" = m.new_id FROM map_taxcategory m WHERE m.old_id = t."id";
ALTER TABLE "TaxCategory" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "TaxCategory" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();

ALTER TABLE "TaxRate" ADD COLUMN "id_uuid" uuid;
UPDATE "TaxRate" t SET "id_uuid" = m.new_id FROM map_taxrate m WHERE m.old_id = t."id";
ALTER TABLE "TaxRate" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "TaxRate" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();

ALTER TABLE "Contact" ADD COLUMN "id_uuid" uuid;
UPDATE "Contact" t SET "id_uuid" = m.new_id FROM map_contact m WHERE m.old_id = t."id";
ALTER TABLE "Contact" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "Contact" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();

ALTER TABLE "Item" ADD COLUMN "id_uuid" uuid;
UPDATE "Item" t SET "id_uuid" = m.new_id FROM map_item m WHERE m.old_id = t."id";
ALTER TABLE "Item" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "Item" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();

ALTER TABLE "Document" ADD COLUMN "id_uuid" uuid;
UPDATE "Document" t SET "id_uuid" = m.new_id FROM map_document m WHERE m.old_id = t."id";
ALTER TABLE "Document" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();

ALTER TABLE "DocumentLine" ADD COLUMN "id_uuid" uuid;
UPDATE "DocumentLine" t SET "id_uuid" = m.new_id FROM map_documentline m WHERE m.old_id = t."id";
ALTER TABLE "DocumentLine" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "DocumentLine" ALTER COLUMN "id_uuid" SET DEFAULT gen_random_uuid();

-- Non-referenced rows: the id is internal to the row, so a fresh value needs
-- no mapping. A volatile DEFAULT on ADD COLUMN evaluates per row (verified),
-- so every row gets its own UUID.

ALTER TABLE "TenantSettings"         ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "TenantBranding"         ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "TenantDomain"           ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "TenantMember"           ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "Invitation"             ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "AuditLog"               ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "ContactAddress"         ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "ContactItem"            ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "DocumentPayment"        ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "DocumentStatusEvent"    ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "DocumentNumbering"      ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "DocumentNumberSequence" ADD COLUMN "id_uuid" uuid NOT NULL DEFAULT gen_random_uuid();

-- ─── 8. Foreign key columns to business entities ─────────────────────────────
-- Same join-based backfill. The triggers that guard tenant consistency fire
-- during these UPDATEs: they compare the (still TEXT) old columns, which
-- remain mutually consistent, so every check passes. The single exception is
-- `DocumentStatusEvent`, whose append-only trigger refuses ANY update — it is
-- disabled for the backfill and re-enabled immediately after.

-- Tenant references
ALTER TABLE "TenantSettings"         ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "TenantBranding"         ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "TenantDomain"           ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "TenantMember"           ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "Invitation"             ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "AuditLog"               ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "TaxCategory"            ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "TaxRate"                ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "Contact"                ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "Item"                   ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "ContactItem"            ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "Document"               ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "DocumentLine"           ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "DocumentPayment"        ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "DocumentStatusEvent"    ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "DocumentNumbering"      ADD COLUMN "tenantId_uuid" uuid;
ALTER TABLE "DocumentNumberSequence" ADD COLUMN "tenantId_uuid" uuid;

UPDATE "TenantSettings"         t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "TenantBranding"         t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "TenantDomain"           t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "TenantMember"           t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "Invitation"             t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "AuditLog"               t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "TaxCategory"            t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "TaxRate"                t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "Contact"                t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "Item"                   t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "ContactItem"            t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "Document"               t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "DocumentLine"           t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "DocumentNumbering"      t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "DocumentNumberSequence" t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";

-- The append-only trigger would refuse these updates; disable for the window.
ALTER TABLE "DocumentStatusEvent" DISABLE TRIGGER document_status_event_is_append_only;

-- The ADD COLUMN itself needs no trigger window (DDL, no rows involved), but
-- the backfill below does, hence both stay inside the section.
ALTER TABLE "DocumentStatusEvent" ADD COLUMN "documentId_uuid" uuid;

UPDATE "DocumentStatusEvent" t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "DocumentStatusEvent" t SET "documentId_uuid" = m.new_id FROM map_document m WHERE m.old_id = t."documentId";

ALTER TABLE "DocumentStatusEvent" ENABLE TRIGGER document_status_event_is_append_only;

-- A reversed payment rejects ANY further update (a reversal is final), so its
-- backfill also runs inside a disabled-trigger window. This one is easy to
-- miss: on an empty dev database it never fires, and on a real one it breaks
-- exactly the tenants that used the reversal feature.
ALTER TABLE "DocumentPayment" DISABLE TRIGGER document_payment_is_append_only;

ALTER TABLE "DocumentPayment" ADD COLUMN "documentId_uuid" uuid;

UPDATE "DocumentPayment" t SET "tenantId_uuid" = m.new_id FROM map_tenant m WHERE m.old_id = t."tenantId";
UPDATE "DocumentPayment" t SET "documentId_uuid" = m.new_id FROM map_document m WHERE m.old_id = t."documentId";

ALTER TABLE "DocumentPayment" ENABLE TRIGGER document_payment_is_append_only;

-- Category / rate references
ALTER TABLE "TaxRate"      ADD COLUMN "categoryId_uuid" uuid;
UPDATE "TaxRate" t SET "categoryId_uuid" = m.new_id FROM map_taxcategory m WHERE m.old_id = t."categoryId";

ALTER TABLE "Item"         ADD COLUMN "taxRateId_uuid" uuid;
UPDATE "Item" t SET "taxRateId_uuid" = m.new_id FROM map_taxrate m WHERE m.old_id = t."taxRateId";

ALTER TABLE "DocumentLine" ADD COLUMN "taxRateId_uuid" uuid;
UPDATE "DocumentLine" t SET "taxRateId_uuid" = m.new_id FROM map_taxrate m WHERE m.old_id = t."taxRateId";

-- Contact references
ALTER TABLE "ContactAddress" ADD COLUMN "contactId_uuid" uuid;
UPDATE "ContactAddress" t SET "contactId_uuid" = m.new_id FROM map_contact m WHERE m.old_id = t."contactId";

ALTER TABLE "ContactItem" ADD COLUMN "contactId_uuid" uuid;
UPDATE "ContactItem" t SET "contactId_uuid" = m.new_id FROM map_contact m WHERE m.old_id = t."contactId";

ALTER TABLE "ContactItem" ADD COLUMN "itemId_uuid" uuid;
UPDATE "ContactItem" t SET "itemId_uuid" = m.new_id FROM map_item m WHERE m.old_id = t."itemId";

-- Item references on document lines
ALTER TABLE "DocumentLine" ADD COLUMN "itemId_uuid" uuid;
UPDATE "DocumentLine" t SET "itemId_uuid" = m.new_id FROM map_item m WHERE m.old_id = t."itemId";

-- Document references
ALTER TABLE "Document" ADD COLUMN "contactId_uuid" uuid;
UPDATE "Document" t SET "contactId_uuid" = m.new_id FROM map_contact m WHERE m.old_id = t."contactId";

ALTER TABLE "Document" ADD COLUMN "sourceDocumentId_uuid" uuid;
UPDATE "Document" t SET "sourceDocumentId_uuid" = m.new_id FROM map_document m WHERE m.old_id = t."sourceDocumentId";

ALTER TABLE "Document" ADD COLUMN "replacementOfId_uuid" uuid;
UPDATE "Document" t SET "replacementOfId_uuid" = m.new_id FROM map_document m WHERE m.old_id = t."replacementOfId";

ALTER TABLE "DocumentLine" ADD COLUMN "documentId_uuid" uuid;
UPDATE "DocumentLine" t SET "documentId_uuid" = m.new_id FROM map_document m WHERE m.old_id = t."documentId";

ALTER TABLE "DocumentLine" ADD COLUMN "sourceLineId_uuid" uuid;
UPDATE "DocumentLine" t SET "sourceLineId_uuid" = m.new_id FROM map_documentline m WHERE m.old_id = t."sourceLineId";

-- NOT NULL constraints for the columns that require a value
ALTER TABLE "TenantSettings"         ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "TenantBranding"         ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "TenantDomain"           ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "TenantMember"           ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "Invitation"             ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "TaxCategory"            ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "TaxRate"                ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "Contact"                ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "Item"                   ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "ContactItem"            ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "Document"               ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "DocumentLine"           ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "DocumentPayment"        ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "DocumentStatusEvent"    ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "DocumentNumbering"      ALTER COLUMN "tenantId_uuid" SET NOT NULL;
ALTER TABLE "DocumentNumberSequence" ALTER COLUMN "tenantId_uuid" SET NOT NULL;

ALTER TABLE "TaxRate"      ALTER COLUMN "categoryId_uuid" SET NOT NULL;
ALTER TABLE "ContactAddress" ALTER COLUMN "contactId_uuid" SET NOT NULL;
ALTER TABLE "ContactItem"  ALTER COLUMN "contactId_uuid" SET NOT NULL;
ALTER TABLE "ContactItem"  ALTER COLUMN "itemId_uuid" SET NOT NULL;
ALTER TABLE "DocumentLine" ALTER COLUMN "documentId_uuid" SET NOT NULL;
ALTER TABLE "DocumentPayment" ALTER COLUMN "documentId_uuid" SET NOT NULL;
ALTER TABLE "DocumentStatusEvent" ALTER COLUMN "documentId_uuid" SET NOT NULL;

-- ─── 9. Swap the columns ─────────────────────────────────────────────────────
-- Drop the old TEXT column (its indexes go with it) and promote the UUID
-- column to the canonical name.

ALTER TABLE "Tenant" DROP COLUMN "id";
ALTER TABLE "Tenant" RENAME COLUMN "id_uuid" TO "id";

ALTER TABLE "TenantSettings" DROP COLUMN "id";
ALTER TABLE "TenantSettings" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "TenantSettings" DROP COLUMN "tenantId";
ALTER TABLE "TenantSettings" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "TenantBranding" DROP COLUMN "id";
ALTER TABLE "TenantBranding" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "TenantBranding" DROP COLUMN "tenantId";
ALTER TABLE "TenantBranding" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "TenantDomain" DROP COLUMN "id";
ALTER TABLE "TenantDomain" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "TenantDomain" DROP COLUMN "tenantId";
ALTER TABLE "TenantDomain" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "TenantMember" DROP COLUMN "id";
ALTER TABLE "TenantMember" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "TenantMember" DROP COLUMN "tenantId";
ALTER TABLE "TenantMember" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "Invitation" DROP COLUMN "id";
ALTER TABLE "Invitation" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "Invitation" DROP COLUMN "tenantId";
ALTER TABLE "Invitation" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "AuditLog" DROP COLUMN "id";
ALTER TABLE "AuditLog" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "AuditLog" DROP COLUMN "tenantId";
ALTER TABLE "AuditLog" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "TaxCategory" DROP COLUMN "id";
ALTER TABLE "TaxCategory" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "TaxCategory" DROP COLUMN "tenantId";
ALTER TABLE "TaxCategory" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "TaxRate" DROP COLUMN "id";
ALTER TABLE "TaxRate" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "TaxRate" DROP COLUMN "tenantId";
ALTER TABLE "TaxRate" RENAME COLUMN "tenantId_uuid" TO "tenantId";
ALTER TABLE "TaxRate" DROP COLUMN "categoryId";
ALTER TABLE "TaxRate" RENAME COLUMN "categoryId_uuid" TO "categoryId";

ALTER TABLE "Contact" DROP COLUMN "id";
ALTER TABLE "Contact" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "Contact" DROP COLUMN "tenantId";
ALTER TABLE "Contact" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "ContactAddress" DROP COLUMN "id";
ALTER TABLE "ContactAddress" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "ContactAddress" DROP COLUMN "contactId";
ALTER TABLE "ContactAddress" RENAME COLUMN "contactId_uuid" TO "contactId";

ALTER TABLE "Item" DROP COLUMN "id";
ALTER TABLE "Item" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "Item" DROP COLUMN "tenantId";
ALTER TABLE "Item" RENAME COLUMN "tenantId_uuid" TO "tenantId";
ALTER TABLE "Item" DROP COLUMN "taxRateId";
ALTER TABLE "Item" RENAME COLUMN "taxRateId_uuid" TO "taxRateId";

ALTER TABLE "ContactItem" DROP COLUMN "id";
ALTER TABLE "ContactItem" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "ContactItem" DROP COLUMN "tenantId";
ALTER TABLE "ContactItem" RENAME COLUMN "tenantId_uuid" TO "tenantId";
ALTER TABLE "ContactItem" DROP COLUMN "contactId";
ALTER TABLE "ContactItem" RENAME COLUMN "contactId_uuid" TO "contactId";
ALTER TABLE "ContactItem" DROP COLUMN "itemId";
ALTER TABLE "ContactItem" RENAME COLUMN "itemId_uuid" TO "itemId";

ALTER TABLE "Document" DROP COLUMN "id";
ALTER TABLE "Document" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "Document" DROP COLUMN "tenantId";
ALTER TABLE "Document" RENAME COLUMN "tenantId_uuid" TO "tenantId";
ALTER TABLE "Document" DROP COLUMN "contactId";
ALTER TABLE "Document" RENAME COLUMN "contactId_uuid" TO "contactId";
ALTER TABLE "Document" DROP COLUMN "sourceDocumentId";
ALTER TABLE "Document" RENAME COLUMN "sourceDocumentId_uuid" TO "sourceDocumentId";
ALTER TABLE "Document" DROP COLUMN "replacementOfId";
ALTER TABLE "Document" RENAME COLUMN "replacementOfId_uuid" TO "replacementOfId";

ALTER TABLE "DocumentLine" DROP COLUMN "id";
ALTER TABLE "DocumentLine" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "DocumentLine" DROP COLUMN "tenantId";
ALTER TABLE "DocumentLine" RENAME COLUMN "tenantId_uuid" TO "tenantId";
ALTER TABLE "DocumentLine" DROP COLUMN "documentId";
ALTER TABLE "DocumentLine" RENAME COLUMN "documentId_uuid" TO "documentId";
ALTER TABLE "DocumentLine" DROP COLUMN "itemId";
ALTER TABLE "DocumentLine" RENAME COLUMN "itemId_uuid" TO "itemId";
ALTER TABLE "DocumentLine" DROP COLUMN "sourceLineId";
ALTER TABLE "DocumentLine" RENAME COLUMN "sourceLineId_uuid" TO "sourceLineId";
ALTER TABLE "DocumentLine" DROP COLUMN "taxRateId";
ALTER TABLE "DocumentLine" RENAME COLUMN "taxRateId_uuid" TO "taxRateId";

ALTER TABLE "DocumentPayment" DROP COLUMN "id";
ALTER TABLE "DocumentPayment" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "DocumentPayment" DROP COLUMN "tenantId";
ALTER TABLE "DocumentPayment" RENAME COLUMN "tenantId_uuid" TO "tenantId";
ALTER TABLE "DocumentPayment" DROP COLUMN "documentId";
ALTER TABLE "DocumentPayment" RENAME COLUMN "documentId_uuid" TO "documentId";

ALTER TABLE "DocumentStatusEvent" DROP COLUMN "id";
ALTER TABLE "DocumentStatusEvent" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "DocumentStatusEvent" DROP COLUMN "tenantId";
ALTER TABLE "DocumentStatusEvent" RENAME COLUMN "tenantId_uuid" TO "tenantId";
ALTER TABLE "DocumentStatusEvent" DROP COLUMN "documentId";
ALTER TABLE "DocumentStatusEvent" RENAME COLUMN "documentId_uuid" TO "documentId";

ALTER TABLE "DocumentNumbering" DROP COLUMN "id";
ALTER TABLE "DocumentNumbering" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "DocumentNumbering" DROP COLUMN "tenantId";
ALTER TABLE "DocumentNumbering" RENAME COLUMN "tenantId_uuid" TO "tenantId";

ALTER TABLE "DocumentNumberSequence" DROP COLUMN "id";
ALTER TABLE "DocumentNumberSequence" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "DocumentNumberSequence" DROP COLUMN "tenantId";
ALTER TABLE "DocumentNumberSequence" RENAME COLUMN "tenantId_uuid" TO "tenantId";

-- ─── 10. Primary keys ────────────────────────────────────────────────────────
-- ("User" kept its primary key through the in-place type change.)

ALTER TABLE "Tenant"                 ADD CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id");
ALTER TABLE "TenantSettings"         ADD CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("id");
ALTER TABLE "TenantBranding"         ADD CONSTRAINT "TenantBranding_pkey" PRIMARY KEY ("id");
ALTER TABLE "TenantDomain"           ADD CONSTRAINT "TenantDomain_pkey" PRIMARY KEY ("id");
ALTER TABLE "TenantMember"           ADD CONSTRAINT "TenantMember_pkey" PRIMARY KEY ("id");
ALTER TABLE "Invitation"             ADD CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id");
ALTER TABLE "AuditLog"               ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id");
ALTER TABLE "TaxCategory"            ADD CONSTRAINT "TaxCategory_pkey" PRIMARY KEY ("id");
ALTER TABLE "TaxRate"                ADD CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id");
ALTER TABLE "Contact"                ADD CONSTRAINT "Contact_pkey" PRIMARY KEY ("id");
ALTER TABLE "ContactAddress"         ADD CONSTRAINT "ContactAddress_pkey" PRIMARY KEY ("id");
ALTER TABLE "Item"                   ADD CONSTRAINT "Item_pkey" PRIMARY KEY ("id");
ALTER TABLE "ContactItem"            ADD CONSTRAINT "ContactItem_pkey" PRIMARY KEY ("id");
ALTER TABLE "Document"               ADD CONSTRAINT "Document_pkey" PRIMARY KEY ("id");
ALTER TABLE "DocumentLine"           ADD CONSTRAINT "DocumentLine_pkey" PRIMARY KEY ("id");
ALTER TABLE "DocumentPayment"        ADD CONSTRAINT "DocumentPayment_pkey" PRIMARY KEY ("id");
ALTER TABLE "DocumentStatusEvent"    ADD CONSTRAINT "DocumentStatusEvent_pkey" PRIMARY KEY ("id");
ALTER TABLE "DocumentNumbering"      ADD CONSTRAINT "DocumentNumbering_pkey" PRIMARY KEY ("id");
ALTER TABLE "DocumentNumberSequence" ADD CONSTRAINT "DocumentNumberSequence_pkey" PRIMARY KEY ("id");

-- ─── 11. Indexes (recreated on the UUID columns) ─────────────────────────────
-- Indexes that only touch converted (drop + rename) columns disappeared with
-- their columns and are recreated here with the same names, plus the new
-- Tenant.createdById index.
--
-- The four drops below are indexes that sit on in-place-cast columns
-- (`activatedById`, `suspendedById`, `TenantMember.userId`); PostgreSQL rebuilt
-- them during `ALTER COLUMN ... TYPE` and kept their names, so dropping them
-- first makes this section deterministic instead of relying on that detail.

DROP INDEX IF EXISTS "Tenant_activatedById_idx";
DROP INDEX IF EXISTS "Tenant_suspendedById_idx";
DROP INDEX IF EXISTS "TenantMember_userId_idx";
DROP INDEX IF EXISTS "TenantMember_userId_isDefault_partial";

CREATE INDEX "Tenant_activatedById_idx" ON "Tenant"("activatedById");
CREATE INDEX "Tenant_suspendedById_idx" ON "Tenant"("suspendedById");
CREATE INDEX "Tenant_createdById_idx" ON "Tenant"("createdById");

CREATE UNIQUE INDEX "TenantSettings_tenantId_key" ON "TenantSettings"("tenantId");
CREATE UNIQUE INDEX "TenantBranding_tenantId_key" ON "TenantBranding"("tenantId");
CREATE INDEX "TenantDomain_tenantId_idx" ON "TenantDomain"("tenantId");

CREATE INDEX "TenantMember_userId_idx" ON "TenantMember"("userId");
CREATE INDEX "TenantMember_tenantId_idx" ON "TenantMember"("tenantId");
CREATE UNIQUE INDEX "TenantMember_tenantId_userId_key" ON "TenantMember"("tenantId", "userId");
CREATE UNIQUE INDEX "TenantMember_userId_isDefault_partial" ON "TenantMember"("userId") WHERE "isDefault" = true;

CREATE INDEX "Invitation_tenantId_idx" ON "Invitation"("tenantId");
CREATE UNIQUE INDEX "Invitation_tenantId_email_key" ON "Invitation"("tenantId", "email");

CREATE INDEX "AuditLog_tenantId_idx" ON "AuditLog"("tenantId");

CREATE INDEX "TaxCategory_tenantId_idx" ON "TaxCategory"("tenantId");
CREATE UNIQUE INDEX "TaxCategory_tenantId_name_key" ON "TaxCategory"("tenantId", "name");
CREATE INDEX "TaxRate_tenantId_idx" ON "TaxRate"("tenantId");
CREATE INDEX "TaxRate_categoryId_idx" ON "TaxRate"("categoryId");
CREATE UNIQUE INDEX "TaxRate_tenantId_categoryId_name_effectiveFrom_key" ON "TaxRate"("tenantId", "categoryId", "name", "effectiveFrom");

CREATE INDEX "Contact_tenantId_idx" ON "Contact"("tenantId");
CREATE INDEX "Contact_tenantId_status_idx" ON "Contact"("tenantId", "status");
CREATE INDEX "Contact_tenantId_email_idx" ON "Contact"("tenantId", "email");
CREATE INDEX "Contact_tenantId_phone_idx" ON "Contact"("tenantId", "phone");
CREATE INDEX "Contact_tenantId_companyName_idx" ON "Contact"("tenantId", "companyName");
CREATE INDEX "Contact_tenantId_createdAt_idx" ON "Contact"("tenantId", "createdAt");

CREATE INDEX "ContactAddress_contactId_idx" ON "ContactAddress"("contactId");
CREATE INDEX "ContactAddress_contactId_type_idx" ON "ContactAddress"("contactId", "type");
CREATE UNIQUE INDEX "ContactAddress_contactId_type_isDefault_partial" ON "ContactAddress"("contactId", "type") WHERE "isDefault" = true;

CREATE INDEX "Item_tenantId_idx" ON "Item"("tenantId");
CREATE INDEX "Item_tenantId_status_idx" ON "Item"("tenantId", "status");
CREATE INDEX "Item_tenantId_type_idx" ON "Item"("tenantId", "type");
CREATE INDEX "Item_tenantId_name_idx" ON "Item"("tenantId", "name");
CREATE UNIQUE INDEX "Item_tenantId_sku_key" ON "Item"("tenantId", "sku");

CREATE INDEX "ContactItem_tenantId_idx" ON "ContactItem"("tenantId");
CREATE INDEX "ContactItem_tenantId_contactId_idx" ON "ContactItem"("tenantId", "contactId");
CREATE INDEX "ContactItem_tenantId_itemId_idx" ON "ContactItem"("tenantId", "itemId");
CREATE UNIQUE INDEX "ContactItem_tenantId_contactId_itemId_key" ON "ContactItem"("tenantId", "contactId", "itemId");

CREATE INDEX "Document_tenantId_idx" ON "Document"("tenantId");
CREATE INDEX "Document_tenantId_contactId_idx" ON "Document"("tenantId", "contactId");
CREATE INDEX "Document_tenantId_status_idx" ON "Document"("tenantId", "status");
CREATE INDEX "Document_tenantId_issuedAt_idx" ON "Document"("tenantId", "issuedAt");
CREATE UNIQUE INDEX "Document_tenantId_type_number_key" ON "Document"("tenantId", "type", "number");
CREATE UNIQUE INDEX "Document_tenantId_idempotencyKey_key" ON "Document"("tenantId", "idempotencyKey");
CREATE INDEX "Document_tenantId_type_status_idx" ON "Document"("tenantId", "type", "status");
CREATE INDEX "Document_tenantId_dueDate_idx" ON "Document"("tenantId", "dueDate");
CREATE INDEX "Document_tenantId_sourceDocumentId_idx" ON "Document"("tenantId", "sourceDocumentId");
CREATE UNIQUE INDEX "document_one_invoice_per_source" ON "Document"("sourceDocumentId") WHERE "type" = 'INVOICE' AND "sourceDocumentId" IS NOT NULL;

CREATE INDEX "DocumentLine_tenantId_idx" ON "DocumentLine"("tenantId");
CREATE INDEX "DocumentLine_tenantId_itemId_idx" ON "DocumentLine"("tenantId", "itemId");
CREATE UNIQUE INDEX "DocumentLine_tenantId_documentId_position_key" ON "DocumentLine"("tenantId", "documentId", "position");

CREATE INDEX "DocumentPayment_tenantId_idx" ON "DocumentPayment"("tenantId");
CREATE INDEX "DocumentPayment_tenantId_documentId_idx" ON "DocumentPayment"("tenantId", "documentId");
CREATE INDEX "DocumentPayment_tenantId_occurredOn_idx" ON "DocumentPayment"("tenantId", "occurredOn");

CREATE INDEX "DocumentStatusEvent_tenantId_documentId_idx" ON "DocumentStatusEvent"("tenantId", "documentId");
CREATE INDEX "DocumentStatusEvent_tenantId_createdAt_idx" ON "DocumentStatusEvent"("tenantId", "createdAt");

CREATE INDEX "DocumentNumbering_tenantId_idx" ON "DocumentNumbering"("tenantId");
CREATE UNIQUE INDEX "DocumentNumbering_tenantId_type_key" ON "DocumentNumbering"("tenantId", "type");
CREATE INDEX "DocumentNumberSequence_tenantId_idx" ON "DocumentNumberSequence"("tenantId");
CREATE UNIQUE INDEX "DocumentNumberSequence_tenantId_type_period_key" ON "DocumentNumberSequence"("tenantId", "type", "period");

-- ─── 12. Foreign keys (final shapes) ─────────────────────────────────────────
-- Recreated in full, including three that are new in the Phase 1 schema:
--   Tenant_createdById_fkey          — who provisioned the tenant
--   DocumentPayment_reversedBy_fkey  — who reversed a payment
--   DocumentStatusEvent_actorId_fkey — who moved a document

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantBranding" ADD CONSTRAINT "TenantBranding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantDomain" ADD CONSTRAINT "TenantDomain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TaxCategory" ADD CONSTRAINT "TaxCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TaxCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactAddress" ADD CONSTRAINT "ContactAddress_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Item" ADD CONSTRAINT "Item_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContactItem" ADD CONSTRAINT "ContactItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactItem" ADD CONSTRAINT "ContactItem_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactItem" ADD CONSTRAINT "ContactItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_replacementOfId_fkey" FOREIGN KEY ("replacementOfId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints that referenced a converted column are dropped by
-- PostgreSQL together with the old column (`DROP COLUMN "contactId"` takes
-- `document_issued_documents_are_addressable` with it). They are part of the
-- document engine's promises, so they are re-added on the UUID columns.
-- (Constraints that only reference unconverted columns survived the swap and
-- must NOT be re-added — duplicating one would fail the migration.)
ALTER TABLE "Document"
    ADD CONSTRAINT "document_only_sales_documents_carry_a_source"
        CHECK ("sourceDocumentId" IS NULL OR "type" IN ('INVOICE', 'DELIVERY_NOTE')),
    ADD CONSTRAINT "document_issued_documents_are_addressable"
        CHECK ("status" = 'DRAFT' OR "contactId" IS NOT NULL);

ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_sourceLineId_fkey" FOREIGN KEY ("sourceLineId") REFERENCES "DocumentLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DocumentPayment" ADD CONSTRAINT "DocumentPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPayment" ADD CONSTRAINT "DocumentPayment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentPayment" ADD CONSTRAINT "DocumentPayment_reversedBy_fkey" FOREIGN KEY ("reversedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DocumentStatusEvent" ADD CONSTRAINT "DocumentStatusEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentStatusEvent" ADD CONSTRAINT "DocumentStatusEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentStatusEvent" ADD CONSTRAINT "DocumentStatusEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DocumentNumbering" ADD CONSTRAINT "DocumentNumbering_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocumentNumberSequence" ADD CONSTRAINT "DocumentNumberSequence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentNumberSequence" ADD CONSTRAINT "DocumentNumberSequence_tenantId_type_fkey" FOREIGN KEY ("tenantId", "type") REFERENCES "DocumentNumbering"("tenantId", "type") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 13. Trigger functions for the UUID types ────────────────────────────────
-- `document_child_belongs_to_document_tenant` took TEXT parameters and
-- compared them with id columns — a UUID column can no longer satisfy that
-- call, so the function is replaced (and its three triggers rebuilt around
-- it). `document_line_references_are_valid` compared a TEXT local variable;
-- replace its body. The numbering functions are recreated with UUID
-- parameters and UUID primary keys for the rows they create (the old
-- deterministic 'docnum_…' ids are not valid UUIDs; the
-- (tenantId, type, period) unique constraints carry the same
-- create-if-absent guarantee).

DROP TRIGGER IF EXISTS document_line_is_same_tenant ON "DocumentLine";
DROP TRIGGER IF EXISTS document_payment_is_same_tenant ON "DocumentPayment";
DROP TRIGGER IF EXISTS document_status_event_is_same_tenant ON "DocumentStatusEvent";

DROP FUNCTION IF EXISTS document_child_belongs_to_document_tenant(text, text, text);

CREATE OR REPLACE FUNCTION document_child_belongs_to_document_tenant(
    p_tenant_id uuid, p_document_id uuid, p_child text
) RETURNS void AS $$
BEGIN
    IF p_tenant_id IS NULL OR p_document_id IS NULL THEN
        RAISE EXCEPTION 'Cannot write % without a document and a tenant', p_child
            USING ERRCODE = 'check_violation';
    END IF;

    -- Three different failures, three different messages: an operator reading a
    -- rejected write should not have to guess which one happened. Under row
    -- level security a parent in another tenant is invisible here, so that case
    -- correctly reports "does not exist" rather than leaking that it does.
    IF NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."id" = p_document_id) THEN
        RAISE EXCEPTION 'Cannot write %: document % does not exist', p_child, p_document_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "Document" d
        WHERE d."id" = p_document_id AND d."tenantId" = p_tenant_id
    ) THEN
        RAISE EXCEPTION 'Cannot write %: document % is not a document of tenant %',
            p_child, p_document_id, p_tenant_id
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_line_is_same_tenant
    BEFORE INSERT OR UPDATE ON "DocumentLine"
    FOR EACH ROW EXECUTE FUNCTION document_child_is_same_tenant();

CREATE TRIGGER document_payment_is_same_tenant
    BEFORE INSERT OR UPDATE ON "DocumentPayment"
    FOR EACH ROW EXECUTE FUNCTION document_child_is_same_tenant();

CREATE TRIGGER document_status_event_is_same_tenant
    BEFORE INSERT OR UPDATE ON "DocumentStatusEvent"
    FOR EACH ROW EXECUTE FUNCTION document_child_is_same_tenant();

CREATE OR REPLACE FUNCTION document_line_references_are_valid()
RETURNS trigger AS $$
DECLARE
    v_source_tenant uuid;
BEGIN
    IF NEW."itemId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Item" i
        WHERE i."id" = NEW."itemId" AND i."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Item % does not belong to tenant %', NEW."itemId", NEW."tenantId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."taxRateId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "TaxRate" t
        WHERE t."id" = NEW."taxRateId" AND t."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Tax rate % does not belong to tenant %', NEW."taxRateId", NEW."tenantId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."sourceLineId" IS NOT NULL THEN
        IF NEW."sourceLineId" = NEW."id" THEN
            RAISE EXCEPTION 'A document line cannot deliver against itself'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT l."tenantId" INTO v_source_tenant
          FROM "DocumentLine" l WHERE l."id" = NEW."sourceLineId";

        IF v_source_tenant IS NULL OR v_source_tenant <> NEW."tenantId" THEN
            RAISE EXCEPTION 'Delivered line % does not belong to tenant %', NEW."sourceLineId", NEW."tenantId"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Numbering functions: UUID parameters, UUID row ids, identical behaviour.
-- (`allocate_document_number` gains its viewer/portal/no-context guard in
-- 20261018000002_rls_enforcement_storage_and_grants.)

DROP FUNCTION IF EXISTS allocate_document_number(text, "DocumentType", date);
DROP FUNCTION IF EXISTS peek_document_number(text, "DocumentType", date);

CREATE OR REPLACE FUNCTION allocate_document_number(
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

    -- A tenant that never opened the numbering screen still has to be able to
    -- issue, so the series is created on first use with the documented defaults
    -- (INV-2026-0001 / QUO-2026-0001 / DN-2026-0001). The row id is a fresh
    -- UUID; "create if absent" is guaranteed by the (tenantId, type) unique
    -- constraint, not by a deterministic id.
    INSERT INTO "DocumentNumbering"
            ("id", "tenantId", "type", "prefix", "padding", "separator",
             "periodStyle", "fiscalStartMonth", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(),
            p_tenant_id, p_type,
            CASE p_type WHEN 'INVOICE' THEN 'INV' WHEN 'QUOTATION' THEN 'QUO' ELSE 'DN' END,
            4, '-', 'CALENDAR_YEAR', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "type") DO NOTHING;

    SELECT n."prefix", n."padding", n."separator", n."periodStyle", n."fiscalStartMonth"
      INTO v_prefix, v_padding, v_separator, v_style, v_fiscal
      FROM "DocumentNumbering" n
     WHERE n."tenantId" = p_tenant_id AND n."type" = p_type;

    v_period := document_number_period(v_style, v_fiscal, p_date);

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

CREATE OR REPLACE FUNCTION peek_document_number(
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
        v_prefix := CASE p_type WHEN 'INVOICE' THEN 'INV' WHEN 'QUOTATION' THEN 'QUO' ELSE 'DN' END;
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

REVOKE ALL ON FUNCTION allocate_document_number(uuid, "DocumentType", date) FROM PUBLIC;
REVOKE ALL ON FUNCTION peek_document_number(uuid, "DocumentType", date) FROM PUBLIC;
REVOKE ALL ON FUNCTION document_number_period("DocumentPeriodStyle", integer, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION document_child_belongs_to_document_tenant(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION allocate_document_number(uuid, "DocumentType", date) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION peek_document_number(uuid, "DocumentType", date) TO amisibiz_app;

-- The three column-specific catalogue triggers dropped in §3 come back on the
-- converted columns. Same definitions as the Phase 04 migration; the functions
-- are untouched because their comparisons are resolved against the column
-- types at execution (uuid = uuid now).
CREATE TRIGGER "ContactItem_single_tenant_assignment"
    BEFORE INSERT OR UPDATE OF "contactId", "itemId", "tenantId" ON "ContactItem"
    FOR EACH ROW EXECUTE FUNCTION catalogue_assignment_is_single_tenant();

CREATE TRIGGER "Item_single_tenant_tax_rate"
    BEFORE INSERT OR UPDATE OF "taxRateId", "tenantId" ON "Item"
    FOR EACH ROW EXECUTE FUNCTION item_tax_rate_is_single_tenant();

CREATE TRIGGER "TaxRate_single_tenant_category"
    BEFORE INSERT OR UPDATE OF "categoryId", "tenantId" ON "TaxRate"
    FOR EACH ROW EXECUTE FUNCTION tax_rate_is_single_tenant();

-- ─── 14. Context readers return UUIDs ────────────────────────────────────────
-- The GUCs stay TEXT under the hood (`set_config` only stores text), but the
-- readers hand policies a UUID so they compare directly with the converted
-- columns. NULLIF keeps the fail-closed behaviour: unset or empty context is
-- NULL, and a policy comparing against NULL matches nothing.

DROP FUNCTION IF EXISTS current_tenant_id();
CREATE FUNCTION current_tenant_id() RETURNS uuid AS $$
    SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
REVOKE EXECUTE ON FUNCTION current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO amisibiz_app;

DROP FUNCTION IF EXISTS current_user_id();
CREATE FUNCTION current_user_id() RETURNS uuid AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
REVOKE EXECUTE ON FUNCTION current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_id() TO amisibiz_app;

COMMENT ON FUNCTION current_tenant_id() IS 'UUID tenant context for the current request; NULL when no context is set (fail closed).';
COMMENT ON FUNCTION current_user_id() IS 'UUID user context for the current request; NULL when no context is set (fail closed).';
COMMENT ON COLUMN "Tenant"."createdById" IS 'Who provisioned the tenant (self-registration or platform operator). The RLS anchor for registration-time owner membership creation.';
