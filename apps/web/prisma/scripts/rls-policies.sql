-- RLS Policies for AmisiBiz
-- This file contains the complete RLS policy definitions
-- Run this AFTER the schema migration and app role setup
--
-- Keep in sync with the migration chain (`prisma/migrations/*/migration.sql`),
-- which is the path used by `prisma migrate deploy`; this file exists for
-- manual/DBA application on an existing database.
--
-- Column identifiers are quoted camelCase because `prisma/schema.prisma` creates
-- them with no `@map` — `tenant_id` / `user_id` do not exist.

-- =============================================================================
-- RLS Helper Functions (must exist before policies)
-- =============================================================================

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

-- =============================================================================
-- Enable RLS on all tenant-scoped tables
-- =============================================================================
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantBranding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantDomain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountToken" ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- Tenant Table Policies
-- =============================================================================

-- Platform admins can read all tenants
CREATE POLICY tenant_platform_admin_select ON "Tenant"
    FOR SELECT TO amisibiz_app
    USING (is_platform_admin());

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

-- =============================================================================
-- TenantSettings Table Policies
-- =============================================================================
CREATE POLICY tenant_settings_tenant_isolation ON "TenantSettings"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- =============================================================================
-- TenantBranding Table Policies
-- =============================================================================
CREATE POLICY tenant_branding_tenant_isolation ON "TenantBranding"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- =============================================================================
-- TenantDomain Table Policies
-- =============================================================================
CREATE POLICY tenant_domain_tenant_isolation ON "TenantDomain"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- =============================================================================
-- TenantMember Table Policies
-- =============================================================================

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

-- =============================================================================
-- Invitation Table Policies
-- =============================================================================
CREATE POLICY invitation_tenant_isolation ON "Invitation"
    FOR ALL TO amisibiz_app
    USING (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    )
    WITH CHECK (
        "tenantId" = current_tenant_id() OR is_platform_admin()
    );

-- =============================================================================
-- AuditLog Table Policies
-- =============================================================================

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

-- =============================================================================
-- User Table Policies
-- =============================================================================

-- Platform admins can read all users
CREATE POLICY user_platform_admin_select ON "User"
    FOR SELECT TO amisibiz_app
    USING (is_platform_admin());

-- Users can read their own profile
CREATE POLICY user_self_select ON "User"
    FOR SELECT TO amisibiz_app
    USING (id = current_user_id());

-- =============================================================================
-- Auth Tables Policies
-- =============================================================================

-- Account: users can manage their own accounts, platform admins all
CREATE POLICY account_self_access ON "Account"
    FOR ALL TO amisibiz_app
    USING ("userId" = current_user_id() OR is_platform_admin())
    WITH CHECK ("userId" = current_user_id() OR is_platform_admin());

-- Session: users can manage their own sessions, platform admins all
CREATE POLICY session_self_access ON "Session"
    FOR ALL TO amisibiz_app
    USING ("userId" = current_user_id() OR is_platform_admin())
    WITH CHECK ("userId" = current_user_id() OR is_platform_admin());

-- AccountToken: users can manage their own tokens, platform admins all
CREATE POLICY account_token_self_access ON "AccountToken"
    FOR ALL TO amisibiz_app
    USING ("userId" = current_user_id() OR is_platform_admin())
    WITH CHECK ("userId" = current_user_id() OR is_platform_admin());

-- =============================================================================
-- Phase 04: branding already covered above; contacts, tax configuration,
-- catalogue, customer-specific catalogue and document headers.
-- Mirrors section "Row level security" of
-- prisma/migrations/20261014000000_phase04_branding_contacts_and_catalogue.
-- =============================================================================

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

GRANT SELECT, INSERT, UPDATE, DELETE ON
    "TaxCategory", "TaxRate", "Contact", "ContactAddress", "Item", "ContactItem", "Document"
    TO amisibiz_app;

-- =============================================================================
-- Grant execute on helper functions to app role
-- =============================================================================
GRANT EXECUTE ON FUNCTION current_tenant_id() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION current_user_id() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION is_platform_admin() TO amisibiz_app;

-- =============================================================================
-- Session Context Management Functions
-- =============================================================================

-- Set tenant context for the current request.
--
-- The third argument to set_config() is `true`: the setting is TRANSACTION
-- LOCAL, so it disappears when the request's transaction ends. Passing `false`
-- would make it session-scoped, and a pooled/pgBouncer connection would then
-- carry one tenant's context into the next request — a cross-tenant read that no
-- application-side check would explain. Callers must therefore wrap the request
-- work in a transaction: BEGIN; SELECT set_tenant_context(...); ...; COMMIT.
CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id text, p_user_id text, p_is_platform_admin boolean DEFAULT false)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id', p_tenant_id, true);
    PERFORM set_config('app.current_user_id', p_user_id, true);
    PERFORM set_config('app.is_platform_admin', p_is_platform_admin::text, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION set_tenant_context(text, text, boolean) TO amisibiz_app;

-- Clear tenant context. Session scope (`false`) is correct here: this exists to
-- scrub a physical connection before it goes back to the pool.
CREATE OR REPLACE FUNCTION clear_tenant_context()
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id', '', false);
    PERFORM set_config('app.current_user_id', '', false);
    PERFORM set_config('app.is_platform_admin', 'false', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION clear_tenant_context() TO amisibiz_app;

-- =============================================================================
-- Verify all policies are created
-- =============================================================================
DO $$
DECLARE
    pol record;
BEGIN
    RAISE NOTICE 'Created policies:';
    FOR pol IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
        ORDER BY tablename, policyname
    LOOP
        RAISE NOTICE '  %.%.%', pol.schemaname, pol.tablename, pol.policyname;
    END LOOP;
END
$$;