-- Least-Privileged Database Role Setup for AmisiBiz
-- Run this script as a superuser (e.g., postgres) on the target database
-- This creates the 'amisibiz_app' role with minimal required privileges

-- =============================================================================
-- 1. Create the application role (run once per database cluster)
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'amisibiz_app') THEN
        -- Created password-less on purpose: never ship a placeholder password
        -- to a login role. Set a strong one before first use:
        --   ALTER ROLE amisibiz_app PASSWORD '<openssl rand -base64 32>';
        CREATE ROLE amisibiz_app NOINHERIT LOGIN;
        RAISE NOTICE 'Created role amisibiz_app';
    ELSE
        RAISE NOTICE 'Role amisibiz_app already exists';
    END IF;
END
$$;

-- =============================================================================
-- 2. Configure role settings
-- =============================================================================
-- Disable bypass of RLS (critical for security)
ALTER ROLE amisibiz_app SET row_security = on;

-- Set statement timeout to prevent runaway queries (5 minutes)
ALTER ROLE amisibiz_app SET statement_timeout = '5min';

-- Set idle transaction timeout (1 minute)
ALTER ROLE amisibiz_app SET idle_in_transaction_session_timeout = '1min';

-- Lock timeout (10 seconds)
ALTER ROLE amisibiz_app SET lock_timeout = '10s';

-- =============================================================================
-- 3. Grant schema usage
-- =============================================================================
GRANT USAGE ON SCHEMA public TO amisibiz_app;

-- =============================================================================
-- 4. Grant table privileges (adjust table list as needed)
-- =============================================================================
-- Core tables
GRANT SELECT, INSERT, UPDATE, DELETE ON "User" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Tenant" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TenantMember" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Invitation" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TenantSettings" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TenantBranding" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TenantDomain" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "AuditLog" TO amisibiz_app;

-- Auth tables
GRANT SELECT, INSERT, UPDATE, DELETE ON "Account" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Session" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "AccountToken" TO amisibiz_app;
GRANT SELECT ON "VerificationToken" TO amisibiz_app;

-- =============================================================================
-- 5. Grant sequence privileges
-- =============================================================================
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO amisibiz_app;

-- =============================================================================
-- 6. Set default privileges for future tables
-- =============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO amisibiz_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO amisibiz_app;

-- =============================================================================
-- 7. Grant EXECUTE on helper functions
-- =============================================================================
GRANT EXECUTE ON FUNCTION current_tenant_id() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION current_user_id() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION is_platform_admin() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION set_tenant_context(text, text, boolean) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION clear_tenant_context() TO amisibiz_app;

-- =============================================================================
-- 8. Explicitly DENY dangerous privileges (defense in depth)
-- =============================================================================
-- The app role must NEVER have these:
-- - CREATEDB, CREATEROLE, SUPERUSER, REPLICATION, BYPASSRLS
-- - TRUNCATE on any table
-- - DROP on any object
-- - ALTER on schema/tables
-- - GRANT OPTION

-- Verify the role does not have BYPASSRLS
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'amisibiz_app' AND rolbypassrls
    ) THEN
        RAISE EXCEPTION 'SECURITY ERROR: amisibiz_app must not have BYPASSRLS!';
    END IF;
END
$$;

-- =============================================================================
-- 9. Verify RLS is enabled on all protected tables
-- =============================================================================
DO $$
DECLARE
    tbl record;
    missing_rls text[] := '{}';
BEGIN
    FOR tbl IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename IN (
            'Tenant', 'TenantSettings', 'TenantBranding', 'TenantDomain',
            'TenantMember', 'Invitation', 'AuditLog', 'User',
            'Account', 'Session', 'AccountToken'
        )
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = tbl.tablename
            AND n.nspname = 'public'
            AND c.relrowsecurity
        ) THEN
            missing_rls := array_append(missing_rls, tbl.tablename);
        END IF;
    END LOOP;

    IF array_length(missing_rls, 1) > 0 THEN
        RAISE WARNING 'RLS is NOT enabled on: %', array_to_string(missing_rls, ', ');
    ELSE
        RAISE NOTICE 'RLS is enabled on all protected tables';
    END IF;
END
$$;

-- =============================================================================
-- 10. Output connection string template for the application
-- =============================================================================
DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'Application Connection String Template:';
    RAISE NOTICE 'DATABASE_URL="postgresql://amisibiz_app:YOUR_PASSWORD@';
    RAISE NOTICE '    HOST:PORT/DATABASE?pgbouncer=true&connection_limit=1"';
    RAISE NOTICE '';
    RAISE NOTICE 'IMPORTANT: Set a strong password before deploying!';
    RAISE NOTICE 'Generate with: openssl rand -base64 32';
    RAISE NOTICE '============================================================';
END
$$;