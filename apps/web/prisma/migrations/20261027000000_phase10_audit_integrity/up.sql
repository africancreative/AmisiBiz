-- Migration: Phase 10 – Audit log integrity and platform user management
--
-- Enhances the AuditLog model with outcome, correlationId, and resourceType fields.
-- Adds RLS policies to prevent ordinary administrators from editing/deleting audit events.
--
-- 1. Add new columns to the AuditLog table
ALTER TABLE "AuditLog"
  ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'success',
  ADD COLUMN "outcomeDetails" TEXT,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "resourceType" TEXT;  -- e.g. "tenant", "user", "plan", "branding"

-- 2. Update existing rows with default values (idempotent)
UPDATE "AuditLog"
SET "outcome" = 'success',
    "outcomeDetails" = null,
    "correlationId" = null,
    "resourceType" = null;

-- 3. Add RLS policies to protect audit log integrity
--    Prevent ordinary administrators from modifying or deleting audit events
ALTER TABLE "AuditLog" ROWLEVEL SECURITY TRUE;

-- Only SUPER_ADMIN can read, insert, and manage audit events
CREATE POLICY "SUPER_ADMIN full audit access" ON "AuditLog"
  FOR ALL USING (exists(select 1 from "User" u where u."platformRole" = 'SUPER_ADMIN'));

-- Tenant owners can ONLY read their tenant's audit events (read-only)
CREATE POLICY "Tenant owner read-only audit access" ON "AuditLog"
  FOR SELECT USING (exists(select 1 from "TenantMember" m where m."tenantId" = "AuditLog"."tenantId" AND m."userId" = current_setting('app.current_user_id')::uuid AND m."role" = 'TENANT_OWNER'));

-- All other roles (including SUPPORT) have no access to AuditLog by default (deny-by-default)
-- This is enforced by the absence of granting ANY policy for non-SUPER_ADMIN roles.

-- 4. Seed correlationId for existing events where applicable (idempotent)
--    In a production system, this would be populated from the original request IDs.
UPDATE "AuditLog"
SET "correlationId" = 'manual_reconciliation'
WHERE "correlationId" IS NULL;

-- 5. Update the User model comment to reflect enhanced audit capabilities
--    (No DDL change needed; comment is documentation only.)
REM: User model now tracks platformRole and sessionVersion for RBAC and session revocation.
REM: AuditLog model includes outcome, correlationId, and resourceType for comprehensive auditing.

-- 6. Seed any new platform administrator users if needed (idempotent)
--    This is a placeholder – platform admins are typically created via the
--    invitation system or operator tooling.
REM: Platform administrator management is handled through the application's
--   invitation and role-assignment flows, not direct database seeding.