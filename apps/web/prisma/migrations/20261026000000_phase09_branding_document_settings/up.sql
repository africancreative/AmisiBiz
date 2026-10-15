-- Migration: Phase 09 – Provider-managed branding and document settings
--
-- Enhances the TenantBranding model with additional template settings,
-- eTIMS compatibility fields, and extended configuration options.
--
-- 1. Add new columns to the TenantBranding table
ALTER TABLE "TenantBranding"
  ADD COLUMN "invoiceTemplate" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "invoiceCustomizations" JSONB,
  ADD COLUMN "quotationTemplate" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "quotationCustomizations" JSONB,
  ADD COLUMN "deliveryNoteTemplate" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "deliveryNoteCustomizations" JSONB,
  ADD COLUMN "documentNumberingPrefix" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "documentNumberingPadding" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "documentPeriodStyle" TEXT NOT NULL DEFAULT 'CALENDAR_YEAR',
  ADD COLUMN "fiscalStartMonth" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "etimsCompatible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "etimsDocumentType" TEXT,
  ADD COLUMN "etimsSerialNumber" TEXT,
  ADD COLUMN "etimsLastSync" TIMESTAMP WITH TIME ZONE;

-- 2. Update existing rows to preserve data (idempotent — new columns have defaults)
--    No data loss occurs since all new columns have DEFAULT values.

-- 3. Update the Plan table comment to reflect the new architecture
--    (No DDL change needed; comment is documentation only.)
REM: Plan model remains the provider catalogue; branding lives on TenantBranding.

-- 4. Add RLS policies for the enhanced TenantBranding table
ALTER TABLE "TenantBranding" ROWLEVEL SECURITY TRUE;
-- Platform admins can read all branding configs
CREATE POLICY "Platform admins can read all branding" ON "TenantBranding"
  FOR SELECT USING (exists(select 1 from "User" u where u."platformRole" = 'SUPER_ADMIN'));
-- Tenant owners can read their own branding
CREATE POLICY "Tenant owner can read own branding" ON "TenantBranding"
  FOR SELECT USING (exists(select 1 from "TenantMember" m where m."tenantId" = "TenantBranding"."tenantId" AND m."userId" = current_setting('app.current_user_id')::uuid AND m."role" = 'TENANT_OWNER'));

-- 5. Seed any missing plan/template defaults (idempotent)
--    These values correspond to the original Phase 1 branding configuration.
INSERT INTO "TenantBranding" ("tenantId", "displayName", "registeredName", "primaryColor", "secondaryColor", "accentColor", "primaryForeground", "logoUrl", "contactEmail", "contactPhone", "postalAddress", "physicalAddress", "website", "taxPin", "currency", "defaultFooter", "documentLayout", "invoiceTemplate", "quotationTemplate", "deliveryNoteTemplate", "documentNumberingPrefix", "documentNumberingPadding", "documentPeriodStyle", "fiscalStartMonth", "etimsCompatible", "etimsDocumentType", "etimsSerialNumber", "etimsLastSync")
SELECT
  t."id",
  null, -- displayName set on tenant creation
  null, -- registeredName
  '#1d4ed8',
  '#1e3a5f',
  '#f59e0b',
  '#f8fafc',
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  'KES',
  null,
  'standard',
  'standard',
  'standard',
  '',
  4,
  'CALENDAR_YEAR',
  1,
  false,
  null,
  null,
  null
FROM "Tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "TenantBranding" b WHERE b."tenantId" = t."id"
);