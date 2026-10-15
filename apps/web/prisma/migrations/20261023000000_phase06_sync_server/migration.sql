-- Migration: Phase 06 server half - the sync endpoints' server-side storage.
--
-- Three additions, all in service of `/api/sync/push` and `/api/sync/pull`:
--
-- 1. A monotonic `revision` column on the four device-authored tables
--    (`Contact`, `Item`, `ContactItem`, `Document`). It is maintained by a
--    BEFORE UPDATE trigger, not by the application, so every writer (Server
--    Action, sync push, operator tooling) advances it and an offline pull has an
--    ordering authority that is not a device clock. The directive is explicit
--    that a device timestamp is never a tie-breaker.
--
-- 2. `SyncOperation` - the push receipt table. `(clientId, operationId)` is the
--    client's own idempotency key, unique, so a retried push answers the original
--    outcome instead of applying an operation twice. Receipts are append-only
--    evidence: `amisibiz_app` holds INSERT/SELECT and neither UPDATE nor DELETE.
--
-- 3. `SyncDeletion` - tombstones. A hard-deleted `Item`/`ContactItem` leaves a
--    row here so a device that still holds a copy is told the row is gone.
--    Tombstones are retained (no DELETE grant) and upserted on a re-delete.
--
-- ## RLS posture
--
-- Both new tables are tenant-scoped and carry the same isolation policy as every
-- other tenant table: a row is visible/writable only inside its own tenant's
-- request context, or to a platform admin. As with the rest of the schema, RLS
-- is inert only while the runtime role is not the app role; the application
-- layer's tenant-pinned WHERE clauses are the control in force today, and the
-- policies bind once the app connects as `amisibiz_app`.
--
-- ## NOT APPLIED / NOT VERIFIED
--
-- This migration is authored but has NOT been applied to any database and has
-- NOT been run through the clean-room migration chain. The Prisma schema and
-- this SQL were produced from `prisma migrate diff`; the trigger, the policies
-- and the grants are hand-written in the house style and followed by
-- `prisma migrate diff` drift checks only when a shadow database is available.
-- The owner must apply and verify it (RUNBOOK section 5) before any of it is
-- called live.

-- ─── 1. Revision columns ─────────────────────────────────────────────────────

ALTER TABLE "Contact" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Item" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ContactItem" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Document" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN "Contact"."revision" IS 'Monotonic server revision, bumped by amisibiz_bump_revision() on every UPDATE. The ordering authority an offline pull compares against - never a device clock.';
COMMENT ON COLUMN "Item"."revision" IS 'Monotonic server revision (see Contact.revision).';
COMMENT ON COLUMN "ContactItem"."revision" IS 'Monotonic server revision (see Contact.revision).';
COMMENT ON COLUMN "Document"."revision" IS 'Monotonic server revision (see Contact.revision).';

-- ─── 2. Push receipts and pull tombstones ────────────────────────────────────

CREATE TABLE "SyncOperation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" TEXT NOT NULL,
    "operationId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "revision" INTEGER,
    "reason" TEXT,
    "conflictId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncDeletion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedById" UUID,

    CONSTRAINT "SyncDeletion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncOperation_tenantId_createdAt_idx" ON "SyncOperation"("tenantId", "createdAt");
CREATE INDEX "SyncOperation_userId_idx" ON "SyncOperation"("userId");
CREATE UNIQUE INDEX "SyncOperation_clientId_operationId_key" ON "SyncOperation"("clientId", "operationId");
CREATE INDEX "SyncDeletion_tenantId_deletedAt_idx" ON "SyncDeletion"("tenantId", "deletedAt");
CREATE UNIQUE INDEX "SyncDeletion_tenantId_entity_entityId_key" ON "SyncDeletion"("tenantId", "entity", "entityId");

ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncDeletion" ADD CONSTRAINT "SyncDeletion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_outcome_check"
    CHECK ("outcome" IN ('applied', 'duplicate', 'rejected', 'conflict'));

COMMENT ON TABLE "SyncOperation" IS 'Push idempotency receipts. Unique (clientId, operationId); a retry answers the stored outcome. Append-only (INSERT/SELECT for the runtime role).';
COMMENT ON TABLE "SyncDeletion" IS 'Pull tombstones for hard-deleted syncable rows, so an offline device drops a row instead of keeping a ghost. Retained (no DELETE grant).';

-- ─── 3. The revision trigger ─────────────────────────────────────────────────
--
-- A trigger rather than application code, deliberately: the revision must
-- advance for EVERY update of a syncable row, and a second writer that forgot to
-- bump it would let a stale device overwrite a newer server value without ever
-- seeing a conflict. One definition, at the only layer that cannot forget.
--
-- `updatedAt` is stamped here too, so the value the pull cursor advances on is
-- the server's transaction time and not a clock the caller supplied.

CREATE OR REPLACE FUNCTION public.amisibiz_bump_revision() RETURNS trigger AS $$
BEGIN
    NEW."revision" := OLD."revision" + 1;
    NEW."updatedAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.amisibiz_bump_revision() IS 'BEFORE UPDATE trigger: advances revision and stamps updatedAt with server time on the four device-authored tables.';

CREATE TRIGGER contact_bump_revision
    BEFORE UPDATE ON "Contact"
    FOR EACH ROW EXECUTE FUNCTION public.amisibiz_bump_revision();

CREATE TRIGGER item_bump_revision
    BEFORE UPDATE ON "Item"
    FOR EACH ROW EXECUTE FUNCTION public.amisibiz_bump_revision();

CREATE TRIGGER contact_item_bump_revision
    BEFORE UPDATE ON "ContactItem"
    FOR EACH ROW EXECUTE FUNCTION public.amisibiz_bump_revision();

CREATE TRIGGER document_bump_revision
    BEFORE UPDATE ON "Document"
    FOR EACH ROW EXECUTE FUNCTION public.amisibiz_bump_revision();

-- ─── 4. Row level security ───────────────────────────────────────────────────

ALTER TABLE "SyncOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncDeletion" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_operation_tenant_isolation ON "SyncOperation";
CREATE POLICY sync_operation_tenant_isolation ON "SyncOperation"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

DROP POLICY IF EXISTS sync_deletion_tenant_isolation ON "SyncDeletion";
CREATE POLICY sync_deletion_tenant_isolation ON "SyncDeletion"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

-- ─── 5. Runtime grants ───────────────────────────────────────────────────────
--
-- Receipts: append-only evidence, so INSERT/SELECT and nothing else.
-- Tombstones: INSERT/SELECT/UPDATE (a re-delete upserts), never DELETE.

GRANT SELECT, INSERT         ON "SyncOperation" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE ON "SyncDeletion"  TO amisibiz_app;
