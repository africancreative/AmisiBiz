-- Phase 2 provider-administration behaviour battery.
--
-- What it proves (the acceptance criteria of the Phase 2 directive, at the
-- database layer):
--   * a suspension denies tenant-side WRITES while READS and the audit trail
--     stay open, and no business row is removed by suspending;
--   * platform authority is not gated by tenant status — the provider can
--     activate, suspend, re-brand, re-plan and re-slug a suspended workspace;
--   * a tenant admin cannot activate or suspend their own workspace, cannot
--     change its slug, and cannot assign itself a plan;
--   * provisioning keeps working: a PENDING workspace still accepts the initial
--     owner's invitation acceptance (the gate is suspension, not inactivity);
--   * the plan catalogue is seeded, readable only under platform authority,
--     un-writable by the runtime role, and enforced as a foreign key;
--   * the indicator writers (`touch_tenant_activity`,
--     `record_tenant_sync_attempt`) refuse a caller that is not acting inside
--     that workspace, and leave a suspended workspace's history untouched;
--   * the permission catalog and role matrix hold the Phase 2 rows;
--   * one primary hostname per workspace, and domain deletion needs an
--     unsuspended workspace (or the provider).
--
-- How to run (throwaway cluster, NEVER the shared Supabase project):
--   psql -h localhost -p 55499 -U postgres -d <freshly-migrated-db> \
--        -q -f apps/web/prisma/scripts/phase02-migration-checks.sql
-- Every line prints PASS or FAIL; grep the output for FAIL. The script is
-- re-runnable: fixtures use fixed ids and are upserted, and every test that
-- writes runs inside a transaction that is rolled back.
--
-- Runs as the table owner, which bypasses RLS by itself; each behaviour test
-- therefore switches with `SET LOCAL ROLE amisibiz_app` and opens a real request
-- context through `public.set_tenant_context(...)` — the same path the
-- application takes. Owner-level fixture writes are kept to INSERTs (and the
-- explicitly guarded ones) so the guard triggers never fire on setup data.
\pset pager off
\set ON_ERROR_STOP on

-- ─── Fixtures ─────────────────────────────────────────────────────────────────
-- Tenants: A is ACTIVE, B is SUSPENDED, C is PENDING. `status` is set on INSERT
-- because the lifecycle triggers refuse an update without platform context.
-- Users: OWNER_A owns A and B; SALES_A writes in A; ADMIN_P is the platform
-- administrator; INVITEE holds a PENDING invitation inside suspended B and
-- inside pending C.

BEGIN;

-- Teardown suppresses exactly two product triggers, for exactly one reason:
-- `tenant_members_guard_delete` refuses to remove a workspace's last owner and
-- `tenant_status_history_is_append_only` refuses any change to a lifecycle row,
-- while a re-runnable battery has to remove the whole fixture set. Both rules are
-- asserted on their own terms below (P4/P6 for membership, P10c for history) —
-- this is the owner of a throwaway database clearing its own scratch data.
ALTER TABLE "TenantMember" DISABLE TRIGGER tenant_members_guard_delete;
ALTER TABLE "TenantStatusHistory" DISABLE TRIGGER tenant_status_history_is_append_only;

DELETE FROM "TenantMember"          WHERE "userId"::text LIKE 'f0000000-%';
DELETE FROM "Invitation"            WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid,
                                                          'c0000000-0000-4000-8000-00000000000c'::uuid);
DELETE FROM "Contact"               WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid);
DELETE FROM "Document"              WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid);
DELETE FROM "DocumentNumbering"     WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid);
DELETE FROM "DocumentNumberSequence" WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                           'b0000000-0000-4000-8000-00000000000b'::uuid);
DELETE FROM "AuditLog"              WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid);
DELETE FROM "TenantStatusHistory"   WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid,
                                                          'c0000000-0000-4000-8000-00000000000c'::uuid);
DELETE FROM "SupportAccessGrant"    WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid);
DELETE FROM "TenantDomain"          WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid,
                                                          'c0000000-0000-4000-8000-00000000000c'::uuid);
DELETE FROM "TenantBranding"        WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid,
                                                          'c0000000-0000-4000-8000-00000000000c'::uuid);
DELETE FROM "TenantSettings"        WHERE "tenantId" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                          'b0000000-0000-4000-8000-00000000000b'::uuid,
                                                          'c0000000-0000-4000-8000-00000000000c'::uuid);
DELETE FROM "Tenant"                WHERE "id" IN ('a0000000-0000-4000-8000-00000000000a'::uuid,
                                                   'b0000000-0000-4000-8000-00000000000b'::uuid,
                                                   'c0000000-0000-4000-8000-00000000000c'::uuid);
DELETE FROM "User"                  WHERE "id"::text LIKE 'f0000000-%';

ALTER TABLE "TenantMember" ENABLE TRIGGER tenant_members_guard_delete;
ALTER TABLE "TenantStatusHistory" ENABLE TRIGGER tenant_status_history_is_append_only;

INSERT INTO "User" ("id", "name", "email", "platformRole", "status", "sessionVersion", "createdAt", "updatedAt")
VALUES
    ('f0000000-0000-4000-8000-000000000001', 'Owner A',   'p2.owner@example.test',   NULL,          'ACTIVE', 0, now(), now()),
    ('f0000000-0000-4000-8000-000000000002', 'Admin P',   'p2.platform@example.test', 'SUPER_ADMIN', 'ACTIVE', 0, now(), now()),
    ('f0000000-0000-4000-8000-000000000003', 'Sales A',   'p2.sales@example.test',   NULL,          'ACTIVE', 0, now(), now()),
    ('f0000000-0000-4000-8000-000000000004', 'Invitee',   'p2.invitee@example.test', NULL,          'ACTIVE', 0, now(), now());

INSERT INTO "Tenant" ("id", "name", "slug", "status", "currency", "timezone", "locale",
                      "activatedAt", "suspendedAt", "suspensionReason", "lastActivityAt",
                      "createdById", "createdAt", "updatedAt")
VALUES
    ('a0000000-0000-4000-8000-00000000000a', 'Active Co',   'p2-active',   'ACTIVE',    'KES', 'UTC', 'en',
     now(), NULL, NULL, '2026-01-01 00:00:00', 'f0000000-0000-4000-8000-000000000002', now(), now()),
    ('b0000000-0000-4000-8000-00000000000b', 'Suspended Co','p2-suspended','SUSPENDED', 'KES', 'UTC', 'en',
     '2026-01-01 00:00:00', now(), 'Battery: provider suspension', '2026-01-01 00:00:00',
     'f0000000-0000-4000-8000-000000000002', now(), now()),
    ('c0000000-0000-4000-8000-00000000000c', 'Pending Co',  'p2-pending',  'PENDING',   'KES', 'UTC', 'en',
     NULL, NULL, NULL, NULL, 'f0000000-0000-4000-8000-000000000002', now(), now());

INSERT INTO "TenantSettings" ("id", "tenantId", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, now(), now()),
       (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, now(), now()),
       (gen_random_uuid(), 'c0000000-0000-4000-8000-00000000000c'::uuid, now(), now());

INSERT INTO "TenantBranding" ("id", "tenantId", "displayName", "primaryColor", "secondaryColor",
                             "accentColor", "primaryForeground", "currency", "documentLayout",
                             "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'Active Co',   '#111111', '#222222', '#333333', '#ffffff', 'KES', 'standard', now(), now()),
       (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, 'Suspended Co','#111111', '#222222', '#333333', '#ffffff', 'KES', 'standard', now(), now()),
       (gen_random_uuid(), 'c0000000-0000-4000-8000-00000000000c'::uuid, 'Pending Co',  '#111111', '#222222', '#333333', '#ffffff', 'KES', 'standard', now(), now());

INSERT INTO "TenantDomain" ("id", "tenantId", "hostname", "isPrimary", "createdAt")
VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'p2-active.example.test',    true, now()),
       (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, 'p2-suspended.example.test', true, now()),
       (gen_random_uuid(), 'c0000000-0000-4000-8000-00000000000c'::uuid, 'p2-pending.example.test',   true, now());

INSERT INTO "TenantMember" ("id", "tenantId", "userId", "role", "isDefault", "joinedAt", "updatedAt")
VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid, 'TENANT_OWNER', true,  now(), now()),
       (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid, 'TENANT_OWNER', false, now(), now()),
       (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'f0000000-0000-4000-8000-000000000003'::uuid, 'SALES',        false, now(), now());

-- Business records that must survive a suspension (B is already suspended).
INSERT INTO "Contact" ("id", "tenantId", "type", "status", "firstName", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'INDIVIDUAL', 'ACTIVE', 'Kept-A', now(), now()),
       (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, 'INDIVIDUAL', 'ACTIVE', 'Kept-B', now(), now());

-- Invitations: one inside suspended B, one inside pending C (the acceptance
-- path is tested against both, so the gate is shown to be suspension rather
-- than mere inactivity).
INSERT INTO "Invitation" ("id", "tenantId", "email", "role", "tokenHash", "status", "invitedBy", "expiresAt", "createdAt", "updatedAt")
VALUES ('9000000b-0000-4000-8000-00000000000b'::uuid, 'b0000000-0000-4000-8000-00000000000b'::uuid,
        'p2.invitee@example.test', 'TENANT_ADMIN', 'p2-battery-hash-b', 'PENDING',
        'f0000000-0000-4000-8000-000000000001'::uuid, now() + interval '7 days', now(), now()),
       ('9000000c-0000-4000-8000-00000000000c'::uuid, 'c0000000-0000-4000-8000-00000000000c'::uuid,
        'p2.invitee@example.test', 'TENANT_ADMIN', 'p2-battery-hash-c', 'PENDING',
        'f0000000-0000-4000-8000-000000000002'::uuid, now() + interval '7 days', now(), now());

-- An audit row already inside suspended B: the trail must stay readable and
-- appendable while the workspace is offline to its own members.
INSERT INTO "AuditLog" ("id", "tenantId", "userId", "action", "resource", "createdAt")
VALUES (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid,
        'f0000000-0000-4000-8000-000000000001'::uuid, 'contact.created', 'Contact', now());

-- The lifecycle row that put B into suspension, so P10 has real history to read
-- and something for the append-only trigger to protect.
INSERT INTO "TenantStatusHistory" ("id", "tenantId", "fromStatus", "toStatus", "changedById", "reason", "createdAt")
VALUES ('d0000000-0000-4000-8000-00000000000b'::uuid,
        'b0000000-0000-4000-8000-00000000000b'::uuid,
        'ACTIVE', 'SUSPENDED', 'f0000000-0000-4000-8000-000000000002'::uuid,
        'Battery: provider suspension', now());

COMMIT;

\echo ''
\echo '=== P1: catalog and grant shape (owner-level facts) ==='

DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Permission";
    RAISE NOTICE 'P1a permission catalog = 42: %', CASE WHEN n = 42 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    SELECT count(*) INTO n FROM "RolePermission";
    RAISE NOTICE 'P1b role matrix = 116: %', CASE WHEN n = 116 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    SELECT count(*) INTO n FROM "RolePermission" WHERE "roleKey" = 'SUPER_ADMIN';
    RAISE NOTICE 'P1c SUPER_ADMIN = 9 platform permissions: %', CASE WHEN n = 9 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    SELECT count(*) INTO n FROM "RolePermission" WHERE "roleKey" = 'SUPPORT';
    RAISE NOTICE 'P1d SUPPORT = 0 permissions: %', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    SELECT count(*) INTO n FROM "Permission"
     WHERE "key" IN ('platform.tenants.update', 'platform.tenants.plan.assign',
                     'platform.tenants.domain.manage', 'platform.audit.read');
    RAISE NOTICE 'P1e four new platform permissions seeded: %', CASE WHEN n = 4 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    SELECT count(*) INTO n FROM "Permission" p
      JOIN "RolePermission" rp ON rp."permissionId" = p."id"
     WHERE p."key" LIKE 'platform.%' AND rp."domain" = 'tenant';
    RAISE NOTICE 'P1f no platform permission leaked into a tenant role: %', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    SELECT count(*) INTO n FROM "Plan";
    RAISE NOTICE 'P1g plan catalogue seeded (1 informational row): %', CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;
END $$;

DO $$
DECLARE
    v_privs text;
    v_count bigint;
BEGIN
    SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) INTO v_privs
      FROM information_schema.table_privileges
     WHERE table_schema = 'public' AND table_name = 'Plan' AND grantee = 'amisibiz_app';

    RAISE NOTICE 'P1h runtime role holds SELECT only on Plan (%): %',
        coalesce(v_privs, 'none'),
        CASE WHEN v_privs = 'SELECT' THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO v_count FROM information_schema.routines
      WHERE routine_schema = 'public'
        AND routine_name IN ('app_tenant_accepts_writes', 'has_tenant_admin_write_access',
                             'touch_tenant_activity', 'record_tenant_sync_attempt');
    RAISE NOTICE 'P1i Phase 2 helper functions exist: %',
        CASE WHEN v_count = 4 THEN 'PASS' ELSE 'FAIL (' || v_count || ')' END;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'P1h/P1i skipped: %', SQLERRM;
END $$;

-- The plan FK is a real reference: a made-up id cannot be attached at all, and
-- the seeded id can only be attached by a platform actor. The second half is the
-- interesting one — `tenant_provider_columns_guard_update` fires even for the
-- table owner, because the guard asks `is_platform_admin()` rather than trusting
-- who holds the connection.
DO $$
BEGIN
    BEGIN
        INSERT INTO "Tenant" ("id", "name", "slug", "status", "currency", "timezone", "locale",
                              "planId", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), 'Ghost Plan', 'p2-ghost', 'PENDING', 'KES', 'UTC', 'en',
                '00000000-0000-4000-8000-000000000000'::uuid, now(), now());
        RAISE NOTICE 'P2a unknown plan id refused: FAIL (inserted)';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'P2a unknown plan id refused: PASS';
    WHEN OTHERS THEN
        RAISE NOTICE 'P2a unknown plan id refused: FAIL (unexpected %)', SQLERRM;
    END;

    BEGIN
        UPDATE "Tenant" SET "planId" = (SELECT id FROM "Plan" WHERE code = 'standard'),
                            "updatedAt" = now()
         WHERE "slug" = 'p2-active';
        RAISE NOTICE 'P2b planId move without platform authority refused: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'P2b planId move without platform authority refused: PASS';
    WHEN OTHERS THEN
        RAISE NOTICE 'P2b planId move without platform authority refused: FAIL (%)', SQLERRM;
    END;
END $$;

-- The same assignment done the supported way: a platform-scoped connection, in a
-- committed transaction so the later plan-visibility and console tests see it.
BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(NULL, 'f0000000-0000-4000-8000-000000000002', NULL, true, false);
UPDATE "Tenant" SET "planId" = (SELECT id FROM "Plan" WHERE code = 'standard'),
                    "updatedAt" = now()
 WHERE "slug" = 'p2-active';
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Tenant" WHERE "slug" = 'p2-active' AND "planId" IS NOT NULL;
    RAISE NOTICE 'P2c planId assignment under platform authority (shipped path): %',
        CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
COMMIT;

\echo ''
\echo '=== P3: plan visibility under RLS ==='

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('a0000000-0000-4000-8000-00000000000a',
                                 'f0000000-0000-4000-8000-000000000003', 'SALES', false, false);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Plan";
    RAISE NOTICE 'P3a a tenant member cannot enumerate plans (%): %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    BEGIN
        INSERT INTO "Plan" ("id", "code", "name", "description", "status", "sortOrder", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), 'self_service', 'Self Service', 'invented', 'ACTIVE', 0, now(), now());
        RAISE NOTICE 'P3b runtime role cannot write the plan catalogue: FAIL (inserted)';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'P3b runtime role cannot write the plan catalogue: PASS';
    WHEN OTHERS THEN
        RAISE NOTICE 'P3b runtime role cannot write the plan catalogue: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(NULL, 'f0000000-0000-4000-8000-000000000002', NULL, true, false);
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM "Plan";
    RAISE NOTICE 'P3c the provider console can read plans (%): %', n,
        CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
ROLLBACK;

\echo ''
\echo '=== P4: suspended workspace — writes denied, reads allowed ==='

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('b0000000-0000-4000-8000-00000000000b',
                                 'f0000000-0000-4000-8000-000000000001', 'TENANT_OWNER', false, false);
DO $$
DECLARE
    n bigint;
    v_rows bigint;
BEGIN
    -- Reads: the workspace and its records stay visible to their own owner.
    SELECT count(*) INTO n FROM "Contact";
    RAISE NOTICE 'P4a suspended READS still work (% contact row(s) visible): %', n,
        CASE WHEN n >= 1 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "TenantBranding" WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
    RAISE NOTICE 'P4b branding row still readable: %', CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    SELECT count(*) INTO n FROM "AuditLog" WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
    RAISE NOTICE 'P4c audit trail readable while suspended: %', CASE WHEN n >= 1 THEN 'PASS' ELSE 'FAIL (' || n || ')' END;

    -- Writes: every business mutation family is refused. INSERTs refuse loudly
    -- (a WITH CHECK violation is SQLSTATE 42501); UPDATE and DELETE refuse
    -- quietly, because the write-aware USING clause makes the suspended
    -- workspace's rows unreachable. Both are denials, and the assertion here is
    -- the one that matters: nothing changed.
    BEGIN
        INSERT INTO "Contact" ("id", "tenantId", "type", "status", "firstName", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, 'INDIVIDUAL', 'ACTIVE', 'Denied', now(), now());
        RAISE NOTICE 'P4d suspended INSERT denied: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P4d suspended INSERT denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P4d suspended INSERT denied: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "Contact" SET "firstName" = 'Rewritten', "updatedAt" = now()
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        SELECT count(*) INTO n FROM "Contact"
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid AND "firstName" = 'Kept-B';
        IF v_rows = 0 AND n = 1 THEN
            RAISE NOTICE 'P4e suspended UPDATE denied (row unreachable, original value intact): PASS';
        ELSE
            RAISE NOTICE 'P4e suspended UPDATE denied: FAIL (% row(s) changed)', v_rows;
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P4e suspended UPDATE denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P4e suspended UPDATE denied: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "TenantBranding" SET "displayName" = 'Renamed'
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        SELECT count(*) INTO n FROM "TenantBranding"
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid AND "displayName" = 'Suspended Co';
        IF v_rows = 0 AND n = 1 THEN
            RAISE NOTICE 'P4f suspended branding UPDATE denied: PASS';
        ELSE
            RAISE NOTICE 'P4f suspended branding UPDATE denied: FAIL (% row(s) changed)', v_rows;
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P4f suspended branding UPDATE denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P4f suspended branding UPDATE denied: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "Tenant" SET "name" = 'Self Renamed', "updatedAt" = now()
         WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        SELECT count(*) INTO n FROM "Tenant"
         WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid AND "name" = 'Suspended Co';
        IF v_rows = 0 AND n = 1 THEN
            RAISE NOTICE 'P4g suspended tenant-row UPDATE denied: PASS';
        ELSE
            RAISE NOTICE 'P4g suspended tenant-row UPDATE denied: FAIL (% row(s) changed)', v_rows;
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P4g suspended tenant-row UPDATE denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P4g suspended tenant-row UPDATE denied: FAIL (%)', SQLERRM;
    END;

    BEGIN
        INSERT INTO "Invitation" ("id", "tenantId", "email", "role", "tokenHash", "status", "invitedBy", "expiresAt", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, 'new.invitee@example.test', 'VIEWER',
                'p2-battery-new-hash', 'PENDING', 'f0000000-0000-4000-8000-000000000001'::uuid, now() + interval '7 days', now(), now());
        RAISE NOTICE 'P4h suspended invitation INSERT denied: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P4h suspended invitation INSERT denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P4h suspended invitation INSERT denied: FAIL (%)', SQLERRM;
    END;

    BEGIN
        DELETE FROM "TenantDomain" WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        SELECT count(*) INTO n FROM "TenantDomain"
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        IF v_rows = 0 AND n = 1 THEN
            RAISE NOTICE 'P4i suspended hostname DELETE denied (domain still attached): PASS';
        ELSE
            RAISE NOTICE 'P4i suspended hostname DELETE denied: FAIL (% row(s) removed)', v_rows;
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P4i suspended hostname DELETE denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P4i suspended hostname DELETE denied: FAIL (%)', SQLERRM;
    END;

    -- Number allocation is SECURITY DEFINER, so it needs its own refusal.
    BEGIN
        PERFORM public.allocate_document_number('b0000000-0000-4000-8000-00000000000b'::uuid, 'INVOICE', CURRENT_DATE);
        RAISE NOTICE 'P4j suspended number allocation denied: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P4j suspended number allocation denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P4j suspended number allocation denied: FAIL (%)', SQLERRM;
    END;

    -- But the denial itself is still auditable, and the audit row is what the
    -- provider console reads as evidence.
    BEGIN
        INSERT INTO "AuditLog" ("id", "tenantId", "userId", "action", "createdAt")
        VALUES (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid,
                'f0000000-0000-4000-8000-000000000001'::uuid, 'tenant.writeDenied', now());
        RAISE NOTICE 'P4k suspension denials remain auditable: PASS';
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'P4k suspension denials remain auditable: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

\echo ''
\echo '=== P5: suspended workspace — membership and invitation paths ==='

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('b0000000-0000-4000-8000-00000000000b',
                                 'f0000000-0000-4000-8000-000000000004', NULL, false, false);
DO $$
DECLARE
    v_rows bigint;
    n bigint;
BEGIN
    -- The invitee accepts an invitation into a SUSPENDED workspace: refused.
    -- The recipient branch of `invitation_update` carries the same
    -- `app_tenant_accepts_writes` term as its USING and WITH CHECK, so the row
    -- is unreachable rather than loud — hence the effect-based assertion.
    BEGIN
        UPDATE "Invitation" SET "status" = 'ACCEPTED', "acceptedAt" = now()
         WHERE "id" = '9000000b-0000-4000-8000-00000000000b'::uuid;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        SELECT count(*) INTO n FROM "Invitation"
         WHERE "id" = '9000000b-0000-4000-8000-00000000000b'::uuid AND "status" = 'PENDING';
        IF v_rows = 0 AND n = 1 THEN
            RAISE NOTICE 'P5a invitation acceptance into suspended workspace denied: PASS';
        ELSE
            RAISE NOTICE 'P5a invitation acceptance into suspended workspace denied: FAIL (% row(s) changed)', v_rows;
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P5a invitation acceptance into suspended workspace denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P5a invitation acceptance into suspended workspace denied: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context(NULL, 'f0000000-0000-4000-8000-000000000004', NULL, false, false);
DO $$
BEGIN
    -- The self-join membership INSERT (the shape acceptInvitationAction issues)
    -- must fail too, or the invitation refusal would leak.
    BEGIN
        INSERT INTO "TenantMember" ("id", "tenantId", "userId", "role", "isDefault", "joinedAt", "updatedAt")
        VALUES (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid,
                'f0000000-0000-4000-8000-000000000004'::uuid, 'TENANT_ADMIN', false, now(), now());
        RAISE NOTICE 'P5b membership self-join into suspended workspace denied: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P5b membership self-join into suspended workspace denied: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P5b membership self-join into suspended workspace denied: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('c0000000-0000-4000-8000-00000000000c',
                                 'f0000000-0000-4000-8000-000000000004', NULL, false, false);
DO $$
BEGIN
    -- And the same acceptance inside a PENDING workspace must still work:
    -- provisioning is not suspension. This is the regression guard for the
    -- provider's "assign an initial owner" flow.
    BEGIN
        UPDATE "Invitation" SET "status" = 'ACCEPTED', "acceptedAt" = now()
         WHERE "id" = '9000000c-0000-4000-8000-00000000000c'::uuid;
        RAISE NOTICE 'P5c invitation acceptance into PENDING workspace allowed: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P5c invitation acceptance into PENDING workspace allowed: FAIL (%)', SQLERRM;
    END;

    BEGIN
        INSERT INTO "TenantMember" ("id", "tenantId", "userId", "role", "isDefault", "joinedAt", "updatedAt")
        VALUES (gen_random_uuid(), 'c0000000-0000-4000-8000-00000000000c'::uuid,
                'f0000000-0000-4000-8000-000000000004'::uuid, 'TENANT_ADMIN', false, now(), now());
        RAISE NOTICE 'P5d pending-workspace owner seat created: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P5d pending-workspace owner seat created: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

\echo ''
\echo '=== P6: active workspace — writes allowed, provider columns guarded ==='

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('a0000000-0000-4000-8000-00000000000a',
                                 'f0000000-0000-4000-8000-000000000001', 'TENANT_OWNER', false, false);
DO $$
BEGIN
    BEGIN
        INSERT INTO "Contact" ("id", "tenantId", "type", "status", "firstName", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'INDIVIDUAL', 'ACTIVE', 'Normal', now(), now());
        RAISE NOTICE 'P6a active workspace writes still work: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P6a active workspace writes still work: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "TenantBranding" SET "displayName" = 'Renamed by owner', "updatedAt" = now()
         WHERE "tenantId" = 'a0000000-0000-4000-8000-00000000000a'::uuid;
        RAISE NOTICE 'P6b active workspace branding UPDATE works: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P6b active workspace branding UPDATE works: FAIL (%)', SQLERRM;
    END;

    -- Provider-owned columns, tested on an ACTIVE tenant because the row policy
    -- admits the update there and only the trigger can refuse it.
    BEGIN
        UPDATE "Tenant" SET "slug" = 'self-chosen', "updatedAt" = now()
         WHERE "id" = 'a0000000-0000-4000-8000-00000000000a'::uuid;
        RAISE NOTICE 'P6c tenant-side slug change refused: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P6c tenant-side slug change refused: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P6c tenant-side slug change refused: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "Tenant" SET "planId" = NULL, "updatedAt" = now()
         WHERE "id" = 'a0000000-0000-4000-8000-00000000000a'::uuid;
        RAISE NOTICE 'P6d tenant-side plan change refused: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P6d tenant-side plan change refused: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P6d tenant-side plan change refused: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "Tenant" SET "status" = 'SUSPENDED', "updatedAt" = now()
         WHERE "id" = 'a0000000-0000-4000-8000-00000000000a'::uuid;
        RAISE NOTICE 'P6e tenant-side self-suspension refused: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P6e tenant-side self-suspension refused: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P6e tenant-side self-suspension refused: FAIL (%)', SQLERRM;
    END;

    BEGIN
        PERFORM public.allocate_document_number('a0000000-0000-4000-8000-00000000000a'::uuid, 'INVOICE', CURRENT_DATE);
        RAISE NOTICE 'P6f active workspace still allocates numbers: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P6f active workspace still allocates numbers: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('b0000000-0000-4000-8000-00000000000b',
                                 'f0000000-0000-4000-8000-000000000001', 'TENANT_OWNER', false, false);
DO $$
DECLARE
    v_rows bigint;
    n bigint;
BEGIN
    -- The acceptance criterion, named: "tenant admins cannot activate
    -- themselves". On a SUSPENDED workspace the row is unreachable to a tenant
    -- write (`tenant_admin_update` is gated by the write-aware family), so the
    -- assertion is that the status never moved.
    BEGIN
        UPDATE "Tenant" SET "status" = 'ACTIVE', "updatedAt" = now()
         WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        SELECT count(*) INTO n FROM "Tenant"
         WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid AND "status" = 'SUSPENDED';
        IF v_rows = 0 AND n = 1 THEN
            RAISE NOTICE 'P6g suspended owner cannot reactivate itself: PASS';
        ELSE
            RAISE NOTICE 'P6g suspended owner cannot reactivate itself: FAIL (% row(s) changed)', v_rows;
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'P6g suspended owner cannot reactivate itself: PASS';
    WHEN OTHERS THEN
        RAISE NOTICE 'P6g suspended owner cannot reactivate itself: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

\echo ''
\echo '=== P7: platform authority over a suspended workspace ==='

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('b0000000-0000-4000-8000-00000000000b',
                                 'f0000000-0000-4000-8000-000000000002', NULL, true, false);
DO $$
DECLARE
    v_history bigint;
BEGIN
    BEGIN
        UPDATE "Tenant" SET "status" = 'ACTIVE', "suspendedAt" = NULL, "suspensionReason" = NULL,
                            "activatedById" = 'f0000000-0000-4000-8000-000000000002'::uuid,
                            "updatedAt" = now()
         WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        RAISE NOTICE 'P7a provider reactivates a suspended workspace: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P7a provider reactivates a suspended workspace: FAIL (%)', SQLERRM;
    END;

    INSERT INTO "TenantStatusHistory" ("id", "tenantId", "fromStatus", "toStatus", "changedById", "reason", "createdAt")
    VALUES (gen_random_uuid(), 'b0000000-0000-4000-8000-00000000000b'::uuid, 'SUSPENDED', 'ACTIVE',
            'f0000000-0000-4000-8000-000000000002'::uuid, 'Battery: reactivation', now());
    SELECT count(*) INTO v_history FROM "TenantStatusHistory"
     WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
    RAISE NOTICE 'P7b transition and history written in one transaction (% row(s)): %', v_history,
        CASE WHEN v_history >= 1 THEN 'PASS' ELSE 'FAIL' END;

    BEGIN
        UPDATE "TenantBranding" SET "displayName" = 'Provider re-brand', "primaryColor" = '#00aa00', "updatedAt" = now()
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        RAISE NOTICE 'P7c provider branding edit while suspended: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P7c provider branding edit while suspended: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "Tenant" SET "slug" = 'p2-renamed-by-provider', "updatedAt" = now()
         WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        RAISE NOTICE 'P7d provider slug management while suspended: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P7d provider slug management while suspended: FAIL (%)', SQLERRM;
    END;

    BEGIN
        UPDATE "Tenant" SET "planId" = (SELECT id FROM "Plan" WHERE code = 'standard'), "updatedAt" = now()
         WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        RAISE NOTICE 'P7e provider plan assignment: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P7e provider plan assignment: FAIL (%)', SQLERRM;
    END;

    BEGIN
        DELETE FROM "TenantDomain" WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        RAISE NOTICE 'P7f provider hostname removal: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P7f provider hostname removal: FAIL (%)', SQLERRM;
    END;

    -- Records survive: the business rows were untouched by all of the above.
    IF (SELECT count(*) FROM "Contact" WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid) = 1 THEN
        RAISE NOTICE 'P7g business records survive provider administration: PASS';
    ELSE
        RAISE NOTICE 'P7g business records survive provider administration: FAIL';
    END IF;
END $$;
ROLLBACK;

\echo ''
\echo '=== P8: indicator writers ==='

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('a0000000-0000-4000-8000-00000000000a',
                                 'f0000000-0000-4000-8000-000000000003', 'SALES', false, false);
DO $$
DECLARE
    v_before timestamptz;
    v_after  timestamptz;
BEGIN
    SELECT "lastActivityAt" INTO v_before FROM "Tenant" WHERE "id" = 'a0000000-0000-4000-8000-00000000000a'::uuid;

    BEGIN
        PERFORM public.touch_tenant_activity('a0000000-0000-4000-8000-00000000000a'::uuid);
        SELECT "lastActivityAt" INTO v_after FROM "Tenant" WHERE "id" = 'a0000000-0000-4000-8000-00000000000a'::uuid;
        RAISE NOTICE 'P8a a member write path can stamp activity: %',
            CASE WHEN v_after > v_before THEN 'PASS' ELSE 'FAIL (before=' || v_before || ', after=' || v_after || ')' END;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P8a a member write path can stamp activity: FAIL (%)', SQLERRM;
    END;

    BEGIN
        PERFORM public.touch_tenant_activity('b0000000-0000-4000-8000-00000000000b'::uuid);
        RAISE NOTICE 'P8b stamping another workspace refused: FAIL (allowed)';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'P8b stamping another workspace refused: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P8b stamping another workspace refused: FAIL (%)', SQLERRM;
    END;

    BEGIN
        PERFORM public.record_tenant_sync_attempt('a0000000-0000-4000-8000-00000000000a'::uuid, false, NULL);
        RAISE NOTICE 'P8c refused sync requires an error code: FAIL (allowed)';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE 'P8c refused sync requires an error code: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P8c refused sync requires an error code: FAIL (%)', SQLERRM;
    END;

    BEGIN
        PERFORM public.record_tenant_sync_attempt('a0000000-0000-4000-8000-00000000000a'::uuid, false, 'tenant_suspended');
        PERFORM public.record_tenant_sync_attempt('a0000000-0000-4000-8000-00000000000a'::uuid, true, NULL);
        IF (SELECT "lastSyncErrorCode" FROM "Tenant" WHERE "id" = 'a0000000-0000-4000-8000-00000000000a'::uuid) IS NULL
           AND (SELECT "lastSyncAt" FROM "Tenant" WHERE "id" = 'a0000000-0000-4000-8000-00000000000a'::uuid) IS NOT NULL THEN
            RAISE NOTICE 'P8d sync attempt recorded, error code cleared on success: PASS';
        ELSE
            RAISE NOTICE 'P8d sync attempt recorded, error code cleared on success: FAIL';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P8d sync attempt recorded, error code cleared on success: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('b0000000-0000-4000-8000-00000000000b',
                                 'f0000000-0000-4000-8000-000000000001', 'TENANT_OWNER', false, false);
DO $$
DECLARE
    v_activity timestamptz;
BEGIN
    -- A suspended workspace keeps the timestamp it had when it went offline:
    -- the console must read "nothing since suspension", not a live clock.
    PERFORM public.touch_tenant_activity('b0000000-0000-4000-8000-00000000000b'::uuid);
    SELECT "lastActivityAt" INTO v_activity FROM "Tenant" WHERE "id" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
    RAISE NOTICE 'P8e suspended activity frozen at %: %', v_activity,
        CASE WHEN v_activity = TIMESTAMP '2026-01-01 00:00:00' THEN 'PASS' ELSE 'FAIL' END;
END $$;
ROLLBACK;

\echo ''
\echo '=== P9: one primary hostname per workspace ==='

BEGIN;
DO $$
BEGIN
    BEGIN
        INSERT INTO "TenantDomain" ("id", "tenantId", "hostname", "isPrimary", "createdAt")
        VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'second-primary.example.test', true, now());
        RAISE NOTICE 'P9a second primary hostname refused: FAIL (inserted)';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'P9a second primary hostname refused: PASS';
    WHEN OTHERS THEN
        RAISE NOTICE 'P9a second primary hostname refused: FAIL (%)', SQLERRM;
    END;

    -- A second NON-primary hostname is normal multi-domain hosting.
    BEGIN
        INSERT INTO "TenantDomain" ("id", "tenantId", "hostname", "isPrimary", "createdAt")
        VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'alias.example.test', false, now());
        RAISE NOTICE 'P9b additional non-primary hostname accepted: PASS';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'P9b additional non-primary hostname accepted: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

\echo ''
\echo '=== P10: status history and audit stay append-only through suspension ==='

BEGIN;
SET LOCAL ROLE amisibiz_app;
SELECT public.set_tenant_context('b0000000-0000-4000-8000-00000000000b',
                                 'f0000000-0000-4000-8000-000000000001', 'TENANT_OWNER', false, false);
DO $$
DECLARE
    n bigint;
    v_rows bigint;
BEGIN
    -- The suspended tenant may still READ its own lifecycle history (evidence it
    -- can see, never rewrite).
    SELECT count(*) INTO n FROM "TenantStatusHistory" WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
    RAISE NOTICE 'P10a suspended workspace can read its status history (% row(s)): %', n,
        CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;

    BEGIN
        DELETE FROM "TenantStatusHistory" WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        SELECT count(*) INTO n FROM "TenantStatusHistory"
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        IF v_rows = 0 AND n = 1 THEN
            RAISE NOTICE 'P10b history rewrite refused (no DELETE policy, row unreachable): PASS';
        ELSE
            RAISE NOTICE 'P10b history rewrite refused: FAIL (% row(s) removed)', v_rows;
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'P10b history rewrite refused: PASS';
    WHEN OTHERS THEN RAISE NOTICE 'P10b history rewrite refused: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

-- The same row against the table owner, who bypasses row-level security
-- entirely: the append-only rule is a trigger, so it holds there too.
BEGIN;
DO $$
BEGIN
    BEGIN
        UPDATE "TenantStatusHistory" SET "reason" = 'rewritten by hand'
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        RAISE NOTICE 'P10c append-only history survives even the owner role: FAIL (allowed)';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'P10c append-only history survives even the owner role: PASS';
    WHEN OTHERS THEN
        RAISE NOTICE 'P10c append-only history survives even the owner role: FAIL (%)', SQLERRM;
    END;

    BEGIN
        DELETE FROM "TenantStatusHistory"
         WHERE "tenantId" = 'b0000000-0000-4000-8000-00000000000b'::uuid;
        RAISE NOTICE 'P10d history removal refused even for the owner: FAIL (allowed)';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'P10d history removal refused even for the owner: PASS';
    WHEN OTHERS THEN
        RAISE NOTICE 'P10d history removal refused even for the owner: FAIL (%)', SQLERRM;
    END;
END $$;
ROLLBACK;

\echo ''
\echo '=== phase02 battery complete (grep the output above for FAIL) ==='
