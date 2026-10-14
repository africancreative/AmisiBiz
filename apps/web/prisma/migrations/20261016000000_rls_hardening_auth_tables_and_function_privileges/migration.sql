-- Migration: forward-fix for RLS defects found by the Phase 03.5 audit.
-- Created: 2026-10-14
--
-- Corrections to 20261013000001_rls_policies_and_constraints, which is applied
-- on every environment and therefore frozen — editing an applied migration
-- changes its checksum and makes `prisma migrate deploy` refuse to run.
-- Everything here is additive, and behaviour-preserving for the running
-- application, which connects as the table owner while RLS activation is
-- Phase 08 work (owner and superuser roles both bypass RLS).

-- ── Defect A — policies that were never activated ────────────────────────────
-- Sections 11-12 of 20261013000001 created policies on "User", "Account",
-- "Session" and "AccountToken" (`TO amisibiz_app`) but never enabled row level
-- security on those tables, so the policies had no effect at all. Enabling RLS
-- now makes the declared policies real.
--
-- "VerificationToken" has no policies; with RLS enabled the application role
-- is denied by default there, which is the intended posture for a table the
-- credentials-based application does not touch. If an Auth.js email flow is
-- introduced, its required policies must be added first.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VerificationToken" ENABLE ROW LEVEL SECURITY;

-- ── Defect B — empty-string GUCs break the fail-closed default ───────────────
-- Found by the behavioural RLS test in tests/integration-security.test.ts.
-- A placeholder parameter that was ever set with transaction-local scope
-- reverts to the EMPTY STRING — not to "undefined" — so on a pooled connection
-- `current_setting('app.is_platform_admin', true)` returns '' rather than
-- NULL, `''::boolean` raises 22P02, and is_platform_admin() ERRORED instead of
-- returning false. An error is not the intended fail-closed answer, and the
-- failure depended on which pooled connection served the request. Normalise
-- every read: empty means unset. Replaced before the ALTER/REVOKE statements
-- below so the final definition carries the pinned search_path and the
-- narrowed EXECUTE grants.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text AS $$
    SELECT NULLIF(current_setting('app.current_tenant_id', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS text AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_platform_admin() RETURNS boolean AS $$
    SELECT COALESCE(NULLIF(current_setting('app.is_platform_admin', true), ''), 'false')::boolean;
$$ LANGUAGE sql STABLE;

-- ── Defect C — SECURITY DEFINER functions resolve through the caller's path ──
-- set_tenant_context() and clear_tenant_context() run with the migration
-- owner's privileges (SECURITY DEFINER). Unqualified names inside a definer
-- function must never resolve through a search_path the caller can influence;
-- pin it to the safe default.
ALTER FUNCTION public.set_tenant_context(text, text, boolean)
    SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.clear_tenant_context()
    SET search_path = pg_catalog, pg_temp;

-- ── Defect D — RLS machinery executable by PUBLIC ────────────────────────────
-- New functions grant EXECUTE to PUBLIC by default. These five belong to the
-- RLS machinery and should be callable only by the roles that need them. The
-- three policy helpers stay executable by amisibiz_app because policy
-- expressions are evaluated with the querying role's privileges.
REVOKE EXECUTE ON FUNCTION public.current_tenant_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_platform_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_tenant_context(text, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clear_tenant_context() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.current_user_id() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO amisibiz_app;
-- set_tenant_context / clear_tenant_context already carry explicit
-- amisibiz_app grants from 20261013000001.
