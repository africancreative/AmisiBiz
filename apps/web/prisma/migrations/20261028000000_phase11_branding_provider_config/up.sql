-- Migration: Phase 11 – Branding provider configuration fields
--
-- Adds per-tenant configuration fields that work with global admin provider
 * settings (Cloudinary, DPO, Mailtrap). These fields are stored in the
 * TenantBranding table and are sanitized, non-credential settings.
--
-- 1. Add new columns to the TenantBranding table
ALTER TABLE "TenantBranding"
  ADD COLUMN "cloudinaryPresetName" TEXT,       -- Cloudinary preset name per tenant
  ADD COLUMN "dpoIntegrationStatus" TEXT,       -- DPO integration status per tenant
  ADD COLUMN "mailtrapFromEmail" TEXT;          -- From email for tenant emails

-- 2. Update existing rows with default/null values (idempotent)
UPDATE "TenantBranding"
SET "cloudinaryPresetName" = NULL,
    "dpoIntegrationStatus" = NULL,
    "mailtrapFromEmail" = NULL;

-- 3. Update the RLS policies – the enhanced columns do not change access
--    (existing policies from Phase 09 remain in effect).

-- 4. Seed any tenant-specific preset names if applicable (idempotent)
--    These are left as NULL by default; populate via admin dashboard as needed.
REM: No default seed values – tenant-specific preset names are populated
--   individually through the admin dashboard or operator tooling.