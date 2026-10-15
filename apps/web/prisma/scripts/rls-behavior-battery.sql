-- Phase 1/2 RLS behaviour battery — the committed, reproducible proof.
-- Runs as `amisibiz_app` (SET LOCAL ROLE) against a database that has had the
-- migrations applied on top of prisma/scripts/fixtures/phase1-legacy-fixture.sql
-- (the alpha/beta tenants and the six fixture users are what this reads).
-- Mirrors the eight required tests at the database layer: no-context deny,
-- cross-tenant cloaking, viewer write ban, portal exclusion, self-elevation
-- refusal, forged tenant ids, registration and invitation paths, support grants,
-- storage policies, and the app_find_user_id_by_email helper.
--
--   psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DB" -q -f \
--     apps/web/prisma/scripts/rls-behavior-battery.sql
--
-- It is re-runnable on the same database (see the purge block below) and prints
-- one PASS/FAIL line per assertion; grep the output for FAIL.
-- Run it AFTER prisma/scripts/phase01-migration-checks.sql, because it inserts
-- rows, and expect ~67 PASS lines.
\pset pager off
\set ON_ERROR_STOP on

-- ── Fixtures and re-run hygiene (owner, before any role switch) ─────────────
-- The battery must be re-runnable on the same database: purge the state a
-- previous run created (the fresh-registration user/tenant and the invitation
-- self-join) before re-testing those paths. Two guards are paused for this
-- owner-level cleanup only — the last-owner delete guard (the registration
-- user is the lone owner of its test tenant) and the append-only trigger on
-- TenantStatusHistory (the rows purged are test residue, not tenant history).
ALTER TABLE "TenantMember" DISABLE TRIGGER tenant_members_guard_delete;
ALTER TABLE "TenantStatusHistory" DISABLE TRIGGER tenant_status_history_is_append_only;
DELETE FROM "TenantMember"
 WHERE "tenantId" IN (SELECT id FROM "Tenant" WHERE slug='fresh')
    OR ("userId"='e5e5e5e5-5555-4555-8555-555555555555'
        AND "tenantId" IN (SELECT id FROM "Tenant" WHERE slug='alpha'));
DELETE FROM "Contact"             WHERE "tenantId" IN (SELECT id FROM "Tenant" WHERE slug='fresh');
DELETE FROM "TenantStatusHistory" WHERE "tenantId" IN (SELECT id FROM "Tenant" WHERE slug='fresh');
DELETE FROM "TenantSettings"      WHERE "tenantId" IN (SELECT id FROM "Tenant" WHERE slug='fresh');
DELETE FROM "TenantBranding"      WHERE "tenantId" IN (SELECT id FROM "Tenant" WHERE slug='fresh');
DELETE FROM "TenantDomain"        WHERE "tenantId" IN (SELECT id FROM "Tenant" WHERE slug='fresh');
DELETE FROM "Tenant"              WHERE slug='fresh';
DELETE FROM "User"                WHERE email='fresh.f@example.com';
-- A support grant left active by an interrupted run would mask T9a.
DELETE FROM "SupportAccessGrant"  WHERE "reason" LIKE 'Battery:%';
ALTER TABLE "TenantStatusHistory" ENABLE TRIGGER tenant_status_history_is_append_only;
ALTER TABLE "TenantMember" ENABLE TRIGGER tenant_members_guard_delete;

-- u5 gets a portal seat in tenant B (the portal-exclusion test needs one).
INSERT INTO "TenantMember" ("id","tenantId","userId","role","isDefault","joinedAt","updatedAt")
SELECT gen_random_uuid(), id, 'e5e5e5e5-5555-4555-8555-555555555555', 'CUSTOMER_PORTAL_USER', false, now(), now()
  FROM "Tenant" WHERE slug='beta'
ON CONFLICT DO NOTHING;

-- Resolve ids as owner (before any role switch).
SELECT id AS ta FROM "Tenant" WHERE slug='alpha'; \gset
SELECT id AS tb FROM "Tenant" WHERE slug='beta';  \gset
SELECT id AS u1 FROM "User" WHERE email='owner.a@example.com'; \gset
SELECT id AS u2 FROM "User" WHERE email='owner.b@example.com'; \gset
SELECT id AS u3 FROM "User" WHERE email='member.c@example.com'; \gset
SELECT id AS u4 FROM "User" WHERE email='support.d@example.com'; \gset
SELECT id AS u5 FROM "User" WHERE email='invitee@example.com'; \gset
SELECT id AS u6 FROM "User" WHERE email='owner.e@example.com'; \gset

-- psql does not interpolate variables inside DO-block bodies, so the ids are
-- parked in session GUCs instead and read with current_setting() everywhere
-- (cast to uuid where the column is uuid — PostgreSQL has no text→uuid cast).
SELECT set_config('test.ta', :'ta', false);
SELECT set_config('test.tb', :'tb', false);
SELECT set_config('test.u1', :'u1', false);
SELECT set_config('test.u2', :'u2', false);
SELECT set_config('test.u3', :'u3', false);
SELECT set_config('test.u4', :'u4', false);
SELECT set_config('test.u5', :'u5', false);
SELECT set_config('test.u6', :'u6', false);

\echo '=== T1: no context — deny everything ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Tenant";      RAISE NOTICE 'T1a tenants visible: % (%)', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Contact";     RAISE NOTICE 'T1b contacts visible: % (%)', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Document";    RAISE NOTICE 'T1c documents visible: % (%)', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "User";        RAISE NOTICE 'T1d users visible: % (%)', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "AuditLog";    RAISE NOTICE 'T1e audit visible: % (%)', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;
DO $$
BEGIN
    BEGIN
        INSERT INTO "Contact" ("id","tenantId","type","status","firstName","createdAt","updatedAt")
        VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, 'INDIVIDUAL', 'ACTIVE', 'Anon', now(), now());
        RAISE NOTICE 'T1f anon insert: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T1f anon insert denied: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

\echo '=== T2: tenant A through u6 — a plain owner, no platform role, no seat in B ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u6'), 'TENANT_OWNER', false, false);
DO $$
DECLARE n bigint; ok text;
BEGIN
    SELECT count(*) INTO n FROM "Tenant";  RAISE NOTICE 'T2a tenants visible: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Tenant" WHERE slug='beta'; RAISE NOTICE 'T2b tenant B cloaked: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Contact"; RAISE NOTICE 'T2c contacts (A only): % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Document"; RAISE NOTICE 'T2d documents (A only): % (expect 3) %', n, CASE WHEN n=3 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "DocumentPayment"; RAISE NOTICE 'T2e payments (A only): % (expect 2) %', n, CASE WHEN n=2 THEN 'PASS' ELSE 'FAIL' END;

    -- Reading tenant B's contact directly by id: invisible.
    SELECT count(*) INTO n FROM "Contact" WHERE "tenantId" = current_setting('test.tb')::uuid;
    RAISE NOTICE 'T2f B contacts via direct filter: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;

    -- Mutating a B row by id: 0 rows affected.
    UPDATE "Contact" SET notes='pwned' WHERE "tenantId" = current_setting('test.tb')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'T2g B contact update rows: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;

    -- Owner write inside A works.
    UPDATE "Contact" SET notes='checked' WHERE email='sales@acme.example';
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'T2h A contact update rows: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- Forged tenant id on insert (write A row claiming B).
DO $$
BEGIN
    BEGIN
        INSERT INTO "Contact" ("id","tenantId","type","status","firstName","createdAt","updatedAt")
        VALUES (gen_random_uuid(), current_setting('test.tb')::uuid, 'INDIVIDUAL', 'ACTIVE', 'Forged', now(), now());
        RAISE NOTICE 'T2i forged insert: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T2i forged insert denied: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;

-- Re-tenant an A row into B: the WITH CHECK refuses.
DO $$
BEGIN
    BEGIN
        UPDATE "Contact" SET "tenantId" = current_setting('test.tb')::uuid WHERE email='sales@acme.example';
        RAISE NOTICE 'T2j retenant update: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T2j retenant update denied: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;

-- Allocation works for a writing role (and the sequence really moves).
DO $$
DECLARE v_number text;
BEGIN
    v_number := public.allocate_document_number(current_setting('test.ta')::uuid, 'INVOICE', '2026-04-01');
    RAISE NOTICE 'T2k allocation as owner: % (%)', v_number, CASE WHEN v_number LIKE 'INV-2026-%' THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- Audit append works in any context; viewer audit read is separate (T3).
INSERT INTO "AuditLog" ("id","tenantId","userId","action","createdAt")
VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, current_setting('test.u6')::uuid, 'battery.check', now());
COMMIT;

-- The platform-administrator assertion is "sees every row in the database", not
-- "sees two rows". The clean-room chain re-runs this battery on top of the
-- Phase 2 fixtures, whose extra tenants and contacts a SUPER_ADMIN is also
-- meant to reach, so a hard-coded 2 would fail for the wrong reason. Snapshot
-- the unfiltered totals while still the table owner (an owner bypasses RLS) and
-- require the runtime role to match them exactly — one hidden row and one
-- over-reachable row both fail.
SELECT set_config('test.all_tenants', (SELECT count(*)::text FROM "Tenant"), false);
SELECT set_config('test.all_contacts', (SELECT count(*)::text FROM "Contact"), false);

-- Platform reach is real but database-derived: u1 is SUPER_ADMIN in `User`, and
-- the context above claims the opposite. Policies ask the database, so the
-- claim is irrelevant — and the platform operator still sees across tenants.
\echo '=== T2L: platform administrator sees across tenants (DB-derived authority) ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u1'), 'TENANT_OWNER', false, false);
DO $$
DECLARE n bigint; expect bigint;
BEGIN
    expect := current_setting('test.all_tenants')::bigint;
    SELECT count(*) INTO n FROM "Tenant";
    RAISE NOTICE 'T2L-a platform tenant visibility: % (expect all % rows) %', n, expect, CASE WHEN n=expect AND expect>=2 THEN 'PASS' ELSE 'FAIL' END;
    expect := current_setting('test.all_contacts')::bigint;
    SELECT count(*) INTO n FROM "Contact";
    RAISE NOTICE 'T2L-b platform contact visibility: % (expect all % rows) %', n, expect, CASE WHEN n=expect AND expect>=2 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo '=== T3: viewer (u3 in A) — no writes, no issuing, audit hidden ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u3'), 'VIEWER', false, false);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Contact"; RAISE NOTICE 'T3a viewer reads contacts: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "AuditLog"; RAISE NOTICE 'T3b viewer audit hidden: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;
DO $$
BEGIN
    BEGIN
        INSERT INTO "Document" ("id","tenantId","type","status","issueDate","roundingPolicy","createdAt","updatedAt")
        VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, 'QUOTATION', 'DRAFT', now(), 'half-up-per-line-v1', now(), now());
        RAISE NOTICE 'T3c viewer document insert: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T3c viewer document insert denied: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
DO $$
BEGIN
    BEGIN
        PERFORM public.allocate_document_number(current_setting('test.ta')::uuid, 'INVOICE', '2026-05-01');
        RAISE NOTICE 'T3d viewer allocation: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T3d viewer allocation refused: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
DO $$
DECLARE n bigint;
BEGIN
    -- RLS cloaks rather than raises on UPDATE: a viewer cannot even see the
    -- row for writing, so the statement affects zero rows instead of erroring.
    -- Assert the effect, not the mechanism.
    UPDATE "Contact" SET notes='viewer-edit' WHERE email='sales@acme.example';
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'T3e viewer contact update rows: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo '=== T4: customer portal user (u5 in B) — internal records invisible ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.tb'), current_setting('test.u5'), 'CUSTOMER_PORTAL_USER', false, false);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Contact"; RAISE NOTICE 'T4a portal contacts: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Item";    RAISE NOTICE 'T4b portal items: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Document";RAISE NOTICE 'T4c portal documents: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "AuditLog";RAISE NOTICE 'T4d portal audit: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "TenantStatusHistory"; RAISE NOTICE 'T4e portal status history: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Tenant" WHERE id = current_setting('test.tb')::uuid; RAISE NOTICE 'T4f own tenant shell visible: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo '=== T5: self-elevation refusals ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u3'), 'VIEWER', false, false);
DO $$
DECLARE n bigint;
BEGIN
    -- Viewer: the membership row is not updatable at all (RLS → 0 rows).
    UPDATE "TenantMember" SET role='TENANT_OWNER' WHERE "userId"=current_setting('test.u3')::uuid AND "tenantId"=current_setting('test.ta')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'T5a viewer self-promote rows: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;

    BEGIN
        UPDATE "User" SET "platformRole"='SUPER_ADMIN' WHERE id=current_setting('test.u3')::uuid;
        RAISE NOTICE 'T5b platform self-promote: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T5b platform self-promote refused: PASS (sqlstate %)', SQLSTATE;
    END;
    BEGIN
        UPDATE "User" SET "sessionVersion"="sessionVersion"+1 WHERE id=current_setting('test.u3')::uuid;
        RAISE NOTICE 'T5c own session increment: PASS (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T5c own session increment: FAIL (denied: %)', SQLERRM;
    END;
    BEGIN
        UPDATE "User" SET "sessionVersion"="sessionVersion"+1 WHERE id=current_setting('test.u1')::uuid;
        RAISE NOTICE 'T5d bumping another user: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T5d bumping another user refused: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

-- The trigger layer, reached when the policy WOULD allow the write: an owner
-- may not change even their own role.
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u6'), 'TENANT_OWNER', false, false);
DO $$
BEGIN
    BEGIN
        UPDATE "TenantMember" SET role='TENANT_ADMIN' WHERE "userId"=current_setting('test.u6')::uuid AND "tenantId"=current_setting('test.ta')::uuid;
        RAISE NOTICE 'T5e owner self-demote: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T5e owner self-demote refused: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

\echo '=== T5f: self-removal refused at the trigger (policy would allow an owner) ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u6'), 'TENANT_OWNER', false, false);
DO $$
BEGIN
    BEGIN
        DELETE FROM "TenantMember" WHERE "userId"=current_setting('test.u6')::uuid AND "tenantId"=current_setting('test.ta')::uuid;
        RAISE NOTICE 'T5f self-removal: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T5f self-removal refused: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

-- Context flags are advisory: a writer that claims platform admin in the GUC
-- still gets nothing it has not been granted in the database.
\echo '=== T5g: a forged platform-admin context flag grants no extra reach ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u3'), 'VIEWER', true, true);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Contact" WHERE "tenantId" = current_setting('test.tb')::uuid;
    RAISE NOTICE 'T5g claiming admin/support, tenant B contacts: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    BEGIN
        INSERT INTO "SupportAccessGrant" ("id","tenantId","platformUserId","grantedById","reason","expiresAt","createdAt")
        VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, current_setting('test.u3')::uuid, current_setting('test.u3')::uuid, 'Battery: self-issued support grant', now() + interval '1 hour', now());
        RAISE NOTICE 'T5h self-issued support grant: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T5h self-issued support grant refused: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

\echo '=== T6: audit appends in every internal context; read-back stays privileged ==='
-- AuditLog is append-only by design: `INSERT WITH CHECK (true)` so a sales
-- role can record what it did, while listing audit rows stays an owner/admin,
-- platform-admin or granted-support privilege.
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u2'), 'SALES', false, false);
DO $$
DECLARE n bigint;
BEGIN
    INSERT INTO "AuditLog" ("id","tenantId","userId","action","createdAt")
    VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, current_setting('test.u2')::uuid, 'battery.sales.append', now());
    RAISE NOTICE 'T6a sales audit append: PASS';

    SELECT count(*) INTO n FROM "AuditLog";
    RAISE NOTICE 'T6b sales audit read-back: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

-- The row is durably there — it is simply not listable by the writer. That is
-- also why the application must never ask for an audit row back after writing
-- it (an ORM `create()` issues INSERT … RETURNING, and RETURNING is filtered by
-- the SELECT policy: a returning read-back would abort the whole business
-- transaction).
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u6'), 'TENANT_OWNER', false, false);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "AuditLog" WHERE "action"='battery.sales.append';
    RAISE NOTICE 'T6c owner reads the appended row: % (expect >=1) %', n, CASE WHEN n>=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo '=== T7: registration flow (fresh user, no memberships yet) ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(NULL, 'f6f6f6f6-6666-4666-8666-666666666666', NULL, false, false);
DO $$
DECLARE v_tid uuid;
BEGIN
    INSERT INTO "User" ("id","name","email","status","createdAt","updatedAt")
    VALUES ('f6f6f6f6-6666-4666-8666-666666666666', 'Fresh F', 'fresh.f@example.com', 'ACTIVE', now(), now());
    RAISE NOTICE 'T7a self insert: PASS';

    INSERT INTO "Tenant" ("id","name","slug","status","createdById","createdAt","updatedAt")
    VALUES (gen_random_uuid(), 'Fresh Ltd', 'fresh', 'PENDING', 'f6f6f6f6-6666-4666-8666-666666666666', now(), now())
    RETURNING id INTO v_tid;
    RAISE NOTICE 'T7b PENDING tenant create: PASS (%)', v_tid;

    INSERT INTO "TenantSettings" ("id","tenantId","createdAt","updatedAt") VALUES (gen_random_uuid(), v_tid, now(), now());
    INSERT INTO "TenantBranding" ("id","tenantId","createdAt","updatedAt") VALUES (gen_random_uuid(), v_tid, now(), now());
    INSERT INTO "TenantDomain" ("id","tenantId","hostname","isPrimary","createdAt") VALUES (gen_random_uuid(), v_tid, 'fresh.example.com', true, now());
    RAISE NOTICE 'T7c settings/branding/domain via creator anchor: PASS';

    INSERT INTO "TenantStatusHistory" ("id","tenantId","fromStatus","toStatus","createdAt")
    VALUES (gen_random_uuid(), v_tid, NULL, 'PENDING', now());
    RAISE NOTICE 'T7d status history initial row: PASS';

    INSERT INTO "TenantMember" ("id","tenantId","userId","role","isDefault","joinedAt","updatedAt")
    VALUES (gen_random_uuid(), v_tid, 'f6f6f6f6-6666-4666-8666-666666666666', 'TENANT_OWNER', true, now(), now());
    RAISE NOTICE 'T7e owner membership via creator anchor: PASS';

    PERFORM public.set_tenant_context(v_tid::text, 'f6f6f6f6-6666-4666-8666-666666666666', 'TENANT_OWNER', false, false);
    INSERT INTO "Contact" ("id","tenantId","type","status","firstName","createdAt","updatedAt")
    VALUES (gen_random_uuid(), v_tid, 'INDIVIDUAL', 'ACTIVE', 'Fresh Contact', now(), now());
    RAISE NOTICE 'T7f first contact under new tenant: PASS';
END $$;

-- Negative: the creator anchor must NOT grant owner seats in someone else's tenant.
DO $$
BEGIN
    BEGIN
        INSERT INTO "TenantMember" ("id","tenantId","userId","role","isDefault","joinedAt","updatedAt")
        VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, 'f6f6f6f6-6666-4666-8666-666666666666', 'TENANT_OWNER', false, now(), now());
        RAISE NOTICE 'T7g foreign owner seat: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T7g foreign owner seat refused: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

\echo '=== T8: invitation acceptance (u5 into tenant A) ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(NULL, current_setting('test.u5'), NULL, false, false);
DO $$
DECLARE n bigint;
BEGIN
    -- Recipient reads the invitation by verified email match.
    SELECT count(*) INTO n FROM "Invitation" WHERE "tokenHash"='tokenhash_invite_1';
    RAISE NOTICE 'T8a recipient sees invitation: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;

    -- Recipient-side change: status/acceptedAt only.
    UPDATE "Invitation" SET status='ACCEPTED', "acceptedAt"=now() WHERE "tokenHash"='tokenhash_invite_1';
    RAISE NOTICE 'T8b accept invitation: PASS';

    -- Self-join with role matching the accepted invitation.
    INSERT INTO "TenantMember" ("id","tenantId","userId","role","isDefault","joinedAt","updatedAt")
    VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, current_setting('test.u5')::uuid, 'VIEWER', false, now(), now());
    RAISE NOTICE 'T8c membership via accepted invitation: PASS';
END $$;
DO $$
BEGIN
    BEGIN
        UPDATE "Invitation" SET "role"='TENANT_OWNER' WHERE "tokenHash"='tokenhash_invite_1';
        RAISE NOTICE 'T8d recipient rewrites role: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T8d recipient rewrites role refused: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

\echo '=== T9: support access — no grant, grant, revoke, expiry ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u4'), 'VIEWER', false, true);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Contact"; RAISE NOTICE 'T9a support w/o grant contacts: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

-- Grant as platform admin (u1 holds SUPER_ADMIN).
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u1'), 'TENANT_OWNER', true, false);
DO $$
BEGIN
    INSERT INTO "SupportAccessGrant" ("id","tenantId","platformUserId","grantedById","reason","expiresAt","createdAt")
    VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, current_setting('test.u4')::uuid, current_setting('test.u1')::uuid, 'Battery: verify read-only support path', now() + interval '1 hour', now());
    RAISE NOTICE 'T9b active grant created: PASS';
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u4'), 'VIEWER', false, true);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Contact"; RAISE NOTICE 'T9c support w/ grant contacts: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Item";    RAISE NOTICE 'T9d support w/ grant items: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "AuditLog";RAISE NOTICE 'T9e support w/ grant audit: % (>=1) %', n, CASE WHEN n>=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
DO $$
BEGIN
    BEGIN
        INSERT INTO "Contact" ("id","tenantId","type","status","firstName","createdAt","updatedAt")
        VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, 'INDIVIDUAL', 'ACTIVE', 'Support write', now(), now());
        RAISE NOTICE 'T9f support write: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T9f support write denied: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
COMMIT;

-- Revoke, then a fresh session must be back to zero.
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u1'), 'TENANT_OWNER', true, false);
DO $$
DECLARE n bigint;
BEGIN
    UPDATE "SupportAccessGrant" SET "revokedAt"=now() WHERE "platformUserId"=current_setting('test.u4')::uuid AND "revokedAt" IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'T9g grant revoked: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u4'), 'VIEWER', false, true);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Contact"; RAISE NOTICE 'T9h after revoke contacts: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

-- ── Task #50: the grant is necessary but no longer sufficient ────────────────
-- Migration 20261021000000 fences the SUPPORT branch of `has_tenant_read_access`
-- with the active tenant context. These cases pin all three postures that branch
-- can be in, so the tightening cannot silently regress.

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u1'), 'TENANT_OWNER', true, false);
DO $$
BEGIN
    INSERT INTO "SupportAccessGrant" ("id","tenantId","platformUserId","grantedById","reason","expiresAt","createdAt")
    VALUES (gen_random_uuid(), current_setting('test.ta')::uuid, current_setting('test.u4')::uuid, current_setting('test.u1')::uuid, 'Battery: context scoping proof', now() + interval '1 hour', now());
    RAISE NOTICE 'T9i grant on A re-issued: PASS';
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE amisibiz_app;
-- u4 claims tenant B while its only live grant is on A. Before #50 this session
-- read A's rows under a B label; the only correct answer now is nothing at all,
-- because B was never granted either.
SELECT public.set_tenant_context(current_setting('test.tb'), current_setting('test.u4'), 'VIEWER', false, true);
DO $$
DECLARE n bigint; fenced boolean;
BEGIN
    SELECT count(*) INTO n FROM "Contact";
    -- The clean-room driver runs this same battery twice on purpose: once against
    -- the frozen 1..11 chain, where this branch is still loose by construction,
    -- and once after the tree's follow-up migrations, where the fence must hold.
    -- `app.support_context_fenced` says which of those schemas is under test
    -- (PGOPTIONS in scripts/db/cleanroom-chain.sh); unset means "the current
    -- tree", so a hand-run battery asserts the fence.
    fenced := COALESCE(current_setting('app.support_context_fenced', true), 'true') <> 'false';
    IF fenced THEN
        RAISE NOTICE 'T9j grant on A, context B: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    ELSE
        -- A historical probe is not a free pass: even with the loose branch, the
        -- GRANT still bounds what a support session can reach. Seeing more than
        -- the one granted workspace's rows here is a real failure either way.
        RAISE NOTICE 'T9j grant on A, context B: % (SKIP - pre-fence schema; grant still bounds it to 1) %', n, CASE WHEN n <= 1 THEN 'OK' ELSE 'FAIL' END;
    END IF;
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE amisibiz_app;
-- No tenant context is the provider console's own posture while it lists the
-- workspaces it may enter (packages/database/src/scope.ts keeps tenantId null
-- there). The granted workspace stays listed; entering it sets the context and
-- the row fence above applies.
SELECT public.set_tenant_context(NULL, current_setting('test.u4'), NULL, false, true);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Contact";
    RAISE NOTICE 'T9k grant on A, no context: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Tenant";
    RAISE NOTICE 'T9l granted workspace listed: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

-- Leave no live grant behind (the purge block at the top is the backstop).
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(current_setting('test.ta'), current_setting('test.u1'), 'TENANT_OWNER', true, false);
DO $$
DECLARE n bigint;
BEGIN
    UPDATE "SupportAccessGrant" SET "revokedAt"=now() WHERE "platformUserId"=current_setting('test.u4')::uuid AND "revokedAt" IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'T9m context proof grant revoked: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo '=== T10: storage policies (authenticated, JWT-sub simulation) ==='
-- Reset and plant the foreign-tenant object as the owner (bypasses RLS — it
-- models an object another tenant uploaded earlier).
DELETE FROM storage.objects WHERE bucket_id = 'tenant-branding';
INSERT INTO storage.objects (bucket_id, name)
VALUES ('tenant-branding', 'tenants/'||current_setting('test.tb')::uuid||'/logo/'||repeat('ef', 16)||'.png');

BEGIN;
SET LOCAL ROLE authenticated;
-- u6 is a member of tenant A only, so tenant B's object must stay foreign.
SELECT set_config('request.jwt.claim.sub', current_setting('test.u6'), true);
DO $$
DECLARE n bigint;
BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('tenant-branding', 'tenants/'||current_setting('test.ta')::uuid||'/logo/'||repeat('ab', 16)||'.png', current_setting('test.u6')::uuid);
    RAISE NOTICE 'T10a member insert own-tenant logo: PASS';
END $$;
DO $$
BEGIN
    BEGIN
        INSERT INTO storage.objects (bucket_id, name, owner)
        VALUES ('tenant-branding', 'tenants/11111111-2222-4333-8444-555555555555/logo/'||repeat('cd', 16)||'.png', current_setting('test.u6')::uuid);
        RAISE NOTICE 'T10b foreign-tenant insert: FAIL (allowed)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'T10b foreign-tenant insert denied: PASS (sqlstate %)', SQLSTATE;
    END;
END $$;
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM storage.objects WHERE name LIKE 'tenants/'||current_setting('test.tb')::uuid||'/%';
    RAISE NOTICE 'T10c foreign-tenant object invisible: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM storage.objects WHERE name LIKE 'tenants/'||current_setting('test.ta')::uuid||'/%';
    RAISE NOTICE 'T10d own-tenant object visible: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo '=== T11: pre-context email lookup stays narrow ==='
BEGIN;
SET LOCAL ROLE amisibiz_app;
DO $$
DECLARE n bigint; v_status "UserStatus";
BEGIN
    SELECT count(*) INTO n FROM public.app_find_user_id_by_email('owner.a@example.com');
    RAISE NOTICE 'T11a lookup by email: % (expect 1) %', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM public.app_find_user_id_by_email('nobody@example.com');
    RAISE NOTICE 'T11b unknown email: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "User";
    RAISE NOTICE 'T11c raw User table still closed: % (expect 0) %', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo '=== battery complete ==='
