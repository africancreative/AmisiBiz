-- ============================================================================
-- AmisiBiz application role — operator setup and verification
-- ============================================================================
-- Phase 1 (2026-10) changed what this file is FOR. Read the whole header before
-- running anything.
--
-- Ownership of privileges moved into the migrations:
--   * 20261013000001 creates the role itself, password-less on purpose
--     (`CREATE ROLE amisibiz_app NOINHERIT LOGIN;`) — a login role must never be
--     shipped with a placeholder password.
--   * 20261018000002 is the authoritative grant statement: it stops the old
--     default-privilege river, REVOKES `amisibiz_app` everywhere, then grants
--     per AmisiBiz table exactly, and grants EXECUTE on exactly the policy
--     helpers.
--
-- This script therefore GRANTS NOTHING. An earlier version of it did — with a
-- pre-Phase-1 table list and `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES`,
-- which would have re-opened the very river migration 20261018000002 closes:
-- every table created afterwards (including tables belonging to any other
-- application sharing the project) would have become writable by the runtime
-- role without a migration ever reviewing it. Running the old script after the
-- migrations silently un-certified them.
--
-- What is left here is the part no migration can do: give the role a password
-- out of band, then prove the least-privilege end state actually holds.
--
-- Run as a superuser (Supabase dashboard SQL editor, or `psql` as `postgres`).
-- ============================================================================

-- ─── 1. Set the password — the operator step ────────────────────────────────
-- Do this from a secret manager, not from a file that gets committed. Generate
-- one with:  openssl rand -base64 32
-- Then paste it into the connection string as APP_DATABASE_URL (see
-- apps/web/.env.example and docs/RUNBOOK.md):
--
--   ALTER ROLE amisibiz_app PASSWORD '<the-generated-secret>';
--
-- Until a password is set, no application can connect as this role, so
-- `APP_DATABASE_URL` cannot be published, and RLS stays inert: with only
-- `DATABASE_URL` available the app would boot as the owner role, which bypasses
-- every policy. Production refuses that combination outright
-- (packages/database/src/client.ts).

-- ─── 2. Role attributes: no superuser, no bypass, no creation rights ────────
DO $$
DECLARE
    attrs text;
BEGIN
    SELECT rolSUPERUSER || '/' || rolBYPASSRLS || '/' || rolCREATEROLE || '/'
               || rolCREATEDB || '/' || rolLOGIN || '/' || rolInherit
      INTO attrs
      FROM pg_catalog.pg_roles
     WHERE rolname = 'amisibiz_app';

    IF attrs IS NULL THEN
        RAISE EXCEPTION
          'SECURITY ERROR: role amisibiz_app does not exist. Apply migration 20261013000001 first.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'amisibiz_app'
           AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit)
    ) THEN
        RAISE EXCEPTION
          'SECURITY ERROR: amisibiz_app must not be superuser/BYPASSRLS/createrole/createdb, and must be NOINHERIT. Found super/bypass/createrole/createdb/login/inherit = %',
          attrs;
    END IF;

    RAISE NOTICE 'Role attributes are correct (no superuser, no BYPASSRLS, NOINHERIT, LOGIN).';
END
$$;

-- ─── 3. Session defaults the policies depend on ─────────────────────────────
-- `row_security = on` is belt-and-braces: a role without BYPASSRLS is filtered
-- anyway, but a session default makes the intent visible in `pg_db_role_setting`.
ALTER ROLE amisibiz_app SET row_security = on;
ALTER ROLE amisibiz_app SET statement_timeout = '5min';
ALTER ROLE amisibiz_app SET idle_in_transaction_session_timeout = '1min';
ALTER ROLE amisibiz_app SET lock_timeout = '10s';

-- ─── 4. No ambient privileges outside the granted set ───────────────────────
-- The runtime role may not create anything anywhere: not schemas, not types,
-- not extensions. Migration 20261018000002 grants USAGE on `public` and nothing
-- else, so a `CREATE` right here would be drift from an out-of-band GRANT.
DO $$
BEGIN
    IF has_schema_privilege('amisibiz_app', 'public', 'CREATE') THEN
        RAISE EXCEPTION
          'SECURITY ERROR: amisibiz_app holds CREATE on schema public. The runtime role is a data role only.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roledep d
          JOIN pg_catalog.pg_authid a ON a.oid = d.dependsOnRole
         WHERE d.dependentRoleid = (SELECT oid FROM pg_roles WHERE rolname = 'amisibiz_app')
    ) THEN
        RAISE WARNING 'amisibiz_app is a member of another role. The runtime role should stand alone (NOINHERIT alone is not enough if membership is later made inheritable).';
    END IF;

    RAISE NOTICE 'No schema CREATE privilege. Runtime role privileges are table- and function-scoped.';
END
$$;

-- ─── 5. Default privileges must stay closed ────────────────────────────────
-- This is the check that makes the §1 warning concrete: if a river is flowing,
-- the next migration's table is pre-granted and nobody reviewed it.
DO $$
DECLARE
    n int;
BEGIN
    SELECT count(*) INTO n
      FROM pg_catalog.pg_default_acl da
      JOIN pg_catalog.pg_namespace ns ON ns.oid = da.defaclnamespace
     WHERE ns.nspname = 'public'
       AND array_to_string(da.defaclacl, ',') LIKE '%amisibiz_app%';

    IF n > 0 THEN
        RAISE EXCEPTION
          'SECURITY ERROR: % default-privilege entry/entries still reference amisibiz_app. Migration 20261018000002 revoked them; something re-opened the river.',
          n;
    END IF;

    RAISE NOTICE 'No default privileges for amisibiz_app — future tables start with zero access.';
END
$$;

-- ─── 6. Table privileges mirror the migration exactly ──────────────────────
DO $$
DECLARE
    unexpected text;
BEGIN
    SELECT string_agg(priv, ', ' ORDER BY priv) INTO unexpected
      FROM (
        SELECT c.relname || ':' || a.privilege_type AS priv
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
         WHERE ns.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'amisibiz_app')
           AND a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER')
      ) drift;

    IF unexpected IS NOT NULL THEN
        RAISE EXCEPTION 'SECURITY ERROR: unexpected table privileges for amisibiz_app: %', unexpected;
    END IF;

    RAISE NOTICE 'Table privileges are limited to the DML verbs the migrations grant.';
END
$$;

-- ─── 7. RLS is on, and forced where it must be ─────────────────────────────
-- `relrowsecurity` covers the app role (which has no BYPASSRLS and is not the
-- owner). `relforcerowsecurity` matters for owner-initiated statements.
DO $$
DECLARE
    missing text[];
BEGIN
    SELECT coalesce(array_agg(c.relname ORDER BY c.relname), '{}') INTO missing
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname IN (
            'Tenant', 'TenantSettings', 'TenantBranding', 'TenantDomain',
            'TenantStatusHistory', 'TenantMember', 'Invitation', 'AuditLog', 'User',
            'Permission', 'RolePermission', 'SupportAccessGrant',
            'Contact', 'ContactAddress', 'Item', 'ContactItem',
            'TaxCategory', 'TaxRate',
            'Document', 'DocumentLine', 'DocumentPayment', 'DocumentStatusEvent',
            'DocumentNumbering', 'DocumentNumberSequence',
            'Account', 'Session', 'VerificationToken', 'AccountToken'
       )
       AND NOT c.relrowsecurity;

    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'SECURITY ERROR: RLS is not enabled on: %', array_to_string(missing, ', ');
    END IF;

    RAISE NOTICE 'RLS is enabled on every AmisiBiz table.';
END
$$;

-- ─── 8. Policies exist per table (the enforcement surface) ─────────────────
DO $$
DECLARE
    n int;
BEGIN
    SELECT count(*) INTO n FROM pg_catalog.pg_policies p
      JOIN pg_catalog.pg_namespace ns ON ns.oid = p.policynamespace
     WHERE ns.nspname = 'public';

    IF n < 40 THEN
        RAISE WARNING 'Only % policies exist in schema public — migration 20261018000002 installs far more. Check the migration history.', n;
    ELSE
        RAISE NOTICE '% RLS policies installed in schema public.', n;
    END IF;
END
$$;

-- ─── 9. The runtime role can read its own context helpers ──────────────────
DO $$
BEGIN
    IF NOT has_function_privilege(
        'amisibiz_app', 'public.set_tenant_context(text, text, text, boolean, boolean)', 'EXECUTE')
    THEN
        RAISE EXCEPTION
          'SECURITY ERROR: amisibiz_app cannot call set_tenant_context/5 — every scoped statement would fail. Apply migration 20261018000002.';
    END IF;

    IF has_function_privilege('amisibiz_app', 'public.current_setting(text)', 'EXECUTE') THEN
        RAISE WARNING 'Unexpected: amisibiz_app has EXECUTE on a function named public.current_setting(text). Only the GUC built-in should exist.';
    END IF;

    RAISE NOTICE 'Scoped-context helper is executable by the runtime role.';
END
$$;

-- ─── 10. Live proof that the policies actually filter ──────────────────────
-- The definitive check is behavioural, and it needs a password to connect with,
-- so it lives in the app rather than here:
--
--   pnpm --filter @amisibiz/web db:assert-rls
--   (equivalently: pnpm tsx prisma/scripts/assert-rls.mts, from apps/web)
--
-- assertRowLevelSecurityActive proves the runtime role is not a bypass role and
-- that an empty context reads zero tenant rows. Run it right after setting the
-- password — a role that can read every tenant with no context means the
-- policies are installed but inert.

-- ─── 11. Connection string template ───────────────────────────────────────
-- Paste the secret from your manager; never commit the real value.
--
--   APP_DATABASE_URL="postgresql://amisibiz_app:<password>@<host>:<port>/postgres?sslmode=require"
--
-- Keep DATABASE_URL/DIRECT_URL pointed at the owner role for Prisma CLI work
-- (migrate, db seed) only — see apps/web/.env.example.
