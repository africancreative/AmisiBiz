-- Migration: Add RLS policies, partial unique index, invitation token hashing, and least-privileged role
-- Created: 2026-10-13
-- Phase 02 Security Hardening
--
-- NOTE (Phase 04 review, 2026-10-14): this file had never been applied to any
-- database. Its policies referenced `tenant_id` / `user_id`, but the tables come
-- from `prisma/schema.prisma`, which creates camelCase columns ("tenantId",
-- "userId") with no `@map`, so applying it would fail on the first policy with
-- `column "tenant_id" does not exist`. The predicates now use the quoted
-- camelCase identifiers the init migration actually creates. `pgcrypto` is
-- enabled because the invitation-token backfill below calls `digest()`.

-- pgcrypto: required by digest() in the Invitation token backfill (section 14).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Enable RLS on all tenant-scoped tables
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantBranding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantDomain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;

-- 2. Create the application database role (least-privileged)
-- Deliberately password-less: a migration must never carry a credential, and a
-- well-known placeholder password on a production login role is a security
-- hole (rules 8/9). The role cannot be password-authenticated into until RLS
-- activation (Phase 08) sets a strong one out-of-band:
--   ALTER ROLE amisibiz_app PASSWORD '<openssl rand -base64 32>';
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'amisibiz_app') THEN
        CREATE ROLE amisibiz_app NOINHERIT LOGIN;
    END IF;
END
$$;

-- Grant minimal required privileges to the app role
GRANT USAGE ON SCHEMA public TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO amisibiz_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO amisibiz_app;

-- Ensure future tables also get grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO amisibiz_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO amisibiz_app;

-- 3. Create RLS helper functions

-- Get current tenant_id from session variable (set by application per request)
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text AS $$
    SELECT current_setting('app.current_tenant_id', true);
$$ LANGUAGE sql STABLE;

-- Get current user_id from session variable (set by application per request)
CREATE OR REPLACE FUNCTION current_user_id() RETURNS text AS $$
    SELECT current_setting('app.current_user_id', true);
$$ LANGUAGE sql STABLE;

-- Check if current user is a platform admin
CREATE OR REPLACE FUNCTION is_platform_admin() RETURNS boolean AS $$
    SELECT COALESCE(current_setting('app.is_platform_admin', true), 'false')::boolean;
$$ LANGUAGE sql STABLE;

-- 4. RLS Policies for Tenant table
-- Platform admins can read all tenants
CREATE POLICY tenant_platform_admin_select ON "Tenant"
    FOR SELECT TO amisibiz_app
    USING (is_platform_admin());

-- Platform admins can insert/update/delete tenants (via service role bypass)
-- Application enforces authorization before calling these operations

-- Tenant members can read their own tenant
CREATE POLICY tenant_member_select ON "Tenant"
    FOR SELECT TO amisibiz_app
    USING (
        id = current_tenant_id() AND
        EXISTS (
            SELECT 1 FROM "TenantMember" tm
            WHERE tm."tenantId" = "Tenant".id
            AND tm."userId" = current_user_id()
        )
    );

-- 5. RLS Policies for TenantSettings
CREATE POLICY tenant_settings_tenant_isolation ON "TenantSettings"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- 6. RLS Policies for TenantBranding
CREATE POLICY tenant_branding_tenant_isolation ON "TenantBranding"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- 7. RLS Policies for TenantDomain
CREATE POLICY tenant_domain_tenant_isolation ON "TenantDomain"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- 8. RLS Policies for TenantMember
-- Users can read members of their own tenant
CREATE POLICY tenant_member_tenant_isolation ON "TenantMember"
    FOR SELECT TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- Platform admins can manage all memberships
CREATE POLICY tenant_member_platform_admin_all ON "TenantMember"
    FOR ALL TO amisibiz_app
    USING (is_platform_admin())
    WITH CHECK (is_platform_admin());

-- Users can update their own membership (e.g., isDefault) within their tenant
CREATE POLICY tenant_member_self_update ON "TenantMember"
    FOR UPDATE TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() AND
        "userId" = current_user_id()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() AND
        "userId" = current_user_id()
    );

-- 9. RLS Policies for Invitation
CREATE POLICY invitation_tenant_isolation ON "Invitation"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- 10. RLS Policies for AuditLog
-- Users can read audit logs for their tenant
CREATE POLICY audit_log_tenant_read ON "AuditLog"
    FOR SELECT TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- Platform admins can read all audit logs (including system-level null tenant_id)
CREATE POLICY audit_log_platform_admin_read ON "AuditLog"
    FOR SELECT TO amisibiz_app
    USING (is_platform_admin());

-- Application inserts audit logs (no tenant isolation needed for insert)
CREATE POLICY audit_log_insert ON "AuditLog"
    FOR INSERT TO amisibiz_app
    WITH CHECK (true);

-- 11. RLS Policies for User table
-- Platform admins can read all users
CREATE POLICY user_platform_admin_select ON "User"
    FOR SELECT TO amisibiz_app
    USING (is_platform_admin());

-- Users can read their own profile
CREATE POLICY user_self_select ON "User"
    FOR SELECT TO amisibiz_app
    USING (id = current_user_id());

-- 12. RLS Policies for Account, Session, VerificationToken, AccountToken
-- These are auth tables - only accessible by user themselves or platform admin
CREATE POLICY account_self_access ON "Account"
    FOR ALL TO amisibiz_app
    USING ("userId" = current_user_id() OR is_platform_admin())
    WITH CHECK ("userId" = current_user_id() OR is_platform_admin());

CREATE POLICY session_self_access ON "Session"
    FOR ALL TO amisibiz_app
    USING ("userId" = current_user_id() OR is_platform_admin())
    WITH CHECK ("userId" = current_user_id() OR is_platform_admin());

CREATE POLICY account_token_self_access ON "AccountToken"
    FOR ALL TO amisibiz_app
    USING ("userId" = current_user_id() OR is_platform_admin())
    WITH CHECK ("userId" = current_user_id() OR is_platform_admin());

-- 13. Add partial unique index for default tenant membership (R5b)
-- Ensures only one default tenant per user
CREATE UNIQUE INDEX "TenantMember_userId_isDefault_partial"
ON "TenantMember" ("userId")
WHERE "isDefault" = true;

-- 14. Migrate Invitation tokens to hash-at-rest (R8)
-- Add tokenHash column and migrate existing tokens
ALTER TABLE "Invitation" ADD COLUMN "tokenHash" TEXT;

-- Create index for tokenHash lookups
CREATE INDEX "Invitation_tokenHash_idx" ON "Invitation"("tokenHash");

-- Backfill tokenHash from existing token values (SHA-256)
UPDATE "Invitation" SET "tokenHash" = encode(digest("token", 'sha256'), 'hex')
WHERE "tokenHash" IS NULL;

-- Make tokenHash NOT NULL and add unique constraint
ALTER TABLE "Invitation" ALTER COLUMN "tokenHash" SET NOT NULL;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tokenHash_key" UNIQUE ("tokenHash");

-- Drop the old token column (no longer storing raw tokens)
ALTER TABLE "Invitation" DROP COLUMN "token";

-- 15. Add sessionVersion to Prisma schema is already present
-- Ensure sessionVersion index exists for efficient revocation queries
CREATE INDEX "User_sessionVersion_idx" ON "User"("sessionVersion");

-- 16. Grant explicit permissions to app role for new columns/indexes
GRANT SELECT, INSERT, UPDATE ON "Invitation" TO amisibiz_app;
GRANT SELECT ON "User" TO amisibiz_app;
GRANT SELECT ON "TenantMember" TO amisibiz_app;

-- 17. Create a helper function for the application to set tenant context
-- The settings are TRANSACTION LOCAL (third argument `true`): a pooled
-- connection must never carry one tenant's context into the next request.
CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id text, p_user_id text, p_is_platform_admin boolean DEFAULT false)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id', p_tenant_id, true);
    PERFORM set_config('app.current_user_id', p_user_id, true);
    PERFORM set_config('app.is_platform_admin', p_is_platform_admin::text, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION set_tenant_context(text, text, boolean) TO amisibiz_app;

-- 18. Create a helper to clear tenant context
CREATE OR REPLACE FUNCTION clear_tenant_context()
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id', '', false);
    PERFORM set_config('app.current_user_id', '', false);
    PERFORM set_config('app.is_platform_admin', 'false', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION clear_tenant_context() TO amisibiz_app;

-- 19. Comment on security model
COMMENT ON FUNCTION current_tenant_id() IS 'Returns the tenant_id set for the current request. Used by RLS policies for tenant isolation.';
COMMENT ON FUNCTION current_user_id() IS 'Returns the user_id set for the current request. Used by RLS policies for user isolation.';
COMMENT ON FUNCTION is_platform_admin() IS 'Returns true if the current request is from a platform admin. Used by RLS policies for platform access.';
COMMENT ON FUNCTION set_tenant_context(text, text, boolean) IS 'Sets the RLS session variables for the current request. Must be called with LOCAL transaction scope.';
COMMENT ON POLICY tenant_member_tenant_isolation ON "TenantMember" IS 'Enforces tenant isolation: users can only see members of their own tenant.';
COMMENT ON POLICY tenant_settings_tenant_isolation ON "TenantSettings" IS 'Enforces tenant isolation for settings.';
COMMENT ON POLICY tenant_branding_tenant_isolation ON "TenantBranding" IS 'Enforces tenant isolation for branding.';
COMMENT ON POLICY tenant_domain_tenant_isolation ON "TenantDomain" IS 'Enforces tenant isolation for domains.';
COMMENT ON POLICY invitation_tenant_isolation ON "Invitation" IS 'Enforces tenant isolation for invitations.';
COMMENT ON POLICY audit_log_tenant_read ON "AuditLog" IS 'Users can read audit logs for their tenant.';