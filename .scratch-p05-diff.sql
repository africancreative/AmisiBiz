-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('QUOTATION', 'INVOICE', 'DELIVERY_NOTE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'PARTIALLY_DELIVERED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CARD', 'CHEQUE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentDiscountType" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "DocumentPeriodStyle" AS ENUM ('NONE', 'CALENDAR_YEAR', 'FINANCIAL_YEAR');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "customerNote" TEXT,
ADD COLUMN     "deliveryDate" TIMESTAMP(3),
ADD COLUMN     "deliveryNote" TEXT,
ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "expiryDate" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "issuedById" TEXT,
ADD COLUMN     "replacementOfId" TEXT,
ADD COLUMN     "roundingPolicy" TEXT NOT NULL DEFAULT 'half-up-per-line-v1',
ADD COLUMN     "snapshot" JSONB,
ADD COLUMN     "snapshotAt" TIMESTAMP(3),
ADD COLUMN     "sourceDocumentId" TEXT,
ADD COLUMN     "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "taxBreakdown" JSONB,
ADD COLUMN     "taxTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "taxableBase" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "terms" TEXT,
ADD COLUMN     "totalDiscount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT,
DROP COLUMN "type",
ADD COLUMN     "type" "DocumentType" NOT NULL,
ALTER COLUMN "number" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
ALTER COLUMN "total" SET DEFAULT 0,
ALTER COLUMN "currency" SET DEFAULT 'KES';

-- AlterTable
ALTER TABLE "TenantSettings" DROP COLUMN "documentNextNumber",
DROP COLUMN "documentPrefix",
DROP COLUMN "quotationPrefix";

-- CreateTable
CREATE TABLE "DocumentLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "itemId" TEXT,
    "sourceLineId" TEXT,
    "description" TEXT NOT NULL,
    "itemCode" TEXT,
    "unitOfMeasure" TEXT NOT NULL DEFAULT 'each',
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "discountType" "DocumentDiscountType",
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,4) NOT NULL,
    "lineDiscount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lineNet" DECIMAL(18,4) NOT NULL,
    "lineTax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxRateId" TEXT,
    "taxName" TEXT,
    "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "deliveredQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "note" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentStatusEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fromStatus" "DocumentStatus",
    "toStatus" "DocumentStatus" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentNumbering" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "padding" INTEGER NOT NULL DEFAULT 4,
    "separator" TEXT NOT NULL DEFAULT '-',
    "periodStyle" "DocumentPeriodStyle" NOT NULL DEFAULT 'CALENDAR_YEAR',
    "fiscalStartMonth" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentNumbering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentNumberSequence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "period" TEXT NOT NULL DEFAULT '',
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentNumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentLine_tenantId_idx" ON "DocumentLine"("tenantId");

-- CreateIndex
CREATE INDEX "DocumentLine_tenantId_itemId_idx" ON "DocumentLine"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLine_tenantId_documentId_position_key" ON "DocumentLine"("tenantId", "documentId", "position");

-- CreateIndex
CREATE INDEX "DocumentPayment_tenantId_idx" ON "DocumentPayment"("tenantId");

-- CreateIndex
CREATE INDEX "DocumentPayment_tenantId_documentId_idx" ON "DocumentPayment"("tenantId", "documentId");

-- CreateIndex
CREATE INDEX "DocumentPayment_tenantId_occurredOn_idx" ON "DocumentPayment"("tenantId", "occurredOn");

-- CreateIndex
CREATE INDEX "DocumentStatusEvent_tenantId_documentId_idx" ON "DocumentStatusEvent"("tenantId", "documentId");

-- CreateIndex
CREATE INDEX "DocumentStatusEvent_tenantId_createdAt_idx" ON "DocumentStatusEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentNumbering_tenantId_idx" ON "DocumentNumbering"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentNumbering_tenantId_type_key" ON "DocumentNumbering"("tenantId", "type");

-- CreateIndex
CREATE INDEX "DocumentNumberSequence_tenantId_idx" ON "DocumentNumberSequence"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentNumberSequence_tenantId_type_period_key" ON "DocumentNumberSequence"("tenantId", "type", "period");

-- CreateIndex
CREATE INDEX "Document_tenantId_status_idx" ON "Document"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Document_tenantId_type_status_idx" ON "Document"("tenantId", "type", "status");

-- CreateIndex
CREATE INDEX "Document_tenantId_dueDate_idx" ON "Document"("tenantId", "dueDate");

-- CreateIndex
CREATE INDEX "Document_tenantId_sourceDocumentId_idx" ON "Document"("tenantId", "sourceDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_tenantId_type_number_key" ON "Document"("tenantId", "type", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Document_tenantId_idempotencyKey_key" ON "Document"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_replacementOfId_fkey" FOREIGN KEY ("replacementOfId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_sourceLineId_fkey" FOREIGN KEY ("sourceLineId") REFERENCES "DocumentLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPayment" ADD CONSTRAINT "DocumentPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPayment" ADD CONSTRAINT "DocumentPayment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentStatusEvent" ADD CONSTRAINT "DocumentStatusEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentStatusEvent" ADD CONSTRAINT "DocumentStatusEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentNumbering" ADD CONSTRAINT "DocumentNumbering_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentNumberSequence" ADD CONSTRAINT "DocumentNumberSequence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentNumberSequence" ADD CONSTRAINT "DocumentNumberSequence_tenantId_type_fkey" FOREIGN KEY ("tenantId", "type") REFERENCES "DocumentNumbering"("tenantId", "type") ON DELETE CASCADE ON UPDATE CASCADE;

