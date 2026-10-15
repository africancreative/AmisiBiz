-- Migration: Phase 10 rollback – Audit log integrity and platform user management
--
-- Reverts the AuditLog enhancements and removes RLS policies.
--
-- 1. Drop RLS policies
DROP POLICY IF EXISTS "SUPER_ADMIN full audit access" ON "AuditLog";
DROP POLICY IF EXISTS "Tenant owner read-only audit access" ON "AuditLog";

-- 2. Remove new columns from AuditLog
ALTER TABLE "AuditLog"
  DROP COLUMN IF EXISTS "outcome",
  DROP COLUMN IF EXISTS "outcomeDetails",
  DROP COLUMN IF EXISTS "correlationId",
  DROP COLUMN IF EXISTS "resourceType";

-- 3. Restore original AuditLog data (keep existing data, just remove new columns)
--    The original columns (id, tenantId, userId, action, resource, ipAddress,
--    userAgent, createdAt) are preserved. The new columns are dropped.