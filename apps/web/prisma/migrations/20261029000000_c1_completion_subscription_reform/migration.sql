-- C1 completion + Subscription reform (R5: reform, owner ruling 2026-10-18).
--
-- The five migrations from 20261024000000_phase07 to 20261028000000_phase11
-- are comment-only shells ("Applied via schema sync"), so a fresh
-- `migrate deploy` built a database that was missing four groups of
-- already-committed schema. Those shells are RETIRED, NOT EDITED (C5): this
-- single new migration carries their intended content, verified by
-- `prisma migrate diff` against a throwaway deploy of migrations 1..21:
--
--   1. `User.passwordHash` — native credentials could not even exist;
--      production login fails at the database level until this lands.
--   2. Four `AuditLog` integrity columns (`correlationId` + index, `outcome`,
--      `outcomeDetails`, `resourceType`).
--   3. Seventeen `TenantBranding` columns (templates, numbering preferences,
--      eTIMS placeholders, provider config).
--   4. `Subscription` + `SubscriptionStatusHistory` — never created at all.
--      Per the R5 ruling they are REFORMED, not dropped: `status` is the new
--      `SubscriptionStatus` enum (was free-text), column names follow the
--      house camelCase style, `planId` deletes RESTRICT (the old
--      `ON DELETE SET NULL` collided with the NOT NULL column — a plan delete
--      would have failed as a constraint violation), and history rows keep a
--      real UUID reference to the administrator who made the change
--      (SET NULL so history survives account removal).
--
-- RLS (closes H2: the subscription tables would otherwise have shipped with
-- no policies) and runtime grants follow the Phase 2/Phase 6 house pattern.
-- The generated DDL below was produced by `prisma migrate diff` and is used
-- verbatim.

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'TRIAL', 'CANCELLED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "outcomeDetails" TEXT,
ADD COLUMN     "resourceType" TEXT;

-- AlterTable
ALTER TABLE "TenantBranding" ADD COLUMN     "cloudinaryPresetName" TEXT,
ADD COLUMN     "deliveryNoteCustomizations" JSONB,
ADD COLUMN     "deliveryNoteTemplate" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "documentNumberingPadding" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "documentNumberingPrefix" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "documentPeriodStyle" TEXT NOT NULL DEFAULT 'CALENDAR_YEAR',
ADD COLUMN     "dpoIntegrationStatus" TEXT,
ADD COLUMN     "etimsCompatible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "etimsDocumentType" TEXT,
ADD COLUMN     "etimsLastSync" TIMESTAMP(3),
ADD COLUMN     "etimsSerialNumber" TEXT,
ADD COLUMN     "fiscalStartMonth" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "invoiceCustomizations" JSONB,
ADD COLUMN     "invoiceTemplate" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "mailtrapFromEmail" TEXT,
ADD COLUMN     "quotationCustomizations" JSONB,
ADD COLUMN     "quotationTemplate" TEXT NOT NULL DEFAULT 'standard';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT;

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialStart" TIMESTAMP(3),
    "trialEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionStatusHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriptionId" UUID NOT NULL,
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus" NOT NULL,
    "changedBy" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_tenantId_key" ON "Subscription"("tenantId");

-- CreateIndex
CREATE INDEX "SubscriptionStatusHistory_subscriptionId_idx" ON "SubscriptionStatusHistory"("subscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionStatusHistory_createdAt_idx" ON "SubscriptionStatusHistory"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionStatusHistory" ADD CONSTRAINT "SubscriptionStatusHistory_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionStatusHistory" ADD CONSTRAINT "SubscriptionStatusHistory_changedBy_fkey" FOREIGN KEY ("changedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Integrity: period ranges must be ordered when both ends exist ───────────

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_period_range_is_ordered"
    CHECK ("currentPeriodStart" IS NULL OR "currentPeriodEnd" IS NULL OR "currentPeriodStart" <= "currentPeriodEnd");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_trial_range_is_ordered"
    CHECK ("trialStart" IS NULL OR "trialEnd" IS NULL OR "trialStart" <= "trialEnd");

-- ─── Row level security (H2) ─────────────────────────────────────────────────
--
-- Subscription: reads are tenant-scoped (a workspace may see its own billing
-- state from any status); writes are platform-admin only. No DELETE policy and
-- no DELETE grant: subscriptions end as ARCHIVED, they are not deleted (tenant
-- teardown removes rows via the owner-role CASCADE FK, which bypasses RLS).
--
-- SubscriptionStatusHistory: append-only audit trail — platform-admin SELECT
-- and INSERT, nothing else. The changelog is a console surface; no tenant
-- policy exists until a tenant-facing use case does.

ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubscriptionStatusHistory" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscription_tenant_select ON "Subscription";
CREATE POLICY subscription_tenant_select ON "Subscription"
    FOR SELECT TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin());

DROP POLICY IF EXISTS subscription_admin_insert ON "Subscription";
CREATE POLICY subscription_admin_insert ON "Subscription"
    FOR INSERT TO amisibiz_app
    WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS subscription_admin_update ON "Subscription";
CREATE POLICY subscription_admin_update ON "Subscription"
    FOR UPDATE TO amisibiz_app
    USING (is_platform_admin())
    WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS subscription_status_history_admin_select ON "SubscriptionStatusHistory";
CREATE POLICY subscription_status_history_admin_select ON "SubscriptionStatusHistory"
    FOR SELECT TO amisibiz_app
    USING (is_platform_admin());

DROP POLICY IF EXISTS subscription_status_history_admin_insert ON "SubscriptionStatusHistory";
CREATE POLICY subscription_status_history_admin_insert ON "SubscriptionStatusHistory"
    FOR INSERT TO amisibiz_app
    WITH CHECK (is_platform_admin());

-- ─── Runtime grants (verbs narrowed to the use cases above) ──────────────────

REVOKE ALL ON "Subscription"              FROM amisibiz_app;
REVOKE ALL ON "SubscriptionStatusHistory" FROM amisibiz_app;
GRANT SELECT, INSERT, UPDATE ON "Subscription"              TO amisibiz_app;
GRANT SELECT, INSERT         ON "SubscriptionStatusHistory" TO amisibiz_app;

-- The PostgREST roles never touch AmisiBiz tables (migration 10 §8(d) rule;
-- Plan and the sync tables follow it — so do these).
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    LOOP
        EXECUTE format('REVOKE ALL ON public."Subscription" FROM %I', r.rolname);
        EXECUTE format('REVOKE ALL ON public."SubscriptionStatusHistory" FROM %I', r.rolname);
    END LOOP;
END
$$;

COMMENT ON TABLE "Subscription" IS 'Per-tenant billing state (R5 reform: enum status, camelCase columns, RESTRICT on plan). Reads tenant-scoped, writes platform-admin only; no DELETE.';
COMMENT ON TABLE "SubscriptionStatusHistory" IS 'Append-only subscription status changelog; platform-admin SELECT/INSERT only.';
