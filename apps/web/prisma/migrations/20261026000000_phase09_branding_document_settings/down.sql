-- Migration: Phase 09 rollback – Provider-managed branding and document settings
--
-- Reverts the TenantBranding enhancements by removing the new columns
-- and resetting to the previous schema state.
--
-- 1. Drop RLS policies
DROP POLICY IF EXISTS "Platform admins can read all branding" ON "TenantBranding";
DROP POLICY IF EXISTS "Tenant owner can read own branding" ON "TenantBranding";

-- 2. Remove new columns from TenantBranding
ALTER TABLE "TenantBranding"
  DROP COLUMN IF EXISTS "invoiceTemplate",
  DROP COLUMN IF EXISTS "invoiceCustomizations",
  DROP COLUMN IF EXISTS "quotationTemplate",
  DROP COLUMN IF EXISTS "quotationCustomizations",
  DROP COLUMN IF EXISTS "deliveryNoteTemplate",
  DROP COLUMN IF EXISTS "deliveryNoteCustomizations",
  DROP COLUMN IF EXISTS "documentNumberingPrefix",
  DROP COLUMN IF EXISTS "documentNumberingPadding",
  DROP COLUMN IF EXISTS "documentPeriodStyle",
  DROP COLUMN IF EXISTS "fiscalStartMonth",
  DROP COLUMN IF EXISTS "etimsCompatible",
  DROP COLUMN IF EXISTS "etimsDocumentType",
  DROP COLUMN IF EXISTS "etimsSerialNumber",
  DROP COLUMN IF EXISTS "etimsLastSync";

-- 3. Seed original TenantBranding entries (in case they were modified)
INSERT INTO "TenantBranding" ("tenantId", "displayName", "registeredName", "primaryColor", "secondaryColor", "accentColor", "primaryForeground", "logoUrl", "contactEmail", "contactPhone", "postalAddress", "physicalAddress", "website", "taxPin", "currency", "defaultFooter", "paymentInstructions", "documentLayout")
SELECT
  "id",
  null,
  null,
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
  'standard'
FROM "Tenant"
ON CONFLICT ("tenantId") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "registeredName" = EXCLUDED."registeredName",
  "primaryColor" = EXCLUDED."primaryColor",
  "secondaryColor" = EXCLUDED."secondaryColor",
  "accentColor" = EXCLUDED."accentColor",
  "primaryForeground" = EXCLUDED."primaryForeground",
  "logoUrl" = EXCLUDED."logoUrl",
  "contactEmail" = EXCLUDED."contactEmail",
  "contactPhone" = EXCLUDED."contactPhone",
  "postalAddress" = EXCLUDED."postalAddress",
  "physicalAddress" = EXCLUDED."physicalAddress",
  "website" = EXCLUDED."website",
  "taxPin" = EXCLUDED."taxPin",
  "currency" = EXCLUDED."currency",
  "defaultFooter" = EXCLUDED."defaultFooter",
  "paymentInstructions" = EXCLUDED."paymentInstructions",
  "documentLayout" = EXCLUDED."documentLayout";