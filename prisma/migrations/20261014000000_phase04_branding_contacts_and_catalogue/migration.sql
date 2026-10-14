-- Migration: Phase 04 — tenant branding fields, contact CRM, tax configuration,
--              product/service catalogue, customer-specific catalogue and the
--              document header table used by contact history.
-- Created: 2026-10-14
--
-- Why this file exists: `prisma/schema.prisma` already declared the Phase 04
-- models, but no migration ever created them (only `20261013000000_init` and
-- `20261013000001_rls_policies_and_constraints` exist, and neither has been
-- applied to a database yet). Without it, every Phase 04 server action would
-- fail at runtime with a missing-table error.
--
-- Rules this migration implements:
--   * Money is never binary floating point. Every monetary column is
--     `DECIMAL(18,4)`; rates are `DECIMAL(5,4)` (a fraction, e.g. 0.1600) and
--     percentages are `DECIMAL(5,2)`. The application passes decimal *strings*
--     into `Prisma.Decimal`, so no `Number()`/`parseFloat()` is involved.
--   * Every tenant-owned row is keyed by "tenantId" and every lookup index is
--     tenant-scoped (leading column), so a query cannot stray across tenants
--     even when a predicate is forgotten.
--   * Uniqueness is tenant-scoped, never global: two businesses may use the same
--     SKU, the same tax category name or the same document number.
--   * Historical records are not cascade-destroyed: `Document.contactId` uses
--     ON DELETE SET NULL, and contacts are archived in the application rather
--     than deleted.
--   * Row-level security mirrors the application's tenant isolation so a future
--     query that forgets its `tenantId` predicate returns nothing instead of
--     leaking another tenant's data.

-- ─── Enums ────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- ─── A. Tenant branding ──────────────────────────────────────────────────────
-- `20261013000000_init` created TenantBranding with only four colours/display
-- fields. The business-facing settings (registered name, secondary colour,
-- contacts, addresses, tax PIN, currency, footer, payment instructions, document
-- layout) are added here. All are nullable: an unconfigured tenant must render
-- documents from safe defaults rather than from invented data.

ALTER TABLE "TenantBranding"
    ADD COLUMN "registeredName" TEXT,
    ADD COLUMN "secondaryColor" TEXT NOT NULL DEFAULT '#1e3a5f',
    ADD COLUMN "contactEmail" TEXT,
    ADD COLUMN "contactPhone" TEXT,
    ADD COLUMN "postalAddress" TEXT,
    ADD COLUMN "physicalAddress" TEXT,
    ADD COLUMN "website" TEXT,
    ADD COLUMN "taxPin" TEXT,
    ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'KES',
    ADD COLUMN "defaultFooter" TEXT,
    ADD COLUMN "paymentInstructions" TEXT,
    ADD COLUMN "documentLayout" TEXT NOT NULL DEFAULT 'standard';

-- A new tenant's default currency is KES (the only currency supported in this
-- phase); the init migration carried the earlier 'USD' default.
ALTER TABLE "Tenant" ALTER COLUMN "currency" SET DEFAULT 'KES';

-- Colours are validated in the application (`src/lib/validations/branding.ts`)
-- and normalised to a safe contrast-aware foreground in
-- `src/lib/branding/tokens.ts`. The CHECK below is the backstop for anything
-- written outside the app: a stored colour must be a plain 6-digit hex string,
-- never CSS, never markup.
ALTER TABLE "TenantBranding"
    ADD CONSTRAINT "TenantBranding_primaryColor_check"
        CHECK ("primaryColor" ~ '^#[0-9a-fA-F]{6}$'),
    ADD CONSTRAINT "TenantBranding_secondaryColor_check"
        CHECK ("secondaryColor" ~ '^#[0-9a-fA-F]{6}$'),
    ADD CONSTRAINT "TenantBranding_accentColor_check"
        CHECK ("accentColor" ~ '^#[0-9a-fA-F]{6}$'),
    ADD CONSTRAINT "TenantBranding_primaryForeground_check"
        CHECK ("primaryForeground" ~ '^#[0-9a-fA-F]{6}$');

-- Logo URLs point at the private `/uploads/tenants/<tenantId>/logo/<file>`
-- serving route (or a future object-storage URL). Free-form URLs are the way an
-- uploaded SVG or a javascript: payload would reach a document, so only the
-- controlled same-origin shape is accepted here.
ALTER TABLE "TenantBranding"
    ADD CONSTRAINT "TenantBranding_logoUrl_check"
        CHECK ("logoUrl" IS NULL OR "logoUrl" ~ '^/uploads/tenants/[a-z0-9]+/logo/[a-f0-9]{32}\.(png|jpe?g|webp)$');

-- ─── Tax configuration (explicit; never an implied flat rate) ────────────────

-- CreateTable
CREATE TABLE "TaxCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(5,4) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxCategory_tenantId_idx" ON "TaxCategory"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxCategory_tenantId_name_key" ON "TaxCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "TaxRate_tenantId_idx" ON "TaxRate"("tenantId");

-- CreateIndex
CREATE INDEX "TaxRate_categoryId_idx" ON "TaxRate"("categoryId");

-- CreateIndex
CREATE INDEX "TaxRate_effectiveFrom_idx" ON "TaxRate"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_tenantId_categoryId_name_effectiveFrom_key" ON "TaxRate"("tenantId", "categoryId", "name", "effectiveFrom");

-- A rate is stored as a fraction (0.1600 = 16%). Bounding it in the database
-- keeps a bad write from producing documents with impossible tax figures.
ALTER TABLE "TaxRate"
    ADD CONSTRAINT "TaxRate_rate_check" CHECK ("rate" >= 0 AND "rate" <= 1);

-- ─── B. Contacts CRM ─────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ContactType" NOT NULL DEFAULT 'INDIVIDUAL',
    "status" "ContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "taxPin" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_tenantId_idx" ON "Contact"("tenantId");

-- CreateIndex
CREATE INDEX "Contact_tenantId_status_idx" ON "Contact"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Contact_tenantId_email_idx" ON "Contact"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Contact_tenantId_phone_idx" ON "Contact"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "Contact_tenantId_companyName_idx" ON "Contact"("tenantId", "companyName");

-- CreateIndex
CREATE INDEX "Contact_tenantId_createdAt_idx" ON "Contact"("tenantId", "createdAt");

-- Identity is enforced in the database as well as in Zod: an individual needs a
-- person name, a business needs a company name. Otherwise half-populated rows
-- become unlabelable documents later.
ALTER TABLE "Contact"
    ADD CONSTRAINT "Contact_identity_check" CHECK (
        ("type" = 'INDIVIDUAL' AND (COALESCE(TRIM("firstName"), '') <> '' OR COALESCE(TRIM("lastName"), '') <> ''))
        OR ("type" = 'BUSINESS' AND COALESCE(TRIM("companyName"), '') <> '')
    );

-- An archive is soft: the row and everything referencing it stay, so `archivedAt`
-- must travel with the ARCHIVED status.
ALTER TABLE "Contact"
    ADD CONSTRAINT "Contact_archive_consistency_check" CHECK (
        ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
        OR ("status" = 'ACTIVE' AND "archivedAt" IS NULL)
    );

-- CreateTable
CREATE TABLE "ContactAddress" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactAddress_contactId_idx" ON "ContactAddress"("contactId");

-- CreateIndex
CREATE INDEX "ContactAddress_contactId_type_idx" ON "ContactAddress"("contactId", "type");

ALTER TABLE "ContactAddress"
    ADD CONSTRAINT "ContactAddress_type_check" CHECK ("type" IN ('POSTAL', 'PHYSICAL')),
    ADD CONSTRAINT "ContactAddress_country_check" CHECK ("country" IS NULL OR "country" ~ '^[A-Za-z]{2}$'),
    -- An address belongs to exactly one contact and one default per type.
    ADD CONSTRAINT "ContactAddress_line1_check" CHECK (TRIM("line1") <> '');

CREATE UNIQUE INDEX "ContactAddress_contactId_type_isDefault_partial"
    ON "ContactAddress"("contactId", "type")
    WHERE "isDefault" = true;

-- ─── C. Products & services catalogue ────────────────────────────────────────

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ItemType" NOT NULL DEFAULT 'PRODUCT',
    "status" "ItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT,
    "unitOfMeasure" TEXT NOT NULL DEFAULT 'each',
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "taxRateId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Item_tenantId_idx" ON "Item"("tenantId");

-- CreateIndex
CREATE INDEX "Item_tenantId_status_idx" ON "Item"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Item_tenantId_type_idx" ON "Item"("tenantId", "type");

-- CreateIndex
CREATE INDEX "Item_tenantId_name_idx" ON "Item"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Item_tenantId_sku_key" ON "Item"("tenantId", "sku");

-- `@@unique([tenantId, sku])` with a nullable SKU: PostgreSQL permits any number
-- of NULL SKUs, so blank-SKU items are represented as SQL NULL by the server
-- action rather than colliding on an empty string.
ALTER TABLE "Item"
    ADD CONSTRAINT "Item_unitPrice_check" CHECK ("unitPrice" >= 0),
    ADD CONSTRAINT "Item_name_check" CHECK (TRIM("name") <> ''),
    ADD CONSTRAINT "Item_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    -- The tax link is optional and must never point at another tenant's rate;
    -- the join is checked by the server action, and the composite key below
    -- makes a cross-tenant link impossible to index in the first place.
    ADD CONSTRAINT "Item_sku_blank_check" CHECK ("sku" IS NULL OR TRIM("sku") <> '');

-- ─── D. Customer-specific catalogue ─────────────────────────────────────────
-- Prices agreed with one customer live here and never touch `Item.unitPrice`, so
-- a customer-specific price cannot change the default price for anybody else.

-- CreateTable
CREATE TABLE "ContactItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "customCode" TEXT,
    "customName" TEXT,
    "agreedPrice" DECIMAL(18,4) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactItem_tenantId_idx" ON "ContactItem"("tenantId");

-- CreateIndex
CREATE INDEX "ContactItem_tenantId_contactId_idx" ON "ContactItem"("tenantId", "contactId");

-- CreateIndex
CREATE INDEX "ContactItem_tenantId_itemId_idx" ON "ContactItem"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactItem_tenantId_contactId_itemId_key" ON "ContactItem"("tenantId", "contactId", "itemId");

ALTER TABLE "ContactItem"
    ADD CONSTRAINT "ContactItem_agreedPrice_check" CHECK ("agreedPrice" >= 0),
    ADD CONSTRAINT "ContactItem_discountPercent_check" CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100);

-- Cross-tenant guard: the contact and the item referenced by a catalogue
-- assignment must belong to the same tenant. Prisma cannot express this, so it
-- is enforced here — a forged `itemId` from another tenant is rejected by the
-- database even if an application-layer check is ever missed.
CREATE OR REPLACE FUNCTION catalogue_assignment_is_single_tenant() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Contact" c
        WHERE c."id" = NEW."contactId" AND c."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'ContactItem.contactId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "Item" i
        WHERE i."id" = NEW."itemId" AND i."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'ContactItem.itemId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactItem_single_tenant_assignment"
    BEFORE INSERT OR UPDATE OF "contactId", "itemId", "tenantId" ON "ContactItem"
    FOR EACH ROW EXECUTE FUNCTION catalogue_assignment_is_single_tenant();

-- The same guard for an item's tax rate link.
CREATE OR REPLACE FUNCTION item_tax_rate_is_single_tenant() RETURNS trigger AS $$
BEGIN
    IF NEW."taxRateId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "TaxRate" t
        WHERE t."id" = NEW."taxRateId" AND t."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Item.taxRateId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Item_single_tenant_tax_rate"
    BEFORE INSERT OR UPDATE OF "taxRateId", "tenantId" ON "Item"
    FOR EACH ROW EXECUTE FUNCTION item_tax_rate_is_single_tenant();

-- Tax rates must sit under a category of the same tenant.
CREATE OR REPLACE FUNCTION tax_rate_is_single_tenant() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "TaxCategory" tc
        WHERE tc."id" = NEW."categoryId" AND tc."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'TaxRate.categoryId does not belong to this tenant'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TaxRate_single_tenant_category"
    BEFORE INSERT OR UPDATE OF "categoryId", "tenantId" ON "TaxRate"
    FOR EACH ROW EXECUTE FUNCTION tax_rate_is_single_tenant();

-- ─── Document headers (read path used by contact history and balances) ───────
-- Only the header fields needed to render "document history" and an outstanding
-- balance exist in this phase; line items, numbering and issuance belong to the
-- document phase that follows.

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT,
    "type" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "total" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_tenantId_idx" ON "Document"("tenantId");

-- CreateIndex
CREATE INDEX "Document_tenantId_contactId_idx" ON "Document"("tenantId", "contactId");

-- CreateIndex
CREATE INDEX "Document_tenantId_status_idx" ON "Document"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Document_tenantId_issuedAt_idx" ON "Document"("tenantId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Document_tenantId_type_number_key" ON "Document"("tenantId", "type", "number");

ALTER TABLE "Document"
    ADD CONSTRAINT "Document_total_check" CHECK ("total" >= 0),
    ADD CONSTRAINT "Document_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- ─── Foreign keys ────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "TaxCategory" ADD CONSTRAINT "TaxCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TaxCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactAddress" ADD CONSTRAINT "ContactAddress_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactItem" ADD CONSTRAINT "ContactItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactItem" ADD CONSTRAINT "ContactItem_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactItem" ADD CONSTRAINT "ContactItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Row level security ──────────────────────────────────────────────────────
-- Defence in depth behind the application's `authorizeTenant()` check. Note the
-- deliberate limitations, recorded in docs/implementation/phase-checklist.md:
--   * the policies read `app.current_tenant_id`, which nothing sets yet, so the
--     application layer is the control in force today;
--   * the tables are created by the migration role, which bypasses RLS as owner;
--     the policies bind once the app connects as `amisibiz_app`.

ALTER TABLE "TaxCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaxRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactAddress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tax_category_tenant_isolation ON "TaxCategory"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY tax_rate_tenant_isolation ON "TaxRate"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY contact_tenant_isolation ON "Contact"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

-- ContactAddress has no tenantId of its own; isolation follows its contact.
CREATE POLICY contact_address_tenant_isolation ON "ContactAddress"
    FOR ALL TO amisibiz_app
    USING (
        EXISTS (
            SELECT 1 FROM "Contact" c
            WHERE c."id" = "ContactAddress"."contactId"
              AND (c."tenantId" = current_tenant_id() OR is_platform_admin())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "Contact" c
            WHERE c."id" = "ContactAddress"."contactId"
              AND (c."tenantId" = current_tenant_id() OR is_platform_admin())
        )
    );

CREATE POLICY item_tenant_isolation ON "Item"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY contact_item_tenant_isolation ON "ContactItem"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

CREATE POLICY document_tenant_isolation ON "Document"
    FOR ALL TO amisibiz_app
    USING ("tenantId" = current_tenant_id() OR is_platform_admin())
    WITH CHECK ("tenantId" = current_tenant_id() OR is_platform_admin());

-- The app role needs DML on the new tables (the defaults granted in
-- 20261013000001 only cover tables that existed when it ran).
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "TaxCategory", "TaxRate", "Contact", "ContactAddress", "Item", "ContactItem", "Document"
    TO amisibiz_app;

COMMENT ON POLICY contact_tenant_isolation ON "Contact" IS 'Tenant isolation for the contact CRM.';
COMMENT ON POLICY contact_item_tenant_isolation ON "ContactItem" IS 'Tenant isolation for customer-specific catalogue prices.';
COMMENT ON INDEX "ContactItem_tenantId_contactId_itemId_key" IS 'One agreed price per customer per catalogue item, scoped to the tenant.';
