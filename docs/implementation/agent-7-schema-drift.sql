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
    "status" TEXT NOT NULL,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "trial_start" TIMESTAMP(3),
    "trial_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionStatusHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriptionId" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "changed_by" TEXT,
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
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionStatusHistory" ADD CONSTRAINT "SubscriptionStatusHistory_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

