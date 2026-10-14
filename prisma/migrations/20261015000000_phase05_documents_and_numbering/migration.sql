-- Migration: Phase 05 — document engine (quotations, invoices, delivery notes):
--              document headers and lines, recorded payments, the status event
--              log, per-tenant numbering configuration and counters, issued-
--              document immutability, and row level security for the new tables.
-- Created: 2026-10-14
--
-- Why this file exists: `prisma/schema.prisma` declares the Phase 05 models and
-- `20261014000000_phase04_...` created a header-only `Document` table (type /
-- number / status / total) for contact history. Phase 05 turns that stub into
-- the document engine: enum-typed type and status, line items, stored tax
-- breakdown, issuance snapshots, payment records and authoritative numbering.
--
-- Rules this migration implements:
--   * Money is never binary floating point. Every monetary and quantity column
--     is `DECIMAL(18,4)`, tax fractions are `DECIMAL(5,4)` and percentages are
--     `DECIMAL(5,2)`. The internal consistency of the stored breakdown
--     (subtotal → discount → taxable base → tax → total) is a database CHECK,
--     not a convention, so a miscalculation cannot be persisted.
--   * A DRAFT is editable and has no number. Everything else is frozen:
--     `status = 'DRAFT'` and `number IS NULL` are equivalent (CHECK), and
--     triggers refuse to update or delete an issued document's financially
--     material fields. Corrections happen by voiding or by issuing a
--     replacement that keeps the original row.
--   * Numbers come from the database, never from the browser. Allocation runs
--     inside `allocate_document_number()`, which locks the counter row with
--     `SELECT ... FOR UPDATE`, so two concurrent issuances of the same series
--     serialise instead of both reading the same value. The tenant-scoped
--     unique index on the number is the backstop if that lock is ever bypassed.
--   * Issued numbers are never reused: the counter only moves forward, drafts
--     never consume a value, and an issued document cannot be deleted.
--   * A derived document is a copy, not a live view: `DocumentLine` snapshots
--     the description, code, unit, price, discount and tax rate onto the line,
--     so retiring a tax rate or editing the catalogue cannot rewrite history.
--     Provenance (`itemId`, `sourceLineId`, `sourceDocumentId`) is retained but
--     restricted from cascading away.
--   * Every tenant-owned row is keyed by "tenantId", every lookup index leads
--     with "tenantId", and triggers assert that a child row and its parent
--     document belong to the same tenant — a cross-tenant link is rejected even
--     if the application layer has a bug.
--   * Row level security mirrors the isolation enforced by `authorizeTenant()`.

-- ─── Enums ────────────────────────────────────────────────────────────────────

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

-- ─── A. Document header: from stub to engine ─────────────────────────────────
-- The legacy `type`/`status` columns are TEXT holding the Phase 04 vocabulary
-- (`INVOICE`/`QUOTE` and the invoice statuses). They are converted with an
-- explicit `USING` cast rather than dropped and re-added, so any row written by
-- the contact-history read path survives the conversion — `QUOTE` maps onto
-- `QUOTATION`, every other value already exists in the new enum. If a database
-- ever held a status outside the enum this statement fails loudly instead of
-- silently discarding the document.

ALTER TABLE "Document"
    ADD COLUMN "customerNote" TEXT,
    ADD COLUMN "deliveryDate" TIMESTAMP(3),
    ADD COLUMN "deliveryNote" TEXT,
    ADD COLUMN "dueDate" TIMESTAMP(3),
    ADD COLUMN "expiryDate" TIMESTAMP(3),
    ADD COLUMN "idempotencyKey" TEXT,
    ADD COLUMN "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "issuedById" TEXT,
    ADD COLUMN "replacementOfId" TEXT,
    ADD COLUMN "roundingPolicy" TEXT NOT NULL DEFAULT 'half-up-per-line-v1',
    ADD COLUMN "snapshot" JSONB,
    ADD COLUMN "snapshotAt" TIMESTAMP(3),
    ADD COLUMN "sourceDocumentId" TEXT,
    ADD COLUMN "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN "taxBreakdown" JSONB,
    ADD COLUMN "taxTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN "taxableBase" DECIMAL(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN "terms" TEXT,
    ADD COLUMN "totalDiscount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN "voidReason" TEXT,
    ADD COLUMN "voidedAt" TIMESTAMP(3),
    ADD COLUMN "voidedById" TEXT;

ALTER TABLE "Document" ALTER COLUMN "type" TYPE "DocumentType"
    USING (CASE "type"
               WHEN 'QUOTE' THEN 'QUOTATION'::"DocumentType"
               ELSE "type"::"DocumentType"
           END);

ALTER TABLE "Document" ALTER COLUMN "status" TYPE "DocumentStatus"
    USING ("status"::"DocumentStatus");

ALTER TABLE "Document" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- A draft has no number yet; the value is allocated by the database at issuance.
ALTER TABLE "Document" ALTER COLUMN "number" DROP NOT NULL;

ALTER TABLE "Document" ALTER COLUMN "total" SET DEFAULT 0;
ALTER TABLE "Document" ALTER COLUMN "currency" SET DEFAULT 'KES';

-- ─── B. New tables ───────────────────────────────────────────────────────────

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

-- ─── Indexes ─────────────────────────────────────────────────────────────────

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
CREATE INDEX "Document_tenantId_type_status_idx" ON "Document"("tenantId", "type", "status");

-- CreateIndex
CREATE INDEX "Document_tenantId_dueDate_idx" ON "Document"("tenantId", "dueDate");

-- CreateIndex
CREATE INDEX "Document_tenantId_sourceDocumentId_idx" ON "Document"("tenantId", "sourceDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_tenantId_idempotencyKey_key" ON "Document"("tenantId", "idempotencyKey");

-- `Document_tenantId_status_idx` and `Document_tenantId_type_number_key` were
-- created in 20261014000000 and are deliberately not re-created here: the
-- `ALTER COLUMN ... TYPE` casts above rebuild indexes over the converted
-- columns in place, and the number index keeps working now that drafts carry
-- NULL, because a unique index in PostgreSQL treats NULLs as distinct — any
-- number of unnumbered drafts can coexist, but no two issued documents of the
-- same series in the same tenant can share a number.

-- ─── Foreign keys ────────────────────────────────────────────────────────────

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

-- ─── C. Numbering: one series per tenant per document type ───────────────────
-- Phase 03 put `documentPrefix` / `quotationPrefix` on `TenantSettings` and the
-- platform console displayed them. Those columns are replaced here rather than
-- kept alongside `DocumentNumbering`, because two sources of truth for an
-- authoritative number is how documents end up sharing one. The prefixes carry
-- over so an operator's configuration is not silently reset; the counter does
-- not, because the Phase 03 stub never allocated a number (issuance did not
-- exist), so `documentNextNumber` had no meaning to inherit. If a real database
-- ever does hold issued documents, the unique index on
-- ("tenantId", "type", "number") makes any overlap fail at issuance rather than
-- produce a duplicate.

INSERT INTO "DocumentNumbering"
    ("id", "tenantId", "type", "prefix", "padding", "separator", "periodStyle", "fiscalStartMonth", "createdAt", "updatedAt")
SELECT
    'docnum_' || md5(t."id" || '|' || d."type"::text),
    t."id",
    d."type",
    CASE d."type"
        WHEN 'INVOICE'::"DocumentType"   THEN COALESCE(NULLIF(s."documentPrefix", ''), 'INV')
        WHEN 'QUOTATION'::"DocumentType" THEN COALESCE(NULLIF(s."quotationPrefix", ''), 'QUO')
        ELSE 'DN'
    END,
    4,
    '-',
    'CALENDAR_YEAR'::"DocumentPeriodStyle",
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN (VALUES ('QUOTATION'::"DocumentType"), ('INVOICE'), ('DELIVERY_NOTE')) AS d("type")
LEFT JOIN "TenantSettings" s ON s."tenantId" = t."id"
ON CONFLICT ("tenantId", "type") DO NOTHING;

-- AlterTable
ALTER TABLE "TenantSettings"
    DROP COLUMN "documentNextNumber",
    DROP COLUMN "documentPrefix",
    DROP COLUMN "quotationPrefix";

-- ─── D. Constraints: the arithmetic the engine promises ──────────────────────
-- `half-up-per-line-v1` (see `src/server/services/documents/calculations.ts`)
-- rounds quantity × price, the line discount and the line tax each to four
-- decimals before anything is summed. Because every stored component is already
-- rounded to the same scale, the document-level identities below are exact
-- equalities and can be enforced as CHECKs.

ALTER TABLE "Document"
    ADD CONSTRAINT "document_totals_are_consistent"
        CHECK ("taxableBase" = "subtotal" - "totalDiscount"
           AND "total" = "taxableBase" + "taxTotal"),
    ADD CONSTRAINT "document_taxable_base_is_not_negative"
        CHECK ("subtotal" >= 0 AND "totalDiscount" >= 0 AND "totalDiscount" <= "subtotal"
           AND "taxTotal" >= 0 AND "taxableBase" >= 0),
    -- A draft has no number; anything else must have one. Exactly one of the two
    -- states is possible, which is what makes abandoned drafts harmless to the
    -- sequence: they never consume a value.
    ADD CONSTRAINT "document_number_exists_only_when_not_draft"
        CHECK (("status" = 'DRAFT') = ("number" IS NULL)),
    -- Issuance is only complete once the snapshot and the actor are recorded.
    ADD CONSTRAINT "document_issued_documents_are_snapshotted"
        CHECK ("status" = 'DRAFT'
           OR ("snapshot" IS NOT NULL AND "snapshotAt" IS NOT NULL
               AND "issuedAt" IS NOT NULL AND "issuedById" IS NOT NULL)),
    ADD CONSTRAINT "document_voiding_requires_a_reason_and_an_actor"
        CHECK ("voidedAt" IS NULL
           OR ("voidReason" IS NOT NULL AND char_length(btrim("voidReason")) >= 3
               AND "voidedById" IS NOT NULL)),
    ADD CONSTRAINT "document_void_only_applies_to_invoices"
        CHECK ("status" <> 'VOID' OR "type" = 'INVOICE'),
    -- The status vocabulary is per document type; a quotation cannot be PAID.
    ADD CONSTRAINT "document_status_matches_type"
        CHECK (
            ("type" = 'QUOTATION'
                AND "status" IN ('DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
         OR ("type" = 'INVOICE'
                AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID'))
         OR ("type" = 'DELIVERY_NOTE'
                AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED'))
        ),
    -- Only a sales document can be derived from another document, and a derived
    -- document always names its source.
    ADD CONSTRAINT "document_only_sales_documents_carry_a_source"
        CHECK ("sourceDocumentId" IS NULL OR "type" IN ('INVOICE', 'DELIVERY_NOTE')),
    -- An issued document must be complete enough to stand on its own.
    ADD CONSTRAINT "document_issued_documents_are_addressable"
        CHECK ("status" = 'DRAFT' OR "contactId" IS NOT NULL),
    ADD CONSTRAINT "document_issued_quotation_has_an_expiry"
        CHECK ("type" <> 'QUOTATION' OR "status" = 'DRAFT' OR "expiryDate" IS NOT NULL),
    ADD CONSTRAINT "document_issued_invoice_has_a_due_date"
        CHECK ("type" <> 'INVOICE' OR "status" = 'DRAFT' OR "dueDate" IS NOT NULL),
    ADD CONSTRAINT "document_issued_delivery_note_has_a_delivery_date"
        CHECK ("type" <> 'DELIVERY_NOTE' OR "status" = 'DRAFT' OR "deliveryDate" IS NOT NULL),
    -- A number is an identifier printed on a legal document: bounded, plain and
    -- never markup, whatever wrote it.
    ADD CONSTRAINT "document_number_is_safe"
        CHECK ("number" IS NULL OR ("number" ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$')),
    ADD CONSTRAINT "document_rounding_policy_is_named"
        CHECK ("roundingPolicy" ~ '^[a-z0-9_-]{1,64}$'),
    ADD CONSTRAINT "document_text_fields_are_bounded"
        CHECK (coalesce(char_length("customerNote"), 0) <= 2000
           AND coalesce(char_length("terms"), 0) <= 8000
           AND coalesce(char_length("deliveryNote"), 0) <= 1000
           AND coalesce(char_length("voidReason"), 0) <= 500),
    ADD CONSTRAINT "document_idempotency_key_is_bounded"
        CHECK ("idempotencyKey" IS NULL OR ("idempotencyKey" ~ '^[A-Za-z0-9_-]{8,64}$'));

ALTER TABLE "DocumentLine"
    ADD CONSTRAINT "document_line_position_is_bounded"
        CHECK ("position" >= 1 AND "position" <= 1000),
    ADD CONSTRAINT "document_line_quantity_is_positive_and_bounded"
        CHECK ("quantity" > 0 AND "quantity" <= 999999.9999),
    ADD CONSTRAINT "document_line_price_is_bounded"
        CHECK ("unitPrice" >= 0 AND "unitPrice" < 1000000000000),
    -- The stored line arithmetic: net = gross - discount, both within the line.
    ADD CONSTRAINT "document_line_net_matches_its_components"
        CHECK ("lineNet" = "lineTotal" - "lineDiscount"
           AND "lineTotal" >= 0 AND "lineTotal" < 1000000000000),
    ADD CONSTRAINT "document_line_discount_is_within_the_line"
        CHECK ("lineDiscount" >= 0 AND "lineDiscount" <= "lineTotal"),
    -- Exactly one discount mechanism per line, and no discount at all is the
    -- NULL case with both values zero. This is what stops a client from sending
    -- `discountPercent: 50, discountAmount: 5000` and hoping one is ignored.
    ADD CONSTRAINT "document_line_discount_mechanism_is_single"
        CHECK (
            ("discountType" IS NULL AND "discountPercent" = 0 AND "discountAmount" = 0)
         OR ("discountType" = 'PERCENT' AND "discountPercent" > 0 AND "discountAmount" = 0)
         OR ("discountType" = 'AMOUNT' AND "discountAmount" > 0 AND "discountPercent" = 0)
        ),
    ADD CONSTRAINT "document_line_discount_percent_is_a_percent"
        CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100),
    ADD CONSTRAINT "document_line_discount_amount_is_bounded"
        CHECK ("discountAmount" >= 0 AND "discountAmount" < 1000000000000),
    ADD CONSTRAINT "document_line_tax_rate_is_a_fraction"
        CHECK ("taxRate" >= 0 AND "taxRate" <= 1),
    ADD CONSTRAINT "document_line_tax_is_non_negative"
        CHECK ("lineTax" >= 0),
    -- A line can never be over-delivered, and only lines of sales documents
    -- carry delivery counters.
    ADD CONSTRAINT "document_line_delivered_quantity_is_within_the_line"
        CHECK ("deliveredQuantity" >= 0 AND "deliveredQuantity" <= "quantity"),
    ADD CONSTRAINT "document_line_text_is_safe"
        CHECK (char_length("description") BETWEEN 1 AND 500
           AND coalesce(char_length("itemCode"), 0) <= 64
           AND char_length("unitOfMeasure") BETWEEN 1 AND 32);

ALTER TABLE "DocumentPayment"
    ADD CONSTRAINT "document_payment_amount_is_positive_and_bounded"
        CHECK ("amount" > 0 AND "amount" < 1000000000000),
    ADD CONSTRAINT "document_payment_reversal_is_complete"
        CHECK (("reversedAt" IS NULL AND "reversedBy" IS NULL)
            OR ("reversedAt" IS NOT NULL AND "reversedBy" IS NOT NULL)),
    ADD CONSTRAINT "document_payment_reference_is_bounded"
        CHECK (coalesce(char_length("reference"), 0) <= 100
           AND coalesce(char_length("note"), 0) <= 500);

ALTER TABLE "DocumentStatusEvent"
    ADD CONSTRAINT "document_status_event_transition_is_not_a_no_op"
        CHECK ("toStatus" IS DISTINCT FROM "fromStatus" OR "fromStatus" IS NULL),
    ADD CONSTRAINT "document_status_event_reason_is_bounded"
        CHECK (coalesce(char_length("reason"), 0) <= 500);

ALTER TABLE "DocumentNumbering"
    -- The prefix is printed on customer documents, so it is a short uppercase
    -- token, never free text: `INV`, `INV2026`, `ACME-INV`.
    ADD CONSTRAINT "document_numbering_prefix_is_a_token"
        CHECK ("prefix" = '' OR ("prefix" ~ '^[A-Z][A-Z0-9-]{0,19}$')),
    ADD CONSTRAINT "document_numbering_separator_is_one_character"
        CHECK ("separator" ~ '^[-_./]{1}$'),
    ADD CONSTRAINT "document_numbering_padding_is_usable"
        CHECK ("padding" >= 1 AND "padding" <= 12);

ALTER TABLE "DocumentNumberSequence"
    ADD CONSTRAINT "document_number_sequence_never_goes_backwards"
        CHECK ("nextValue" >= 1),
    ADD CONSTRAINT "document_number_sequence_period_is_a_year_or_empty"
        CHECK ("period" = '' OR ("period" ~ '^[0-9]{4}$') OR ("period" ~ '^[0-9]{4}/[0-9]{2}$'));

-- Retried conversions must not create a second invoice for the same quotation.
-- Delivery notes are deliberately excluded: partial deliveries are legitimate,
-- so several delivery notes may reference one source document and duplicate
-- protection there comes from the per-request idempotency key instead.
CREATE UNIQUE INDEX "document_one_invoice_per_source" ON "Document"("sourceDocumentId")
    WHERE "type" = 'INVOICE' AND "sourceDocumentId" IS NOT NULL;

-- ─── E. Integrity triggers ───────────────────────────────────────────────────
-- Two different guarantees, both enforced below the application layer:
--   1. a child row must belong to the same tenant as its parent, so a forged
--      id from another tenant is rejected even by a query that forgot its
--      predicate;
--   2. an issued document is immutable in its financially material fields.

CREATE OR REPLACE FUNCTION document_references_belong_to_tenant()
RETURNS trigger AS $$
BEGIN
    IF NEW."tenantId" IS NULL THEN
        RAISE EXCEPTION 'A document must belong to a tenant'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."contactId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Contact" c
        WHERE c."id" = NEW."contactId" AND c."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Contact % does not belong to tenant %', NEW."contactId", NEW."tenantId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."sourceDocumentId" IS NOT NULL AND NEW."sourceDocumentId" = NEW."id" THEN
        RAISE EXCEPTION 'A document cannot be derived from itself'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."sourceDocumentId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Document" d
        WHERE d."id" = NEW."sourceDocumentId" AND d."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Source document % does not belong to tenant %', NEW."sourceDocumentId", NEW."tenantId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."replacementOfId" IS NOT NULL AND NEW."replacementOfId" = NEW."id" THEN
        RAISE EXCEPTION 'A document cannot replace itself'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."replacementOfId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Document" d
        WHERE d."id" = NEW."replacementOfId" AND d."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Replaced document % does not belong to tenant %', NEW."replacementOfId", NEW."tenantId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_references_belong_to_tenant
    BEFORE INSERT OR UPDATE ON "Document"
    FOR EACH ROW EXECUTE FUNCTION document_references_belong_to_tenant();

CREATE OR REPLACE FUNCTION document_child_belongs_to_document_tenant(
    p_tenant_id text, p_document_id text, p_child text
) RETURNS void AS $$
BEGIN
    IF p_tenant_id IS NULL OR p_document_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM "Document" d
        WHERE d."id" = p_document_id AND d."tenantId" = p_tenant_id
    ) THEN
        RAISE EXCEPTION '% % does not belong to tenant %', initcap(p_child), p_document_id, p_tenant_id
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION document_child_is_same_tenant()
RETURNS trigger AS $$
BEGIN
    PERFORM document_child_belongs_to_document_tenant(
        NEW."tenantId", NEW."documentId", TG_TABLE_NAME);
    RETURN NEW;
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

-- A line's own tenant must match its document's tenant (the trigger above
-- already proves the document exists in that tenant) and a delivery line must
-- point at a line of a document in the same tenant.
CREATE OR REPLACE FUNCTION document_line_references_are_valid()
RETURNS trigger AS $$
DECLARE
    v_source_tenant text;
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

CREATE TRIGGER document_line_references_are_valid
    BEFORE INSERT OR UPDATE ON "DocumentLine"
    FOR EACH ROW EXECUTE FUNCTION document_line_references_are_valid();

-- ─── F. Immutability of issued documents ─────────────────────────────────────
-- The lifecycle is enforced here as well as in the domain layer: once a document
-- leaves DRAFT, no role — including the table owner editing rows by hand — can
-- rewrite what the document says. The columns that may still change are exactly
-- the lifecycle columns (status, issuance/void attribution) plus "updatedAt".
-- Reversing that decision would be a new document, which is what the
-- replacement flow produces.

CREATE OR REPLACE FUNCTION document_is_immutable_after_issue()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'DRAFT' THEN
            RAISE EXCEPTION 'Document % is not a draft and cannot be deleted; void or replace it instead',
                OLD."number"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- Nothing that was ever issued can be pushed back into the editable state.
    IF OLD."status" <> 'DRAFT' AND NEW."status" = 'DRAFT' THEN
        RAISE EXCEPTION 'Document % cannot return to DRAFT once it has been issued', OLD."number"
            USING ERRCODE = 'check_violation';
        END IF;

    IF OLD."status" <> 'DRAFT' THEN
        IF NEW."number" IS DISTINCT FROM OLD."number"
        OR NEW."type" IS DISTINCT FROM OLD."type"
        OR NEW."currency" IS DISTINCT FROM OLD."currency"
        OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
        OR NEW."sourceDocumentId" IS DISTINCT FROM OLD."sourceDocumentId"
        OR NEW."replacementOfId" IS DISTINCT FROM OLD."replacementOfId"
        OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
        OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate"
        OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
        OR NEW."expiryDate" IS DISTINCT FROM OLD."expiryDate"
        OR NEW."deliveryDate" IS DISTINCT FROM OLD."deliveryDate"
        OR NEW."deliveryNote" IS DISTINCT FROM OLD."deliveryNote"
        OR NEW."customerNote" IS DISTINCT FROM OLD."customerNote"
        OR NEW."terms" IS DISTINCT FROM OLD."terms"
        OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
        OR NEW."totalDiscount" IS DISTINCT FROM OLD."totalDiscount"
        OR NEW."taxableBase" IS DISTINCT FROM OLD."taxableBase"
        OR NEW."taxTotal" IS DISTINCT FROM OLD."taxTotal"
        OR NEW."total" IS DISTINCT FROM OLD."total"
        OR NEW."taxBreakdown" IS DISTINCT FROM OLD."taxBreakdown"
        OR NEW."roundingPolicy" IS DISTINCT FROM OLD."roundingPolicy"
        OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
        OR NEW."snapshotAt" IS DISTINCT FROM OLD."snapshotAt"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
            RAISE EXCEPTION 'Document % has been issued and its content is immutable; use a void and replacement to correct it',
                OLD."number"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_is_immutable_after_issue
    BEFORE UPDATE OR DELETE ON "Document"
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable_after_issue();

-- Lines follow the same rule, read through their document. The single
-- post-issuance change allowed is the running delivered quantity, because
-- recording a delivery against an issued sales document is a delivery fact, not
-- an edit of the document.
CREATE OR REPLACE FUNCTION document_line_is_immutable_after_issue()
RETURNS trigger AS $$
DECLARE
    v_status "DocumentStatus";
BEGIN
    SELECT d."status" INTO v_status FROM "Document" d WHERE d."id" = NEW."documentId";

    IF TG_OP = 'DELETE' THEN
        SELECT d."status" INTO v_status FROM "Document" d WHERE d."id" = OLD."documentId";
        IF v_status IS DISTINCT FROM 'DRAFT' THEN
            RAISE EXCEPTION 'Lines cannot be removed from document % once it is issued', OLD."documentId"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF v_status IS DISTINCT FROM 'DRAFT' THEN
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'Lines cannot be added to document % once it is issued', NEW."documentId"
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."deliveredQuantity" IS DISTINCT FROM OLD."deliveredQuantity" THEN
            -- The only other column pair that may move with it is provenance of
            -- the delivery itself; everything else must stay byte-identical.
            IF NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId"
            OR NEW."documentId" <> OLD."documentId" OR NEW."position" <> OLD."position"
            OR NEW."itemId" IS DISTINCT FROM OLD."itemId"
            OR NEW."sourceLineId" IS DISTINCT FROM OLD."sourceLineId"
            OR NEW."description" IS DISTINCT FROM OLD."description"
            OR NEW."itemCode" IS DISTINCT FROM OLD."itemCode"
            OR NEW."unitOfMeasure" IS DISTINCT FROM OLD."unitOfMeasure"
            OR NEW."quantity" <> OLD."quantity"
            OR NEW."unitPrice" <> OLD."unitPrice"
            OR NEW."discountType" IS DISTINCT FROM OLD."discountType"
            OR NEW."discountPercent" <> OLD."discountPercent"
            OR NEW."discountAmount" <> OLD."discountAmount"
            OR NEW."lineTotal" <> OLD."lineTotal"
            OR NEW."lineDiscount" <> OLD."lineDiscount"
            OR NEW."lineNet" <> OLD."lineNet"
            OR NEW."lineTax" <> OLD."lineTax"
            OR NEW."taxRateId" IS DISTINCT FROM OLD."taxRateId"
            OR NEW."taxName" IS DISTINCT FROM OLD."taxName"
            OR NEW."taxRate" <> OLD."taxRate" THEN
                RAISE EXCEPTION 'Document line % belongs to an issued document; only its delivered quantity may change',
                    OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSIF NEW."id" <> OLD."id"
            OR NEW."tenantId" <> OLD."tenantId"
            OR NEW."documentId" <> OLD."documentId"
            OR NEW."position" <> OLD."position"
            OR NEW."itemId" IS DISTINCT FROM OLD."itemId"
            OR NEW."sourceLineId" IS DISTINCT FROM OLD."sourceLineId"
            OR NEW."description" IS DISTINCT FROM OLD."description"
            OR NEW."itemCode" IS DISTINCT FROM OLD."itemCode"
            OR NEW."unitOfMeasure" IS DISTINCT FROM OLD."unitOfMeasure"
            OR NEW."quantity" <> OLD."quantity"
            OR NEW."unitPrice" <> OLD."unitPrice"
            OR NEW."discountType" IS DISTINCT FROM OLD."discountType"
            OR NEW."discountPercent" <> OLD."discountPercent"
            OR NEW."discountAmount" <> OLD."discountAmount"
            OR NEW."lineTotal" <> OLD."lineTotal"
            OR NEW."lineDiscount" <> OLD."lineDiscount"
            OR NEW."lineNet" <> OLD."lineNet"
            OR NEW."lineTax" <> OLD."lineTax"
            OR NEW."taxRateId" IS DISTINCT FROM OLD."taxRateId"
            OR NEW."taxName" IS DISTINCT FROM OLD."taxName"
            OR NEW."taxRate" <> OLD."taxRate" THEN
            RAISE EXCEPTION 'Document line % belongs to an issued document and is immutable',
                OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_line_is_immutable_after_issue
    BEFORE INSERT OR UPDATE OR DELETE ON "DocumentLine"
    FOR EACH ROW EXECUTE FUNCTION document_line_is_immutable_after_issue();

-- Payments and status events are append-only. A payment is reversed by marking
-- it, never by deleting it, so the balance history stays reconstructable.
CREATE OR REPLACE FUNCTION document_payment_is_append_only()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Document payment % cannot be deleted; reverse it instead', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD."reversedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Document payment % is already reversed', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId"
        OR NEW."documentId" <> OLD."documentId" OR NEW."amount" <> OLD."amount"
        OR NEW."occurredOn" <> OLD."occurredOn" OR NEW."method" <> OLD."method"
        OR NEW."reference" IS DISTINCT FROM OLD."reference"
        OR NEW."note" IS DISTINCT FROM OLD."note"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
            RAISE EXCEPTION 'Document payment % is immutable; reverse it and record a new payment',
                OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_payment_is_append_only
    BEFORE INSERT OR UPDATE OR DELETE ON "DocumentPayment"
    FOR EACH ROW EXECUTE FUNCTION document_payment_is_append_only();

CREATE OR REPLACE FUNCTION document_status_event_is_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Document status events are append-only; event % cannot be changed or removed',
        OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_status_event_is_append_only
    BEFORE UPDATE OR DELETE ON "DocumentStatusEvent"
    FOR EACH ROW EXECUTE FUNCTION document_status_event_is_append_only();

CREATE OR REPLACE FUNCTION document_status_event_actor_is_consistent()
RETURNS trigger AS $$
BEGIN
    IF NEW."actorId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "User" u WHERE u."id" = NEW."actorId"
    ) THEN
        RAISE EXCEPTION 'Actor % does not exist', NEW."actorId"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_status_event_actor_is_consistent
    BEFORE INSERT ON "DocumentStatusEvent"
    FOR EACH ROW EXECUTE FUNCTION document_status_event_actor_is_consistent();

-- ─── G. Authoritative number allocation ──────────────────────────────────────
-- The counter is moved inside these functions rather than by application
-- `update`s so that the lock and the increment cannot be separated by a bug.
-- `allocate_document_number()` is called inside the issuance transaction: if
-- issuance then fails, the increment rolls back with it and no number is burned.
-- Both functions are SECURITY DEFINER and owned by the role that applied this
-- migration, which is what lets them reach the counter rows regardless of the
-- row level security policies below; they are the only sanctioned path to the
-- counters and they always filter by the tenant they were handed.

CREATE OR REPLACE FUNCTION document_number_period(
    p_period_style "DocumentPeriodStyle",
    p_fiscal_start_month integer,
    p_date timestamptz
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
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION allocate_document_number(
    p_tenant_id text,
    p_type "DocumentType",
    p_date timestamptz DEFAULT now()
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
    -- (INV-2026-0001 / QUO-2026-0001 / DN-2026-0001).
    INSERT INTO "DocumentNumbering"
            ("id", "tenantId", "type", "prefix", "padding", "separator",
             "periodStyle", "fiscalStartMonth", "createdAt", "updatedAt")
    VALUES ('docnum_' || md5(p_tenant_id || '|' || p_type::text),
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
    VALUES ('docseq_' || md5(p_tenant_id || '|' || p_type::text || '|' || v_period),
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

    v_number := v_prefix
             || CASE WHEN v_prefix = '' OR v_period = '' THEN '' ELSE v_separator END
             || v_period
             || CASE WHEN v_period = '' THEN '' ELSE v_separator END
             || lpad(v_value::text, v_padding, '0');

    IF v_number !~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$' THEN
        RAISE EXCEPTION 'Generated document number % is not a safe identifier', v_number
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- The number a series will use next, without taking it. Used by the numbering
-- settings screen so an operator can see the effect of a prefix change. It never
-- creates rows and is not authoritative: issuance always calls
-- `allocate_document_number()`.
CREATE OR REPLACE FUNCTION peek_document_number(
    p_tenant_id text,
    p_type "DocumentType",
    p_date timestamptz DEFAULT now()
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

    RETURN v_prefix
         || CASE WHEN v_prefix = '' OR v_period = '' THEN '' ELSE v_separator END
         || v_period
         || CASE WHEN v_period = '' THEN '' ELSE v_separator END
         || lpad(v_value::text, v_padding, '0');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION allocate_document_number(text, "DocumentType", timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION peek_document_number(text, "DocumentType", timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION document_number_period("DocumentPeriodStyle", integer, timestamptz) FROM PUBLIC;

-- ─── Row level security ──────────────────────────────────────────────────────
-- Defence in depth behind the application's `authorizeTenant()` check. Same
-- deliberate limitations as Phase 04, recorded in
-- docs/implementation/phase-checklist.md: the policies read
-- `app.current_tenant_id`, which nothing sets yet, so the application layer is
-- the control in force today, and the tables are created by the migration role,
-- which bypasses RLS as owner. `Document` itself keeps the policy granted in
-- 20261014000000.

ALTER TABLE "DocumentLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentStatusEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentNumbering" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentNumberSequence" ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_line_tenant_isolation ON "DocumentLine"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY document_payment_tenant_isolation ON "DocumentPayment"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY document_status_event_tenant_isolation ON "DocumentStatusEvent"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY document_numbering_tenant_isolation ON "DocumentNumbering"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY document_number_sequence_tenant_isolation ON "DocumentNumberSequence"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

-- ─── Grants ──────────────────────────────────────────────────────────────────
-- The app role needs DML on the new tables (the defaults granted in
-- 20261013000001 only cover tables that existed when it ran). The counter table
-- is deliberately narrower than the others: it is read and moved only through
-- `allocate_document_number()` / `peek_document_number()`, so the app is not
-- given INSERT or DELETE — deleting a counter row would restart a series and
-- hand out an already issued number.

GRANT SELECT, INSERT, UPDATE, DELETE ON
    "DocumentLine", "DocumentPayment", "DocumentStatusEvent", "DocumentNumbering"
    TO amisibiz_app;

GRANT SELECT, UPDATE ON "DocumentNumberSequence" TO amisibiz_app;

GRANT EXECUTE ON FUNCTION allocate_document_number(text, "DocumentType", timestamptz) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION peek_document_number(text, "DocumentType", timestamptz) TO amisibiz_app;

-- ─── Comments ────────────────────────────────────────────────────────────────

COMMENT ON CONSTRAINT "document_totals_are_consistent" ON "Document" IS
    'The stored breakdown is an identity, not a hint: taxableBase = subtotal - totalDiscount and total = taxableBase + taxTotal. Enforced in the database because a client-supplied total must never be able to reach disk.';
COMMENT ON CONSTRAINT "document_number_exists_only_when_not_draft" ON "Document" IS
    'Drafts carry no number and issued documents always do, so abandoning or deleting a draft cannot burn a value from the series.';
COMMENT ON CONSTRAINT "document_status_matches_type" ON "Document" IS
    'Each document type owns its lifecycle: a quotation cannot be PAID and an invoice cannot be ACCEPTED.';
COMMENT ON CONSTRAINT "document_line_discount_mechanism_is_single" ON "DocumentLine" IS
    'A line has either a percentage discount, an amount discount, or neither — never two overlapping mechanisms.';
COMMENT ON CONSTRAINT "document_line_delivered_quantity_is_within_the_line" ON "DocumentLine" IS
    'The running delivered total on a sales document line; partial deliveries accumulate here and cannot exceed what was ordered.';
COMMENT ON CONSTRAINT "document_numbering_prefix_is_a_token" ON "DocumentNumbering" IS
    'Document number prefixes are short uppercase tokens printed on customer documents; never free text or markup.';

COMMENT ON INDEX "Document_tenantId_type_number_key" IS
    'Document numbers are unique inside a tenant and per series, never globally: two businesses may both be on INV-2026-0001. NULL numbers (drafts) do not collide.';
COMMENT ON INDEX "Document_tenantId_idempotencyKey_key" IS
    'One document per (tenant, idempotency key): a retried conversion or issuance returns the original instead of creating a second one.';
COMMENT ON INDEX "DocumentLine_tenantId_documentId_position_key" IS
    'Line order is stable and unambiguous within a document, which is what the snapshot and the PDF depend on.';
COMMENT ON INDEX "document_one_invoice_per_source" IS
    'A quotation converts to at most one invoice. Partial deliveries are allowed, so delivery notes are excluded and rely on the idempotency key instead.';
COMMENT ON INDEX "DocumentNumberSequence_tenantId_type_period_key" IS
    'One counter per tenant, document series and period (calendar year, financial year, or none).';

COMMENT ON FUNCTION allocate_document_number(text, "DocumentType", timestamptz) IS
    'Allocates the next document number for a tenant series inside the caller''s transaction, locking the counter row with SELECT ... FOR UPDATE. Never called from the browser; the number it returns is the only authoritative one.';
COMMENT ON FUNCTION peek_document_number(text, "DocumentType", timestamptz) IS
    'Returns the number the series would use next without taking it. Display only and not authoritative.';
COMMENT ON FUNCTION document_is_immutable_after_issue() IS
    'Blocks edits to the financially material content of an issued document and blocks deleting anything that is not a draft.';
COMMENT ON FUNCTION document_line_is_immutable_after_issue() IS
    'Blocks adding, removing or rewriting the lines of an issued document; only the running delivered quantity may change.';
COMMENT ON FUNCTION document_payment_is_append_only() IS
    'Payments are corrected by reversal, never by editing or deleting, so the balance history of an invoice stays reconstructable.';
COMMENT ON FUNCTION document_child_is_same_tenant() IS
    'A document child row must belong to the same tenant as its document, even if a query forgets its tenant predicate.';

COMMENT ON POLICY document_line_tenant_isolation ON "DocumentLine" IS 'Tenant isolation for document lines.';
COMMENT ON POLICY document_payment_tenant_isolation ON "DocumentPayment" IS 'Tenant isolation for recorded payments.';
COMMENT ON POLICY document_number_sequence_tenant_isolation ON "DocumentNumberSequence" IS 'Tenant isolation for document number counters.';
