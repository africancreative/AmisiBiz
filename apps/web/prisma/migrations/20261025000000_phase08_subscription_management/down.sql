-- Migration: Phase 08 rollback – Subscription management
--
-- Reverts the Subscription and SubscriptionStatusHistory models and
-- restores the previous Tenant.planId relationship.
--
-- 1. Drop RLS policies
DROP POLICY IF EXISTS "Platform admins can read all subscriptions" ON "Subscription";
DROP POLICY IF EXISTS "Tenant owner can read own subscription" ON "Subscription";
DROP POLICY IF EXISTS "Platform admins can read subscription history" ON "SubscriptionStatusHistory";
DROP POLICY IF EXISTS "Tenant can read own subscription history" ON "SubscriptionStatusHistory";

-- 2. Drop tables
DROP TABLE IF EXISTS "SubscriptionStatusHistory";
DROP TABLE IF EXISTS "Subscription";

-- 3. Restore Tenant.planId column and relation
ALTER TABLE "Tenant" COLUMN "planId" UUID NOT NULL;
-- Re-create the index and foreign key (exact syntax depends on DB state;
-- this is a best-effort rollback).
CREATE INDEX IF NOT EXISTS "Tenant_planId_idx" ON "Tenant" ("planId");
ALTER TABLE "Tenant" CONSTRAINT "Tenant_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL;

-- 4. Seed original Plan entries (in case they were removed)
INSERT INTO "Plan" ("code", "name", "description", "status", "sortOrder")
VALUES
  ('basic', 'Amisi Genuine Basic', 'Basic plan for new businesses', 'ACTIVE', 1),
  ('standard', 'Amisi Genuine Standard', 'Standard plan for growing businesses', 'ACTIVE', 2),
  ('premium', 'Amisi Genuine Premium', 'Premium plan for established businesses', 'ACTIVE', 3)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "status" = EXCLUDED."status",
  "sortOrder" = EXCLUDED."sortOrder";