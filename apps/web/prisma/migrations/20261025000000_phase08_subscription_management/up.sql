-- Migration: Phase 08 – Subscription management and feature entitlements
--
-- Adds the Subscription and SubscriptionStatusHistory models to the database,
-- migrates existing Tenant.planId references, and establishes RLS policies.
--
-- 1. Create the Subscription table
CREATE TABLE IF NOT EXISTS "Subscription" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID NOT NULL UNIQUE,
  "planId"        UUID,
  "status"        TEXT NOT NULL DEFAULT 'ACTIVE',
  "current_period_start" TIMESTAMP WITH TIME ZONE,
  "current_period_end" TIMESTAMP WITH TIME ZONE,
  "trial_start" TIMESTAMP WITH TIME ZONE,
  "trial_end" TIMESTAMP WITH TIME ZONE,
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
  "canceled_at" TIMESTAMP WITH TIME ZONE,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  "tenant" Tenant NOT NULL @relation("SubscriptionTenant", fields: ["tenantId"], references: ["id"], onDelete: CASCADE),
  "plan" Plan @relation("SubscriptionPlan", fields: ["planId"], references: ["id"], onDelete: SET NULL),

  CONSTRAINT "Subscription_tenantId_key" UNIQUE ("tenantId"),
  CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL,
  CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE
);

-- 2. Create the SubscriptionStatusHistory table
CREATE TABLE IF NOT EXISTS "SubscriptionStatusHistory" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriptionId" UUID NOT NULL,
  "from_status" TEXT,
  "to_status"   TEXT NOT NULL,
  "changed_by"  UUID,
  "reason" TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  "subscription" Subscription NOT NULL @relation("SubscriptionHistorySubscription", fields: ["subscriptionId"], references: ["id"], onDelete: CASCADE),

  CONSTRAINT "SubscriptionStatusHistory_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ONDELETE CASCADE,
  CONSTRAINT "SubscriptionStatusHistory_changedBy_fkey" FOREIGN KEY ("changed_by") REFERENCES "User"("id") ON DELETE SET NULL
);

-- 3. Migrate existing Tenant.planId to Subscription
--    For every tenant that has a planId, create a subscription record.
--    If the tenant already has an active subscription, skip (idempotent).
INSERT INTO "Subscription" ("tenantId", "planId", "status", "current_period_start", "current_period_end", "trial_start", "trial_end", "cancel_at_period_end", "canceled_at", "createdAt", "updatedAt")
SELECT
  t."id" AS "tenantId",
  t."planId" AS "planId",
  CASE WHEN t."status" = 'ACTIVE' THEN 'ACTIVE' ELSE 'ACTIVE' END AS "status",
  NULL AS "current_period_start",
  NULL AS "current_period_end",
  NULL AS "trial_start",
  NULL AS "trial_end",
  false AS "cancel_at_period_end",
  NULL AS "canceled_at",
  t."createdAt" AS "createdAt",
  now() AS "updatedAt"
FROM "Tenant" t
WHERE t."planId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."tenantId" = t."id");

-- 4. Update Tenant table: remove the planId column and its relation
--    (The subscription now manages the plan association).
--    We set planId to NULL and drop the index/relation.
ALTER TABLE "Tenant" COLUMN "planId" SET NULL;
DROP INDEX IF EXISTS "Tenant_planId_idx";
DROP INDEX IF EXISTS "Tenant_planId_fkey" IF EXISTS;
-- Note: The foreign key constraint may need to be handled by the DB admin;
-- here we just remove the column reference.

-- 5. Add RLS policies for the new tables
--    Subscription is readable by platform admins only; tenant owner can read their own.
ALTER TABLE "Subscription" ROWLEVEL SECURITY TRUE;
CREATE POLICY "Platform admins can read all subscriptions" ON "Subscription"
  FOR SELECT USING (exists(select 1 from "User" u where u."platformRole" = 'SUPER_ADMIN'));
CREATE POLICY "Tenant owner can read own subscription" ON "Subscription"
  FOR SELECT USING (exists(select 1 from "TenantMember" m where m."tenantId" = "Subscription"."tenantId" AND m."userId" = current_setting('app.current_user_id')::uuid AND m."role" = 'TENANT_OWNER'));

--    SubscriptionStatusHistory is append-only; readable by platform admins.
ALTER TABLE "SubscriptionStatusHistory" ROWLEVEL SECURITY TRUE;
CREATE POLICY "Platform admins can read subscription history" ON "SubscriptionStatusHistory"
  FOR SELECT USING (exists(select 1 from "User" u where u."platformRole" = 'SUPER_ADMIN'));
CREATE POLICY "Tenant can read own subscription history" ON "SubscriptionStatusHistory"
  FOR SELECT USING (exists(select 1 from "TenantMember" m where m."tenantId" = "SubscriptionStatusHistory"."subscription"."tenantId" AND m."userId" = current_setting('app.current_user_id')::uuid));

-- 6. Update the Plan table comment to reflect the new architecture
--    (No DDL change needed; comment is documentation only.)
REM: Plan model remains the provider catalogue; active subscription lives on Subscription.

-- 7. Seed initial plan entries if the table is empty (idempotent)
--    These correspond to the original Phase 1 plan catalogue.
INSERT INTO "Plan" ("code", "name", "description", "status", "sortOrder")
SELECT * FROM (
  VALUES
    ('basic', 'Amisi Genuine Basic', 'Basic plan for new businesses', 'ACTIVE', 1),
    ('standard', 'Amisi Genuine Standard', 'Standard plan for growing businesses', 'ACTIVE', 2),
    ('premium', 'Amisi Genuine Premium', 'Premium plan for established businesses', 'ACTIVE', 3)
) AS tmp ("code", "name", "description", "status", "sortOrder")
WHERE NOT EXISTS (SELECT 1 FROM "Plan" WHERE "code" IN ('basic', 'standard', 'premium'));