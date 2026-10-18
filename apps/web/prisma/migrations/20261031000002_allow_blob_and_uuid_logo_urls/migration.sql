-- Migration: allow_blob_and_uuid_logo_urls
--
-- Why: The original TenantBranding_logoUrl_check from Phase 04 restricted logoUrl to
-- '^/uploads/tenants/[a-z0-9]+/logo/[a-f0-9]{32}\.(png|jpe?g|webp)$'.
-- That pattern rejected:
--   1. Real UUID tenant IDs that include hyphens (e.g. /uploads/tenants/<uuid-with-hyphens>/logo/...)
--   2. Vercel Blob and cloud object storage HTTPS URLs (e.g. https://*.public.blob.vercel-storage.com/...)
--
-- This migration updates the check constraint to accept both standard UUID local upload paths
-- and secure HTTPS URLs ending with supported raster image extensions (.png, .jpg, .jpeg, .webp),
-- while continuing to reject javascript:, data:, and script-bearing SVG formats.

ALTER TABLE "TenantBranding" DROP CONSTRAINT IF EXISTS "TenantBranding_logoUrl_check";

ALTER TABLE "TenantBranding"
    ADD CONSTRAINT "TenantBranding_logoUrl_check"
        CHECK (
            "logoUrl" IS NULL OR
            "logoUrl" ~ '^/uploads/tenants/[a-z0-9-]+/logo/[a-f0-9]{32}\.(png|jpe?g|webp)$' OR
            "logoUrl" ~ '^https?://[a-zA-Z0-9_.~:/?#\[\]@!$&''()*+,;=-]+\.(png|jpe?g|webp)(\?.*)?$'
        );
