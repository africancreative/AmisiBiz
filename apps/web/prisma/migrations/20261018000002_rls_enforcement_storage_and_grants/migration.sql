-- Migration: Phase 1 — RLS enforcement, storage policies and grant remediation.
-- Created: 2026-10-18
--
-- Why this file exists: the previous two migrations made the schema ready
-- (UUIDs, 9-role model, RBAC catalog, support-grant table); this one is where
-- the row level security policies stop being documentation and start being
-- enforcement. It implements §5, §6, §7 and §8 of
-- docs/implementation/phase-01-security-design.md.
--
-- The architecture in one paragraph: every policy is scoped to the runtime
-- role (`amisibiz_app`). What a session may do is decided by the CONTEXT it
-- set (`set_tenant_context`) plus facts re-derived from the database itself.
-- Membership and role are never taken from the caller's claim — they are read
-- from `TenantMember` by SECURITY DEFINER helpers (`app_tenant_role`,
-- `has_tenant_membership`); platform authority is re-derived from
-- `User.platformRole`, not from a GUC flag; support access is re-checked
-- against an unrevoked, unexpired `SupportAccessGrant`. A wrong or missing
-- context fails closed: policies return no rows and writes raise.
--
-- Guard triggers back the policies where RLS cannot see a transition
-- (old vs new): self-elevation, delegation rules, last-owner protection,
-- immutable invitation fields, tenant status. `allocate_document_number`
-- gains its viewer/portal/no-context refusal here (§5.5).
--
-- Storage (§7): a private `tenant-branding` bucket; policies on
-- `storage.objects` scoped to the path's tenant segment and a membership of
-- `auth.uid()`. This file is written to run on Supabase *and* on a bare
-- local PostgreSQL: the `storage`/`auth` schemas and the `authenticated`
-- role are stubbed only when they do not exist (existence-guarded), so the
-- same SQL is verifiable offline.
--
-- Grants (§8): the Phase 03 blanket grants (`GRANT ... ON ALL TABLES`,
-- `ALTER DEFAULT PRIVILEGES`) covered the shared project's OTHER
-- application's objects. This file stops the default-privilege river,
-- revokes `amisibiz_app` everywhere, and re-grants per AmisiBiz table —
-- exactly. The end state is listed in the verification queries of §9.

-- ─── 1. Helper functions ─────────────────────────────────────────────────────
-- Naming: `app_*` / `has_*` functions are policy machinery. The definer
-- helpers pin `search_path` and use fully-qualified names (rewriting
-- convention from 20261016000000: a definer function must never resolve
-- names through a path the caller can influence).

-- Platform authority, re-derived from the database. The GUC
-- `app.is_platform_admin` still exists (set by set_tenant_context for
-- transparency) but no policy trusts it: a connection that merely CLAIMS
-- platform admin gets nothing, because this function asks `User.platformRole`.
CREATE OR REPLACE FUNCTION public.is_platform_admin() RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."User" u
         WHERE u."id" = public.current_user_id()
           AND u."platformRole" = 'SUPER_ADMIN'
           AND u."status" = 'ACTIVE'
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION public.is_platform_support() RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."User" u
         WHERE u."id" = public.current_user_id()
           AND u."platformRole" = 'SUPPORT'
           AND u."status" = 'ACTIVE'
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- The real membership role for a tenant, read from TenantMember. NULL when
-- the user is not a member — which every caller must treat as "no access".
CREATE OR REPLACE FUNCTION public.app_tenant_role(p_tenant_id uuid) RETURNS text AS $$
    SELECT m."role"::text
      FROM public."TenantMember" m
     WHERE m."tenantId" = p_tenant_id
       AND m."userId" = public.current_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- SECURITY DEFINER so the answer does not depend on the caller's own
-- visibility of TenantMember (avoids policy recursion and visibility games).
CREATE OR REPLACE FUNCTION public.has_tenant_membership(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."TenantMember" m
         WHERE m."tenantId" = p_tenant_id
           AND m."userId" = public.current_user_id()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- A user a member of the SAME current tenant (owner/admin name lookups etc.).
CREATE OR REPLACE FUNCTION public.app_shares_tenant_with(p_user_id uuid) RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."TenantMember" actor
          JOIN public."TenantMember" target ON target."tenantId" = actor."tenantId"
         WHERE actor."userId" = public.current_user_id()
           AND target."userId" = p_user_id
           AND actor."tenantId" = public.current_tenant_id()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- Same, but the actor must be an owner/admin (forced-logout flows).
CREATE OR REPLACE FUNCTION public.app_shares_admin_tenant_with(p_user_id uuid) RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."TenantMember" actor
          JOIN public."TenantMember" target ON target."tenantId" = actor."tenantId"
         WHERE actor."userId" = public.current_user_id()
           AND target."userId" = p_user_id
           AND actor."role" IN ('TENANT_OWNER', 'TENANT_ADMIN')
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- The signed-in user's verified email — the anchor for invitation recipient
-- policies and acceptance. SECURITY DEFINER: the recipient must be able to
-- find an invitation addressed to them before any tenant context exists.
CREATE OR REPLACE FUNCTION public.app_current_user_email() RETURNS text AS $$
    SELECT u."email" FROM public."User" u WHERE u."id" = public.current_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- An active support grant: unrevoked, unexpired. Read from the grant table,
-- never from a claim.
CREATE OR REPLACE FUNCTION public.has_support_grant(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."SupportAccessGrant" g
         WHERE g."tenantId" = p_tenant_id
           AND g."platformUserId" = public.current_user_id()
           AND g."revokedAt" IS NULL
           AND g."expiresAt" > now()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- ── The three policy families (§5.3) ─────────────────────────────────────────

-- Read: the tenant's context is set, the caller is a member AND not a
-- customer-portal user (portal users never reach internal records), or the
-- caller is a platform admin, or support with an active grant on that tenant.
CREATE OR REPLACE FUNCTION public.has_tenant_read_access(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT (
        (p_tenant_id IS NOT NULL
         AND p_tenant_id = public.current_tenant_id()
         AND public.app_tenant_role(p_tenant_id) IS NOT NULL
         AND public.app_tenant_role(p_tenant_id) <> 'CUSTOMER_PORTAL_USER')
        OR public.is_platform_admin()
        OR (public.is_platform_support() AND public.has_support_grant(p_tenant_id))
    );
$$ LANGUAGE sql STABLE;

-- Write: the five writing roles only, in the tenant's own context — or a
-- platform admin. Deliberately NO support path: support is read-only at the
-- database level as well as in the application.
CREATE OR REPLACE FUNCTION public.has_tenant_write_access(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT (
        (p_tenant_id IS NOT NULL
         AND p_tenant_id = public.current_tenant_id()
         AND public.app_tenant_role(p_tenant_id) IN
             ('TENANT_OWNER', 'TENANT_ADMIN', 'SALES', 'FINANCE', 'OPERATIONS'))
        OR public.is_platform_admin()
    );
$$ LANGUAGE sql STABLE;

-- Admin: settings, branding, memberships, invitations, audit reads.
CREATE OR REPLACE FUNCTION public.has_tenant_admin_access(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT (
        (p_tenant_id IS NOT NULL
         AND p_tenant_id = public.current_tenant_id()
         AND public.app_tenant_role(p_tenant_id) IN ('TENANT_OWNER', 'TENANT_ADMIN'))
        OR public.is_platform_admin()
    );
$$ LANGUAGE sql STABLE;

-- The registration anchor: the person who provisioned a still-PENDING tenant.
-- This is what makes "self-create the owner membership" attacker-proof — the
-- right exists only towards a tenant you created and that nobody has
-- activated yet (§5.4).
CREATE OR REPLACE FUNCTION public.app_is_tenant_creator(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."Tenant" t
         WHERE t."id" = p_tenant_id
           AND t."createdById" = public.current_user_id()
           AND t."status" = 'PENDING'
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- Role ranking for the delegation guards (§5.5). SALES/FINANCE/OPERATIONS
-- share a rank: the matrix treats them as peers.
CREATE OR REPLACE FUNCTION public.app_tenant_role_rank(p_role text) RETURNS integer AS $$
    SELECT CASE p_role
        WHEN 'TENANT_OWNER'         THEN 50
        WHEN 'TENANT_ADMIN'         THEN 40
        WHEN 'SALES'                THEN 30
        WHEN 'FINANCE'              THEN 30
        WHEN 'OPERATIONS'           THEN 30
        WHEN 'VIEWER'               THEN 20
        WHEN 'CUSTOMER_PORTAL_USER' THEN 10
    END;
$$ LANGUAGE sql IMMUTABLE;

-- The tenant segment of a branding object path
-- (`tenants/<uuid>/logo/<file>`), NULL for anything else. Used by the
-- storage policies; safe for the `authenticated` role to call (it computes
-- from its argument only).
CREATE OR REPLACE FUNCTION public.app_object_tenant_id(p_name text) RETURNS uuid AS $$
    SELECT CASE
        WHEN split_part(p_name, '/', 1) = 'tenants'
         AND split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN split_part(p_name, '/', 2)::uuid
    END;
$$ LANGUAGE sql IMMUTABLE;

-- Storage-side membership test: (tenant, user) pair, both supplied by the
-- caller (the storage policy supplies auth.uid()). Definer: runs without a
-- tenant context and without touching the caller's visibility.
CREATE OR REPLACE FUNCTION public.app_is_tenant_member(p_tenant_id uuid, p_user_id uuid) RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."TenantMember" m
         WHERE m."tenantId" = p_tenant_id
           AND m."userId" = p_user_id
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- One narrow fact for pre-context auth flows (§5.4): does this email belong
-- to a user, and is that user usable? Deliberately not a broad User read.
CREATE OR REPLACE FUNCTION public.app_find_user_id_by_email(p_email text)
RETURNS TABLE ("id" uuid, "status" "UserStatus") AS $$
    SELECT u."id", u."status"
      FROM public."User" u
     WHERE lower(u."email") = lower(btrim(p_email))
     LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- ─── 2. Context writers ──────────────────────────────────────────────────────
-- Five GUCs, always all five, always transaction-local (`set_config(..., true)`).
-- Setting every key on every call is what makes a pooled connection safe: a
-- parameter that was ever written with transaction-local scope reverts to the
-- SESSION value at commit, so "not set this transaction" must mean "written
-- to empty this transaction", never "left over from last time".

DROP FUNCTION IF EXISTS public.set_tenant_context(text, text, boolean);

CREATE OR REPLACE FUNCTION public.set_tenant_context(
    p_tenant_id           text DEFAULT NULL,
    p_user_id             text DEFAULT NULL,
    p_tenant_role         text DEFAULT NULL,
    p_is_platform_admin   boolean DEFAULT false,
    p_is_platform_support boolean DEFAULT false
) RETURNS void AS $$
DECLARE
    v_tenant uuid;
    v_user   uuid;
BEGIN
    -- Shape-check before storing: the readers cast to uuid, so a malformed
    -- value would make every subsequent query ERROR instead of returning
    -- nothing. Refusing it here lands the failure on the writer that made it.
    IF p_tenant_id IS NOT NULL AND btrim(p_tenant_id) <> '' THEN
        v_tenant := p_tenant_id::uuid;
    END IF;
    IF p_user_id IS NOT NULL AND btrim(p_user_id) <> '' THEN
        v_user := p_user_id::uuid;
    END IF;

    PERFORM set_config('app.current_tenant_id',   coalesce(v_tenant::text, ''), true);
    PERFORM set_config('app.current_user_id',     coalesce(v_user::text, ''), true);
    PERFORM set_config('app.current_tenant_role', coalesce(nullif(btrim(p_tenant_role), ''), ''), true);
    PERFORM set_config('app.is_platform_admin',   p_is_platform_admin::text, true);
    PERFORM set_config('app.is_platform_support', p_is_platform_support::text, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- Scrub, at SESSION scope (transaction-local settings revert, session
-- settings are what a pooled connection can leak into the next borrower).
CREATE OR REPLACE FUNCTION public.clear_tenant_context() RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id',   '',      false);
    PERFORM set_config('app.current_user_id',     '',      false);
    PERFORM set_config('app.current_tenant_role', '',      false);
    PERFORM set_config('app.is_platform_admin',   'false', false);
    PERFORM set_config('app.is_platform_support', 'false', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- ─── 3. EXECUTE grants for the policy machinery ──────────────────────────────
-- Policy expressions are evaluated with the querying role's privileges, so
-- `amisibiz_app` needs EXECUTE on every helper its policies call. PUBLIC gets
-- none of these: they are reachable only by the roles that need them.

REVOKE EXECUTE ON FUNCTION public.is_platform_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_platform_support() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_tenant_role(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_tenant_membership(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_shares_tenant_with(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_shares_admin_tenant_with(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_current_user_email() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_support_grant(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_tenant_read_access(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_tenant_write_access(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_tenant_admin_access(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_is_tenant_creator(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_tenant_role_rank(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_find_user_id_by_email(text) FROM PUBLIC;
-- The five-argument context setter above is a NEW function (the old three-role
-- signature was dropped and recreated), so it arrived with PostgreSQL's default
-- `EXECUTE TO PUBLIC`. That is exactly the hole
-- 20261016000000_rls_hardening_auth_tables_and_function_privileges closed for
-- the previous signature: an exposed RPC entry point that lets any anonymous
-- caller write request-context GUCs. Revoke it again before granting it back.
REVOKE EXECUTE ON FUNCTION public.set_tenant_context(text, text, text, boolean, boolean) FROM PUBLIC;
-- `clear_tenant_context` survived as the same signature, so it inherited the
-- old revocation — stated explicitly anyway so the end state never depends on
-- which migrations an environment ran before this one.
REVOKE EXECUTE ON FUNCTION public.clear_tenant_context() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.is_platform_support() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_tenant_role(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.has_tenant_membership(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_shares_tenant_with(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_shares_admin_tenant_with(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_current_user_email() TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.has_support_grant(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.has_tenant_read_access(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.has_tenant_write_access(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.has_tenant_admin_access(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_is_tenant_creator(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_tenant_role_rank(text) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_find_user_id_by_email(text) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.set_tenant_context(text, text, text, boolean, boolean) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.clear_tenant_context() TO amisibiz_app;

-- The storage helpers are evaluated by the `authenticated` role when the
-- storage policies run (and only there, for `amisibiz_app`'s own tests).
-- `app_object_tenant_id` leaks nothing (pure string logic);
-- `app_is_tenant_member` answers only about the (tenant, user) pair it was
-- given, and `authenticated` must be able to call it for the policy to work.
REVOKE EXECUTE ON FUNCTION public.app_object_tenant_id(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_is_tenant_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_object_tenant_id(text) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.app_is_tenant_member(uuid, uuid) TO amisibiz_app;

-- ─── 4. Row level security: one policy set per table ─────────────────────────
-- Every policy targets `amisibiz_app` only. A role with RLS enabled and no
-- matching policy sees nothing — which is exactly what `anon`/`authenticated`
-- (if they ever reached these tables through the REST API) must see.

ALTER TABLE "Tenant"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSettings"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantBranding"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantDomain"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantMember"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantStatusHistory"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportAccessGrant"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Permission"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaxCategory"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaxRate"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactAddress"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Item"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactItem"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Document"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentLine"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentPayment"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentStatusEvent"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentNumbering"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentNumberSequence" ENABLE ROW LEVEL SECURITY;

-- ── The plain business tables ────────────────────────────────────────────────
-- Same semantics everywhere: read = the read family, insert/update/delete =
-- the write family. Where the matrix is stricter than the family (settings,
-- branding, memberships, invitations, numbering) the table gets explicit
-- policies below instead of this loop. `ContactAddress` is the one table with
-- no `tenantId` of its own: it derives its tenant through its contact and is
-- handled explicitly after the loop.

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'TaxCategory', 'TaxRate', 'Contact', 'Item',
        'ContactItem', 'Document', 'DocumentLine', 'DocumentPayment',
        'DocumentStatusEvent', 'DocumentNumbering', 'DocumentNumberSequence'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_read_' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_insert_' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_update_' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_delete_' || t, t);

        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR SELECT TO amisibiz_app USING (public.has_tenant_read_access("tenantId"))',
            'app_read_' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR INSERT TO amisibiz_app WITH CHECK (public.has_tenant_write_access("tenantId"))',
            'app_insert_' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE TO amisibiz_app USING (public.has_tenant_write_access("tenantId")) WITH CHECK (public.has_tenant_write_access("tenantId"))',
            'app_update_' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR DELETE TO amisibiz_app USING (public.has_tenant_write_access("tenantId"))',
            'app_delete_' || t, t);
    END LOOP;
END
$$;

-- ── ContactAddress: tenant derived through the contact ───────────────────────
-- The address row carries no tenant; the gate is the write/read family of the
-- contact's tenant. The subquery reads "Contact" under its own RLS with the
-- same context, and every writing role is also a reading role, so the nested
-- evaluation always sees the contact exactly when the actor should.
DROP POLICY IF EXISTS app_read_ContactAddress   ON public."ContactAddress";
DROP POLICY IF EXISTS app_insert_ContactAddress ON public."ContactAddress";
DROP POLICY IF EXISTS app_update_ContactAddress ON public."ContactAddress";
DROP POLICY IF EXISTS app_delete_ContactAddress ON public."ContactAddress";

CREATE POLICY app_read_ContactAddress ON public."ContactAddress"
    FOR SELECT TO amisibiz_app
    USING (EXISTS (
        SELECT 1 FROM public."Contact" c
         WHERE c."id" = "contactId"
           AND public.has_tenant_read_access(c."tenantId")
    ));

CREATE POLICY app_insert_ContactAddress ON public."ContactAddress"
    FOR INSERT TO amisibiz_app
    WITH CHECK (EXISTS (
        SELECT 1 FROM public."Contact" c
         WHERE c."id" = "contactId"
           AND public.has_tenant_write_access(c."tenantId")
    ));

CREATE POLICY app_update_ContactAddress ON public."ContactAddress"
    FOR UPDATE TO amisibiz_app
    USING (EXISTS (
        SELECT 1 FROM public."Contact" c
         WHERE c."id" = "contactId"
           AND public.has_tenant_write_access(c."tenantId")
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public."Contact" c
         WHERE c."id" = "contactId"
           AND public.has_tenant_write_access(c."tenantId")
    ));

CREATE POLICY app_delete_ContactAddress ON public."ContactAddress"
    FOR DELETE TO amisibiz_app
    USING (EXISTS (
        SELECT 1 FROM public."Contact" c
         WHERE c."id" = "contactId"
           AND public.has_tenant_write_access(c."tenantId")
    ));

-- ── Tenant ───────────────────────────────────────────────────────────────────
-- Read: read family, plus self-membership discovery (a signed-in user must be
-- able to list their own workspaces before any tenant context exists), plus
-- the registration creator anchor. The creator anchor is not a convenience:
-- `INSERT ... RETURNING` — which is what an ORM `create()` issues — is also
-- filtered by the table's SELECT policy, so without it the registration
-- transaction could legitimately write its own PENDING tenant and then fail to
-- read the generated id back.
--
-- It is written out on the row's own columns instead of calling
-- `app_is_tenant_creator("id")`, and that is deliberate: a policy function that
-- re-reads `Tenant` cannot see the row the current command is inserting (each
-- command sees the snapshot taken when it started), so a function-based anchor
-- would let the INSERT through and then reject its own RETURNING row. Same
-- narrow fact — PENDING and `createdById = current_user_id()` — read straight
-- off the candidate row.
-- Insert (registration or provisioning): only a PENDING tenant whose
-- createdById is the actor — or a platform admin provisioning through the
-- console. A tenant can never be born ACTIVE: activation is a separate,
-- audited platform action.
-- Update: admin family (owner/admin fields, platform lifecycle actions); the
-- status column is additionally guarded by trigger below.

DROP POLICY IF EXISTS tenant_read_access ON "Tenant";
CREATE POLICY tenant_read_access ON "Tenant"
    FOR SELECT TO amisibiz_app
    USING (
        public.has_tenant_read_access("id")
        OR public.has_tenant_membership("id")
        OR ("status" = 'PENDING' AND "createdById" = public.current_user_id())
    );

DROP POLICY IF EXISTS tenant_registration_insert ON "Tenant";
CREATE POLICY tenant_registration_insert ON "Tenant"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        public.is_platform_admin()
        OR ("status" = 'PENDING' AND "createdById" = public.current_user_id())
    );

DROP POLICY IF EXISTS tenant_admin_update ON "Tenant";
CREATE POLICY tenant_admin_update ON "Tenant"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_access("id"))
    WITH CHECK (public.has_tenant_admin_access("id"));

-- ── TenantSettings / TenantBranding ─────────────────────────────────────────
-- Strictly owner/admin for writes (the matrix: settings.update and
-- branding.update exist only for them), plus the registration anchor for the
-- provisioning rows. No DELETE policies: the grants do not include DELETE and
-- these rows are structural.

DROP POLICY IF EXISTS tenant_settings_read ON "TenantSettings";
CREATE POLICY tenant_settings_read ON "TenantSettings"
    FOR SELECT TO amisibiz_app
    USING (public.has_tenant_read_access("tenantId"));

DROP POLICY IF EXISTS tenant_settings_insert ON "TenantSettings";
CREATE POLICY tenant_settings_insert ON "TenantSettings"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        (public.current_tenant_id() = "tenantId"
         AND public.app_tenant_role("tenantId") IN ('TENANT_OWNER', 'TENANT_ADMIN'))
        OR public.app_is_tenant_creator("tenantId")
    );

DROP POLICY IF EXISTS tenant_settings_update ON "TenantSettings";
CREATE POLICY tenant_settings_update ON "TenantSettings"
    FOR UPDATE TO amisibiz_app
    USING (
        public.current_tenant_id() = "tenantId"
        AND public.app_tenant_role("tenantId") IN ('TENANT_OWNER', 'TENANT_ADMIN')
    )
    WITH CHECK (
        public.current_tenant_id() = "tenantId"
        AND public.app_tenant_role("tenantId") IN ('TENANT_OWNER', 'TENANT_ADMIN')
    );

DROP POLICY IF EXISTS tenant_branding_read ON "TenantBranding";
CREATE POLICY tenant_branding_read ON "TenantBranding"
    FOR SELECT TO amisibiz_app
    USING (public.has_tenant_read_access("tenantId"));

DROP POLICY IF EXISTS tenant_branding_insert ON "TenantBranding";
CREATE POLICY tenant_branding_insert ON "TenantBranding"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        (public.current_tenant_id() = "tenantId"
         AND public.app_tenant_role("tenantId") IN ('TENANT_OWNER', 'TENANT_ADMIN'))
        OR public.app_is_tenant_creator("tenantId")
    );

DROP POLICY IF EXISTS tenant_branding_update ON "TenantBranding";
CREATE POLICY tenant_branding_update ON "TenantBranding"
    FOR UPDATE TO amisibiz_app
    USING (
        public.current_tenant_id() = "tenantId"
        AND public.app_tenant_role("tenantId") IN ('TENANT_OWNER', 'TENANT_ADMIN')
    )
    WITH CHECK (
        public.current_tenant_id() = "tenantId"
        AND public.app_tenant_role("tenantId") IN ('TENANT_OWNER', 'TENANT_ADMIN')
    );

-- ── TenantDomain ────────────────────────────────────────────────────────────
-- Domain rows are written by provisioning (registration anchor) and managed
-- by owner/admin; the platform console may attach a custom hostname, which
-- the admin family admits.

DROP POLICY IF EXISTS tenant_domain_read ON "TenantDomain";
CREATE POLICY tenant_domain_read ON "TenantDomain"
    FOR SELECT TO amisibiz_app
    USING (public.has_tenant_read_access("tenantId"));

DROP POLICY IF EXISTS tenant_domain_insert ON "TenantDomain";
CREATE POLICY tenant_domain_insert ON "TenantDomain"
    FOR INSERT TO amisibiz_app
    WITH CHECK (public.has_tenant_admin_access("tenantId") OR public.app_is_tenant_creator("tenantId"));

DROP POLICY IF EXISTS tenant_domain_update ON "TenantDomain";
CREATE POLICY tenant_domain_update ON "TenantDomain"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_access("tenantId") OR public.app_is_tenant_creator("tenantId"))
    WITH CHECK (public.has_tenant_admin_access("tenantId") OR public.app_is_tenant_creator("tenantId"));

-- ── User ────────────────────────────────────────────────────────────────────
-- Self-select (session resolution), platform admin, co-members of the current
-- tenant (name/email display in member lists).
-- Insert: the registration mirror row — id must BE the authenticated user.
-- Update: self, platform admin, or a co-member; the trigger below decides
-- which columns each of those may actually move (self-elevation dies there).

DROP POLICY IF EXISTS user_select ON "User";
CREATE POLICY user_select ON "User"
    FOR SELECT TO amisibiz_app
    USING (
        "id" = public.current_user_id()
        OR public.is_platform_admin()
        OR public.app_shares_tenant_with("id")
    );

DROP POLICY IF EXISTS user_registration_insert ON "User";
CREATE POLICY user_registration_insert ON "User"
    FOR INSERT TO amisibiz_app
    WITH CHECK ("id" = public.current_user_id());

DROP POLICY IF EXISTS user_update ON "User";
CREATE POLICY user_update ON "User"
    FOR UPDATE TO amisibiz_app
    USING (
        "id" = public.current_user_id()
        OR public.is_platform_admin()
        OR public.app_shares_tenant_with("id")
    )
    WITH CHECK (
        "id" = public.current_user_id()
        OR public.is_platform_admin()
        OR public.app_shares_tenant_with("id")
    );

-- ── TenantMember ────────────────────────────────────────────────────────────
-- Select: own rows (workspace discovery) or the read family.
-- Insert: exactly three narrow paths — platform admin, accepted-invitation
-- self-join (email and role must match the ACCEPTED invitation, checked in
-- SQL), or the registration creator claiming the OWNER seat of their own
-- PENDING tenant. Everything else is a policy violation, not an error case.
-- Update/Delete: admin family; the guard triggers enforce delegation,
-- self-change and last-owner rules that RLS cannot see.

DROP POLICY IF EXISTS tenant_member_select ON "TenantMember";
CREATE POLICY tenant_member_select ON "TenantMember"
    FOR SELECT TO amisibiz_app
    USING ("userId" = public.current_user_id() OR public.has_tenant_read_access("tenantId"));

DROP POLICY IF EXISTS tenant_member_insert ON "TenantMember";
CREATE POLICY tenant_member_insert ON "TenantMember"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        public.is_platform_admin()
        OR ("userId" = public.current_user_id()
            AND (
                ("role" = 'TENANT_OWNER' AND public.app_is_tenant_creator("tenantId"))
                OR EXISTS (
                    SELECT 1
                      FROM "Invitation" i
                     WHERE i."tenantId" = "TenantMember"."tenantId"
                       AND lower(i."email") = lower(public.app_current_user_email())
                       AND i."role" = "TenantMember"."role"
                       AND i."status" = 'ACCEPTED'
                )
            ))
    );

DROP POLICY IF EXISTS tenant_member_update ON "TenantMember";
CREATE POLICY tenant_member_update ON "TenantMember"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_access("tenantId"))
    WITH CHECK (public.has_tenant_admin_access("tenantId"));

DROP POLICY IF EXISTS tenant_member_delete ON "TenantMember";
CREATE POLICY tenant_member_delete ON "TenantMember"
    FOR DELETE TO amisibiz_app
    USING (public.has_tenant_admin_access("tenantId"));

-- ── Invitation ──────────────────────────────────────────────────────────────
-- Select: the read family (team page; `members.read` covers invitations) or
-- the recipient by verified email match.
-- Insert/Update: admin family plus the recipient's self-service updates
-- (accept/decline — column rules in the trigger). DELETE is not granted: an
-- invitation is revoked by status.

DROP POLICY IF EXISTS invitation_select ON "Invitation";
CREATE POLICY invitation_select ON "Invitation"
    FOR SELECT TO amisibiz_app
    USING (
        public.has_tenant_read_access("tenantId")
        OR lower("email") = lower(public.app_current_user_email())
    );

DROP POLICY IF EXISTS invitation_insert ON "Invitation";
CREATE POLICY invitation_insert ON "Invitation"
    FOR INSERT TO amisibiz_app
    WITH CHECK (public.has_tenant_admin_access("tenantId"));

DROP POLICY IF EXISTS invitation_update ON "Invitation";
CREATE POLICY invitation_update ON "Invitation"
    FOR UPDATE TO amisibiz_app
    USING (
        public.has_tenant_admin_access("tenantId")
        OR lower("email") = lower(public.app_current_user_email())
    )
    WITH CHECK (
        public.has_tenant_admin_access("tenantId")
        OR lower("email") = lower(public.app_current_user_email())
    );

-- ── AuditLog ────────────────────────────────────────────────────────────────
-- Append-only: every context may write an audit row (registration, denial,
-- support use), no context may rewrite history. Reads are owner/admin,
-- platform admin, or support-with-grant — never a plain viewer.

DROP POLICY IF EXISTS audit_log_insert ON "AuditLog";
CREATE POLICY audit_log_insert ON "AuditLog"
    FOR INSERT TO amisibiz_app
    WITH CHECK (true);

DROP POLICY IF EXISTS audit_log_select ON "AuditLog";
CREATE POLICY audit_log_select ON "AuditLog"
    FOR SELECT TO amisibiz_app
    USING (
        public.has_tenant_admin_access("tenantId")
        OR (public.is_platform_support() AND public.has_support_grant("tenantId"))
    );

-- ── TenantStatusHistory ─────────────────────────────────────────────────────
-- Append-only (trigger from 20261018000001). Insert: the write family (any
-- transition is a platform lifecycle action) or the registration anchor for
-- the initial PENDING row. Reads: the read family.

DROP POLICY IF EXISTS tenant_status_history_select ON "TenantStatusHistory";
CREATE POLICY tenant_status_history_select ON "TenantStatusHistory"
    FOR SELECT TO amisibiz_app
    USING (public.has_tenant_read_access("tenantId"));

DROP POLICY IF EXISTS tenant_status_history_insert ON "TenantStatusHistory";
CREATE POLICY tenant_status_history_insert ON "TenantStatusHistory"
    FOR INSERT TO amisibiz_app
    WITH CHECK (public.has_tenant_write_access("tenantId") OR public.app_is_tenant_creator("tenantId"));

-- ── SupportAccessGrant ──────────────────────────────────────────────────────
-- Only platform admins create, list and revoke grants; the grantee may see
-- their own grants. Nobody deletes: revocation is an UPDATE of revokedAt.

DROP POLICY IF EXISTS support_access_grant_select ON "SupportAccessGrant";
CREATE POLICY support_access_grant_select ON "SupportAccessGrant"
    FOR SELECT TO amisibiz_app
    USING (public.is_platform_admin() OR "platformUserId" = public.current_user_id());

DROP POLICY IF EXISTS support_access_grant_insert ON "SupportAccessGrant";
CREATE POLICY support_access_grant_insert ON "SupportAccessGrant"
    FOR INSERT TO amisibiz_app
    WITH CHECK (public.is_platform_admin() AND "grantedById" = public.current_user_id());

DROP POLICY IF EXISTS support_access_grant_update ON "SupportAccessGrant";
CREATE POLICY support_access_grant_update ON "SupportAccessGrant"
    FOR UPDATE TO amisibiz_app
    USING (public.is_platform_admin())
    WITH CHECK (public.is_platform_admin());

-- ── Permission / RolePermission ─────────────────────────────────────────────
-- Read-only catalogs for the runtime: any authenticated context may read
-- them (they are public knowledge — the matrix is in the source tree), no
-- context at all sees nothing. Writes belong to migrations, which run as the
-- owner; `amisibiz_app` has SELECT grants only.

DROP POLICY IF EXISTS permission_select ON "Permission";
CREATE POLICY permission_select ON "Permission"
    FOR SELECT TO amisibiz_app
    USING (public.current_user_id() IS NOT NULL);

DROP POLICY IF EXISTS role_permission_select ON "RolePermission";
CREATE POLICY role_permission_select ON "RolePermission"
    FOR SELECT TO amisibiz_app
    USING (public.current_user_id() IS NOT NULL);

-- ─── 5. Guard triggers (§5.5) ────────────────────────────────────────────────
-- RLS answers "which rows", triggers answer "which transitions". Both are
-- needed: an owner/admin may update a membership row, but only the guards
-- can refuse them changing their own role or removing the last owner.

-- 5.1 User rows. Self-service changes are cosmetic plus a one-step
-- sessionVersion bump; email/status/platformRole are not self-serviceable at
-- any scale (kills tenant-user platform-role self-elevation in the database).
-- Another user's row may only take a sessionVersion bump, and only from an
-- owner/admin of a shared workspace (the forced-logout flow).
CREATE OR REPLACE FUNCTION public.users_guard_update() RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'User identity fields are immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF public.is_platform_admin() THEN
        RETURN NEW;
    END IF;

    IF OLD."id" = public.current_user_id() THEN
        IF NEW."email" IS DISTINCT FROM OLD."email"
           OR NEW."status" IS DISTINCT FROM OLD."status"
           OR NEW."platformRole" IS DISTINCT FROM OLD."platformRole" THEN
            RAISE EXCEPTION 'Email, status and platform role are not self-serviceable'
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."sessionVersion" IS DISTINCT FROM OLD."sessionVersion"
           AND NEW."sessionVersion" <> OLD."sessionVersion" + 1 THEN
            RAISE EXCEPTION 'sessionVersion may only be incremented by one'
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    END IF;

    -- A different user's row: only the forced-logout shape is permitted.
    IF NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."email" IS DISTINCT FROM OLD."email"
       OR NEW."image" IS DISTINCT FROM OLD."image"
       OR NEW."emailVerified" IS DISTINCT FROM OLD."emailVerified"
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."platformRole" IS DISTINCT FROM OLD."platformRole" THEN
        RAISE EXCEPTION 'Only the account owner can change these profile fields'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."sessionVersion" IS DISTINCT FROM OLD."sessionVersion" THEN
        IF NEW."sessionVersion" <> OLD."sessionVersion" + 1 THEN
            RAISE EXCEPTION 'sessionVersion may only be incremented by one'
                USING ERRCODE = 'check_violation';
        END IF;

        IF NOT public.app_shares_admin_tenant_with(OLD."id") THEN
            RAISE EXCEPTION 'Bumping another user''s session requires owner/admin membership in a shared workspace'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_guard_update ON "User";
CREATE TRIGGER users_guard_update
    BEFORE UPDATE ON "User"
    FOR EACH ROW EXECUTE FUNCTION public.users_guard_update();

-- 5.2 Membership role changes: owner/admin actors only, never self, never an
-- owner's seat unless the actor is an owner, never a role at or above the
-- actor's own; the owner role is granted only by an owner.
CREATE OR REPLACE FUNCTION public.tenant_members_guard_role_change() RETURNS trigger AS $$
DECLARE
    v_actor_role  text;
    v_actor_rank  integer;
    v_target_rank integer;
    v_new_rank    integer;
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."joinedAt" IS DISTINCT FROM OLD."joinedAt" THEN
        RAISE EXCEPTION 'Membership identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."role" IS NOT DISTINCT FROM OLD."role" THEN
        RETURN NEW; -- no role change: isDefault flips and the like are policy business
    END IF;

    v_actor_role  := public.app_tenant_role(OLD."tenantId");
    v_actor_rank  := public.app_tenant_role_rank(v_actor_role);
    v_target_rank := public.app_tenant_role_rank(OLD."role"::text);
    v_new_rank    := public.app_tenant_role_rank(NEW."role"::text);

    IF v_actor_rank IS NULL OR v_actor_rank < 40 THEN
        RAISE EXCEPTION 'Only an owner or admin of the workspace can change a member role'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD."userId" = public.current_user_id() THEN
        RAISE EXCEPTION 'A member cannot change their own role'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_target_rank >= 50 AND v_actor_rank < 50 THEN
        RAISE EXCEPTION 'Only an owner can modify an owner membership'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW."role" = 'TENANT_OWNER' AND v_actor_rank < 50 THEN
        RAISE EXCEPTION 'Only an owner can grant the owner role'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_new_rank IS NULL THEN
        RAISE EXCEPTION 'Unknown target role'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_actor_rank < 50 AND v_new_rank >= v_actor_rank THEN
        RAISE EXCEPTION 'A role at or above your own cannot be granted'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_members_guard_role_change ON "TenantMember";
CREATE TRIGGER tenant_members_guard_role_change
    BEFORE UPDATE ON "TenantMember"
    FOR EACH ROW EXECUTE FUNCTION public.tenant_members_guard_role_change();

-- 5.3 Membership deletion: no self-removal, the last owner stays.
CREATE OR REPLACE FUNCTION public.tenant_members_guard_delete() RETURNS trigger AS $$
BEGIN
    IF OLD."userId" = public.current_user_id() THEN
        RAISE EXCEPTION 'A member cannot remove themselves; ask an owner or admin'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."role" = 'TENANT_OWNER' THEN
        IF (SELECT count(*)
              FROM "TenantMember" m
             WHERE m."tenantId" = OLD."tenantId"
               AND m."role" = 'TENANT_OWNER') <= 1 THEN
            RAISE EXCEPTION 'The last owner of a workspace cannot be removed'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_members_guard_delete ON "TenantMember";
CREATE TRIGGER tenant_members_guard_delete
    BEFORE DELETE ON "TenantMember"
    FOR EACH ROW EXECUTE FUNCTION public.tenant_members_guard_delete();

-- 5.4 Invitation updates: owner/admin (or platform admin) may edit freely
-- (resend rotates tokenHash); the recipient may only move status/acceptedAt.
CREATE OR REPLACE FUNCTION public.invitations_guard_update() RETURNS trigger AS $$
DECLARE
    v_actor_role text;
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."invitedBy" IS DISTINCT FROM OLD."invitedBy"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Invitation identity fields are immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF public.is_platform_admin() THEN
        RETURN NEW;
    END IF;

    v_actor_role := public.app_tenant_role(OLD."tenantId");
    IF v_actor_role IN ('TENANT_OWNER', 'TENANT_ADMIN') THEN
        RETURN NEW;
    END IF;

    IF lower(OLD."email") = lower(coalesce(public.app_current_user_email(), '')) THEN
        IF NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
           OR NEW."email" IS DISTINCT FROM OLD."email"
           OR NEW."role" IS DISTINCT FROM OLD."role"
           OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
            RAISE EXCEPTION 'An invitation recipient may only accept or decline the invitation'
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Only an owner or admin of the workspace can modify an invitation'
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invitations_guard_update ON "Invitation";
CREATE TRIGGER invitations_guard_update
    BEFORE UPDATE ON "Invitation"
    FOR EACH ROW EXECUTE FUNCTION public.invitations_guard_update();

-- 5.5 Tenant status: the lifecycle column moves only through the authorized
-- platform workflow. An owner may rename their workspace; only a platform
-- admin may activate or suspend it, whatever the row policy admits.
CREATE OR REPLACE FUNCTION public.tenant_status_guard() RETURNS trigger AS $$
BEGIN
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Only platform administrators can change a workspace status'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_status_guard ON "Tenant";
CREATE TRIGGER tenant_status_guard
    BEFORE UPDATE ON "Tenant"
    FOR EACH ROW EXECUTE FUNCTION public.tenant_status_guard();

-- ─── 6. Number allocation guard (§5.5, directive test 3) ─────────────────────
-- `allocate_document_number` now refuses to run without the tenant's own
-- context and for roles that cannot issue (viewer, portal, non-member).
-- Per-type precision (who may issue quotations vs invoices) stays in the
-- application matrix; the database enforces the role floor that the directive
-- tests by name.

CREATE OR REPLACE FUNCTION public.allocate_document_number(
    p_tenant_id uuid,
    p_type "DocumentType",
    p_date date
) RETURNS text AS $$
DECLARE
    v_prefix     text;
    v_padding    integer;
    v_separator  text;
    v_style      "DocumentPeriodStyle";
    v_fiscal     integer;
    v_period     text;
    v_value      integer;
    v_number     text;
BEGIN
    IF p_tenant_id IS NULL OR p_type IS NULL THEN
        RAISE EXCEPTION 'allocate_document_number requires a tenant and a document type'
            USING ERRCODE = 'check_violation';
    END IF;

    -- The issuance transaction must carry the tenant's own context: numbers
    -- are allocated inside a tenant scope, never from a bare platform or
    -- unset context.
    IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'Document numbers can only be allocated in the context of the tenant they belong to'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF public.app_tenant_role(p_tenant_id) IS NULL
       OR public.app_tenant_role(p_tenant_id) NOT IN
          ('TENANT_OWNER', 'TENANT_ADMIN', 'SALES', 'FINANCE', 'OPERATIONS') THEN
        RAISE EXCEPTION 'This membership role cannot issue documents'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A tenant that never opened the numbering screen still has to be able to
    -- issue, so the series is created on first use with the documented defaults
    -- (INV-2026-0001 / QUO-2026-0001 / DN-2026-0001). The row id is a fresh
    -- UUID; "create if absent" is guaranteed by the (tenantId, type) unique
    -- constraint, not by a deterministic id.
    INSERT INTO "DocumentNumbering"
            ("id", "tenantId", "type", "prefix", "padding", "separator",
             "periodStyle", "fiscalStartMonth", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(),
            p_tenant_id, p_type,
            CASE p_type WHEN 'INVOICE' THEN 'INV' WHEN 'QUOTATION' THEN 'QUO' ELSE 'DN' END,
            4, '-', 'CALENDAR_YEAR', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "type") DO NOTHING;

    SELECT n."prefix", n."padding", n."separator", n."periodStyle", n."fiscalStartMonth"
      INTO v_prefix, v_padding, v_separator, v_style, v_fiscal
      FROM "DocumentNumbering" n
     WHERE n."tenantId" = p_tenant_id AND n."type" = p_type;

    v_period := public.document_number_period(v_style, v_fiscal, p_date);

    INSERT INTO "DocumentNumberSequence"
            ("id", "tenantId", "type", "period", "nextValue", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(),
            p_tenant_id, p_type, v_period, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "type", "period") DO NOTHING;

    -- This row lock is what makes concurrent issuance safe. Two transactions
    -- allocating from the same series serialise here instead of both reading
    -- the same counter; the unique index on the document number is the backstop
    -- if the lock is ever bypassed.
    SELECT s."nextValue" INTO v_value
      FROM "DocumentNumberSequence" s
     WHERE s."tenantId" = p_tenant_id AND s."type" = p_type AND s."period" = v_period
       FOR UPDATE;

    -- Rather than silently widening the number (which would let a 5-digit value
    -- collide with a differently formatted series), stop and make the operator
    -- reconfigure the padding.
    IF v_value::numeric >= (10::numeric ^ v_padding) THEN
        RAISE EXCEPTION 'Document number series % / % / % is exhausted at %',
            p_type, p_tenant_id, v_period, v_value
            USING ERRCODE = 'program_limit_exceeded';
    END IF;

    UPDATE "DocumentNumberSequence"
       SET "nextValue" = "nextValue" + 1, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "tenantId" = p_tenant_id AND "type" = p_type AND "period" = v_period;

    -- The separator joins the parts that exist. Joining with `array_to_string`
    -- instead of concatenating means a `NONE` period produces `ACME.001` rather
    -- than `ACME001`, and an empty prefix never leaves a leading separator.
    v_number := array_to_string(
        ARRAY[NULLIF(v_prefix, ''), NULLIF(v_period, ''), lpad(v_value::text, v_padding, '0')],
        v_separator);

    IF v_number !~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$' THEN
        RAISE EXCEPTION 'Generated document number % is not a safe identifier', v_number
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ─── 7. Storage (§7): private tenant-branding bucket + object policies ───────

-- Local stubs. On Supabase the `storage`/`auth` schemas and the
-- `authenticated` role exist and these blocks do nothing; on a bare
-- PostgreSQL they create the minimum on which the (identical) policies below
-- can be created and tested. Existence-guarded so the live project is never
-- touched by the stub path.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;

    IF to_regprocedure('auth.uid()') IS NULL THEN
        CREATE SCHEMA IF NOT EXISTS auth;
        EXECUTE $stub$
            CREATE FUNCTION auth.uid() RETURNS uuid AS
            'SELECT NULLIF(current_setting(''request.jwt.claim.sub'', true), '''')::uuid;'
            LANGUAGE sql STABLE
        $stub$;
    END IF;

    IF to_regclass('storage.objects') IS NULL THEN
        CREATE SCHEMA IF NOT EXISTS storage;

        CREATE TABLE storage.buckets (
            id                 text PRIMARY KEY,
            name               text NOT NULL,
            public             boolean NOT NULL DEFAULT false,
            file_size_limit    bigint,
            allowed_mime_types text[],
            created_at         timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE storage.objects (
            id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            bucket_id  text NOT NULL,
            name       text NOT NULL,
            owner      uuid,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

        GRANT USAGE ON SCHEMA storage TO authenticated;
        GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
    END IF;
END
$$;

-- The bucket: private, 5 MB, image types only (same rules the application
-- enforces on upload). `DO UPDATE SET public = false` makes an accidental
-- public flag converge back to private rather than persisting.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tenant-branding', 'tenant-branding', false, 5242880,
        ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false;

-- Object policies: bucket-scoped; the path's tenant segment
-- (`tenants/<uuid>/logo/...`) must be a tenant the caller is a member of.
-- No anon policies; no cross-tenant reads or writes.
DROP POLICY IF EXISTS tenant_branding_objects_select ON storage.objects;
CREATE POLICY tenant_branding_objects_select ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'tenant-branding'
        AND public.app_is_tenant_member(public.app_object_tenant_id(name), auth.uid())
    );

DROP POLICY IF EXISTS tenant_branding_objects_insert ON storage.objects;
CREATE POLICY tenant_branding_objects_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'tenant-branding'
        AND public.app_is_tenant_member(public.app_object_tenant_id(name), auth.uid())
    );

DROP POLICY IF EXISTS tenant_branding_objects_update ON storage.objects;
CREATE POLICY tenant_branding_objects_update ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'tenant-branding'
        AND public.app_is_tenant_member(public.app_object_tenant_id(name), auth.uid())
    )
    WITH CHECK (
        bucket_id = 'tenant-branding'
        AND public.app_is_tenant_member(public.app_object_tenant_id(name), auth.uid())
    );

DROP POLICY IF EXISTS tenant_branding_objects_delete ON storage.objects;
CREATE POLICY tenant_branding_objects_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'tenant-branding'
        AND public.app_is_tenant_member(public.app_object_tenant_id(name), auth.uid())
    );

-- The policies above are evaluated as `authenticated` (the role a Storage
-- request runs under), and §1 revoked EXECUTE on their two helpers from
-- PUBLIC. Without these grants every upload and listing would die with
-- `permission denied for function app_is_tenant_member` — an invisible failure
-- until a real browser tries to store a logo. Only these two are opened, and
-- only to `authenticated`; `anon` gets nothing because the bucket is private
-- and no anon policy exists.
GRANT EXECUTE ON FUNCTION public.app_object_tenant_id(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_is_tenant_member(uuid, uuid) TO authenticated;

-- ─── 8. Grant remediation and exact grants (§8) ──────────────────────────────

-- (a) Stop the default-privilege river. The Phase 03 migration granted
-- `ALTER DEFAULT PRIVILEGES` to amisibiz_app, so every table created later
-- anywhere in `public` — including the shared project's other application's
-- tables — was born readable and writable by AmisiBiz's runtime role. Revoke
-- the defaults for the roles that plausibly set them. A role we cannot
-- administer produces a notice, not a failed migration: the point is that
-- after this file, no such grant exists for the migration role itself, and
-- the per-object revoke below cleans up what already exists.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('postgres', 'supabase_admin')
    LOOP
        BEGIN
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM amisibiz_app',
                r.rolname);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM amisibiz_app',
                r.rolname);
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping default-privilege cleanup for role % (not administrable by the migration role)', r.rolname;
        END;
    END LOOP;

    -- The migration role's own defaults (the common case).
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM amisibiz_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM amisibiz_app';
END
$$;

-- (b) Revoke `amisibiz_app` everywhere in public, then grant back exactly the
-- AmisiBiz tables. This is what removes the other application's tables and
-- sequences from our runtime role's reach, and what makes the final
-- privilege list auditable: after this file it contains only AmisiBiz
-- objects. Views/matviews are included in the revoke (a view over our tables
-- would otherwise be a policy bypass).
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM amisibiz_app', r.relname);
    END LOOP;
END
$$;

-- (c) Exact grants. Verb lists are the ceiling the application can use; RLS
-- policies narrow within them.
GRANT SELECT, INSERT, UPDATE                     ON "Tenant"                 TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "TenantSettings"         TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "TenantBranding"         TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "TenantDomain"           TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "User"                   TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE             ON "TenantMember"           TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "Invitation"             TO amisibiz_app;
GRANT SELECT, INSERT                             ON "AuditLog"               TO amisibiz_app;
GRANT SELECT, INSERT                             ON "TenantStatusHistory"    TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "SupportAccessGrant"     TO amisibiz_app;
GRANT SELECT                                     ON "Permission"             TO amisibiz_app;
GRANT SELECT                                     ON "RolePermission"         TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE             ON "TaxCategory"            TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE             ON "TaxRate"                TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "Contact"                TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE             ON "ContactAddress"         TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "Item"                   TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE             ON "ContactItem"            TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE             ON "Document"               TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE             ON "DocumentLine"           TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "DocumentPayment"        TO amisibiz_app;
GRANT SELECT, INSERT                             ON "DocumentStatusEvent"    TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "DocumentNumbering"      TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE                     ON "DocumentNumberSequence" TO amisibiz_app;

-- No sequence grants at all: every id is a UUID default, and the numbering
-- counters are rows, not sequences. (Other applications' sequences were
-- revoked in (b) and are not re-granted.)

-- (d) `anon` / `authenticated` are PostgREST roles — the AmisiBiz runtime
-- never uses them, and tables reachable through the REST API must not carry
-- privileges that only RLS silently denies. Revoke on AmisiBiz tables only;
-- other applications' grants are their business.
DO $$
DECLARE
    r      record;
    t      text;
    v_amisi text[] := ARRAY[
        'Tenant', 'TenantSettings', 'TenantBranding', 'TenantDomain', 'User',
        'TenantMember', 'Invitation', 'AuditLog', 'TenantStatusHistory',
        'SupportAccessGrant', 'Permission', 'RolePermission',
        'TaxCategory', 'TaxRate', 'Contact', 'ContactAddress', 'Item',
        'ContactItem', 'Document', 'DocumentLine', 'DocumentPayment',
        'DocumentStatusEvent', 'DocumentNumbering', 'DocumentNumberSequence'
    ];
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    LOOP
        FOREACH t IN ARRAY v_amisi
        LOOP
            EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r.rolname);
        END LOOP;
    END LOOP;
END
$$;

-- ─── Comments ────────────────────────────────────────────────────────────────

COMMENT ON FUNCTION public.has_tenant_read_access(uuid) IS 'Read family: tenant context + non-portal membership, platform admin, or support with an active grant.';
COMMENT ON FUNCTION public.has_tenant_write_access(uuid) IS 'Write family: tenant context + a writing role (owner/admin/sales/finance/operations), or platform admin. Support is deliberately absent — read-only at the database level.';
COMMENT ON FUNCTION public.has_tenant_admin_access(uuid) IS 'Admin family: tenant context + owner/admin, or platform admin. Settings, branding, memberships, invitations, audit reads.';
COMMENT ON FUNCTION public.app_is_tenant_creator(uuid) IS 'The registration anchor: actor provisioned this tenant and it is still PENDING.';
COMMENT ON FUNCTION public.app_find_user_id_by_email(text) IS 'Narrow pre-context lookup (id + status) for auth flows; the only email-keyed read the runtime role holds.';
COMMENT ON FUNCTION public.set_tenant_context(text, text, text, boolean, boolean) IS 'Sets all five request-context GUCs transaction-locally; every key is written on every call so a pooled connection can never inherit a previous context.';
