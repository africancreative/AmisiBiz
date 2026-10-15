-- Migration: Phase 11 rollback – Branding provider configuration fields
--
-- Reverts the TenantBranding enhancements by removing the new columns.
--
-- 1. Remove new columns from TenantBranding
ALTER TABLE "TenantBranding"
  DROP COLUMN IF EXISTS "cloudinaryPresetName",
  DROP COLUMN IF EXISTS "dpoIntegrationStatus",
  DROP COLUMN IF EXISTS "mailtrapFromEmail";

-- 2. Restore original TenantBranding entries (in case they were modified)
--    The original columns are preserved; only the new columns are dropped.
INSERT INTO "TenantBranding" ("tenantId", "displayName", "registeredName", "primaryColor", "secondaryColor", "accentColor", "primaryForeground", "logoUrl", "contactEmail", "contactPhone", "postalAddress", "physicalAddress", "website", "taxPin", "currency", "defaultFooter", "documentLayout", "invoiceTemplate", "quotationTemplate", "deliveryNoteTemplate", "documentNumberingPrefix", "documentNumberingPadding", "documentPeriodStyle", "fiscalStartMonth", "etimsCompatible", "etimsDocumentType", "etimsSerialNumber", "etimsLastSync")
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