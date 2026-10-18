-- C1 live reconciliation (Neon) — companion to migration 20261029000000.
--
-- Live Neon had the agent-7 drift SQL (docs/implementation/agent-7-schema-drift.sql)
-- applied out-of-band: the AuditLog / TenantBranding / User.passwordHash columns
-- match migration 22 exactly, but Subscription + SubscriptionStatusHistory exist
-- in the DRIFT shape (snake_case, free-text status, changed_by TEXT, planId
-- ON DELETE SET NULL against a NOT NULL column — broken by design), with no
-- enum, no CHECK constraints, no RLS, and no app-role grants.
--
-- This script transforms the live objects into the exact state migration 22
-- builds, so migration 22 can then be recorded as applied via
-- `prisma migrate resolve --applied`. Both tables are EMPTY on live
-- (verified 2026-10-18), so every type conversion below is trivial.
-- The whole script was verified offline against a drifted-state replica
-- (chain 1..21 + the drift SQL) before being run here.

BEGIN;

-- 0. Preconditions — refuse to run against an unexpected live shape.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus') THEN
        RAISE EXCEPTION 'SubscriptionStatus enum already exists — live does not match the expected drifted shape';
    END IF;
    IF (SELECT count(*) FROM "Subscription") <> 0
       OR (SELECT count(*) FROM "SubscriptionStatusHistory") <> 0 THEN
        RAISE EXCEPTION 'Subscription tables are not empty — the trivial casts in this script assume no rows; reconcile by hand';
    END IF;
END
$$;

-- 1. The enum (absent on live; the drift script wrote free-text status)
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'TRIAL', 'CANCELLED', 'ARCHIVED');

-- 2. Subscription → camelCase + enum status
ALTER TABLE "Subscription" RENAME COLUMN current_period_start TO "currentPeriodStart";
ALTER TABLE "Subscription" RENAME COLUMN current_period_end   TO "currentPeriodEnd";
ALTER TABLE "Subscription" RENAME COLUMN trial_start          TO "trialStart";
ALTER TABLE "Subscription" RENAME COLUMN trial_end            TO "trialEnd";
ALTER TABLE "Subscription" RENAME COLUMN cancel_at_period_end TO "cancelAtPeriodEnd";
ALTER TABLE "Subscription" RENAME COLUMN canceled_at          TO "canceledAt";
ALTER TABLE "Subscription" ALTER COLUMN "status" TYPE "SubscriptionStatus" USING "status"::"SubscriptionStatus";

-- 3. Subscription → the reformed FK (SET NULL collided with NOT NULL planId)
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_planId_fkey";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Integrity: period ranges must be ordered when both ends exist
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_period_range_is_ordered"
    CHECK ("currentPeriodStart" IS NULL OR "currentPeriodEnd" IS NULL OR "currentPeriodStart" <= "currentPeriodEnd");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_trial_range_is_ordered"
    CHECK ("trialStart" IS NULL OR "trialEnd" IS NULL OR "trialStart" <= "trialEnd");

-- 5. SubscriptionStatusHistory → camelCase, enum states, UUID actor reference
ALTER TABLE "SubscriptionStatusHistory" RENAME COLUMN from_status TO "fromStatus";
ALTER TABLE "SubscriptionStatusHistory" RENAME COLUMN to_status   TO "toStatus";
ALTER TABLE "SubscriptionStatusHistory" ALTER COLUMN "fromStatus" TYPE "SubscriptionStatus" USING "fromStatus"::"SubscriptionStatus";
ALTER TABLE "SubscriptionStatusHistory" ALTER COLUMN "toStatus"   TYPE "SubscriptionStatus" USING "toStatus"::"SubscriptionStatus";
ALTER TABLE "SubscriptionStatusHistory" ALTER COLUMN changed_by   TYPE uuid USING changed_by::uuid;
ALTER TABLE "SubscriptionStatusHistory" RENAME COLUMN changed_by  TO "changedBy";
ALTER TABLE "SubscriptionStatusHistory" ADD CONSTRAINT "SubscriptionStatusHistory_changedBy_fkey" FOREIGN KEY ("changedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5b. The drift script created NOT NULLs as named constraints derived from the
-- snake_case names; after the renames they no longer match the auto pattern a
-- fresh CREATE TABLE produces (pg_dump renders them explicitly). Cosmetic only,
-- renamed for exact catalog parity with the clean chain.
ALTER TABLE "Subscription" RENAME CONSTRAINT "Subscription_cancel_at_period_end_not_null" TO "Subscription_cancelAtPeriodEnd_not_null";
ALTER TABLE "SubscriptionStatusHistory" RENAME CONSTRAINT "SubscriptionStatusHistory_to_status_not_null" TO "SubscriptionStatusHistory_toStatus_not_null";

-- 6. RLS + policies + grants — verbatim from migration 20261029000000
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

COMMIT;
