-- Phase 1 migration checks: the database half of the authorisation contract.
--
-- WHAT THIS SCRIPT IS FOR: Phase 1 replaced text identities with UUIDs, the
-- legacy role names with the nine-role model, and every "server code remembers
-- to filter" assumption with row level security. Those are schema-and-privilege
-- facts, so they are asserted here with catalog queries rather than through the
-- application: if a later migration quietly re-grants a table, drops a policy or
-- re-adds a default privilege, this script says so.
--
-- HOW TO RUN (scratch database with the full chain applied and the Phase 1
-- fixture loaded, BEFORE the behaviour battery in .tmp/phase1_rls_battery.sql,
-- which inserts rows and would break the fixture-count checks in section C):
--   psql -v ON_ERROR_STOP=1 -q -d <scratch> -f prisma/scripts/phase01-migration-checks.sql
--
-- Every line prints `check | evidence | PASS|FAIL`. Section C names its fixture
-- exactly (apps/web/prisma/… phase1 fixture: two tenants, six users, six
-- memberships, two contacts, three documents). Nothing here mutates committed
-- state: the privilege probe rolls back.

\pset footer off
\set ON_ERROR_STOP on
\pset format unaligned

-- The 24 tables AmisiBiz owns. Anything else in `public` belongs to the shared
-- project (or to Prisma's bookkeeping) and the runtime role must not touch it.
-- Note: no ON COMMIT DROP — psql runs each statement in its own transaction.
DROP TABLE IF EXISTS _owned_tables;
CREATE TEMP TABLE _owned_tables (name text PRIMARY KEY);
INSERT INTO _owned_tables (name) VALUES
  ('Tenant'), ('TenantSettings'), ('TenantBranding'), ('TenantDomain'),
  ('User'), ('TenantMember'), ('Invitation'),
  ('AuditLog'), ('TenantStatusHistory'), ('SupportAccessGrant'),
  ('Permission'), ('RolePermission'),
  ('TaxCategory'), ('TaxRate'), ('Contact'), ('ContactAddress'), ('Item'), ('ContactItem'),
  ('Document'), ('DocumentLine'), ('DocumentPayment'), ('DocumentStatusEvent'),
  ('DocumentNumbering'), ('DocumentNumberSequence');

-- The verb ceiling each table hands the runtime role, straight from the grant
-- block of the RLS migration. RLS narrows within these; nothing wider is legal.
DROP TABLE IF EXISTS _expected_grants;
CREATE TEMP TABLE _expected_grants (name text PRIMARY KEY, verbs text NOT NULL);
INSERT INTO _expected_grants (name, verbs) VALUES
  ('Tenant','INSERT,SELECT,UPDATE'),
  ('TenantSettings','INSERT,SELECT,UPDATE'),
  ('TenantBranding','INSERT,SELECT,UPDATE'),
  ('TenantDomain','INSERT,SELECT,UPDATE'),
  ('User','INSERT,SELECT,UPDATE'),
  ('TenantMember','DELETE,INSERT,SELECT,UPDATE'),
  ('Invitation','INSERT,SELECT,UPDATE'),
  ('AuditLog','INSERT,SELECT'),
  ('TenantStatusHistory','INSERT,SELECT'),
  ('SupportAccessGrant','INSERT,SELECT,UPDATE'),
  ('Permission','SELECT'),
  ('RolePermission','SELECT'),
  ('TaxCategory','DELETE,INSERT,SELECT,UPDATE'),
  ('TaxRate','DELETE,INSERT,SELECT,UPDATE'),
  ('Contact','INSERT,SELECT,UPDATE'),
  ('ContactAddress','DELETE,INSERT,SELECT,UPDATE'),
  ('Item','INSERT,SELECT,UPDATE'),
  ('ContactItem','DELETE,INSERT,SELECT,UPDATE'),
  ('Document','DELETE,INSERT,SELECT,UPDATE'),
  ('DocumentLine','DELETE,INSERT,SELECT,UPDATE'),
  ('DocumentPayment','INSERT,SELECT,UPDATE'),
  ('DocumentStatusEvent','INSERT,SELECT'),
  ('DocumentNumbering','INSERT,SELECT,UPDATE'),
  ('DocumentNumberSequence','INSERT,SELECT,UPDATE');

-- The helpers the policies and the request context are built from. PUBLIC gets
-- none of them; the runtime role gets all of them; `authenticated` gets only the
-- two its Storage policies evaluate.
DROP TABLE IF EXISTS _helper_fns;
CREATE TEMP TABLE _helper_fns (name text PRIMARY KEY);
INSERT INTO _helper_fns (name) VALUES
  ('is_platform_admin'), ('is_platform_support'), ('app_tenant_role'),
  ('has_tenant_membership'), ('has_tenant_read_access'), ('has_tenant_write_access'),
  ('has_tenant_admin_access'), ('has_support_grant'), ('app_is_tenant_creator'),
  ('app_current_user_email'), ('app_find_user_id_by_email'),
  ('app_shares_tenant_with'), ('app_shares_admin_tenant_with'),
  ('app_tenant_role_rank'), ('current_tenant_id'), ('current_user_id'),
  ('set_tenant_context'), ('clear_tenant_context'),
  ('allocate_document_number'), ('peek_document_number'),
  ('app_object_tenant_id'), ('app_is_tenant_member');

-- ── A. identity shape: UUIDs everywhere they were decided ────────────────────
DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n
      FROM pg_attribute a
      JOIN pg_class c      ON c.oid = a.attrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN _owned_tables o ON o.name = c.relname
     WHERE ns.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname = 'id'
       AND a.atttypid <> 'uuid'::regtype;
    RAISE NOTICE 'A1. every primary key is uuid | offenders=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n
      FROM pg_attribute a
      JOIN pg_class c      ON c.oid = a.attrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname = 'tenantId'
       AND a.atttypid <> 'uuid'::regtype;
    RAISE NOTICE 'A2. every tenantId column is uuid | offenders=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- No foreign key may still travel as text. (The only non-uuid FK column in
    -- the schema is the numbering sequence's enum `type`, which pairs with its
    -- own (tenantId, type) — enums are fine, text is not.)
    SELECT count(*) INTO n
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN _owned_tables o ON o.name = c.relname
      JOIN unnest(k.conkey) AS col(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = col.attnum
     WHERE k.contype = 'f' AND NOT a.attisdropped
       AND a.atttypid = 'text'::regtype;
    RAISE NOTICE 'A3. no text-typed foreign keys left | offenders=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- Email uniqueness survives the identity swap (invitations and login both
    -- match on it), and tenant slugs stay unique.
    SELECT count(*) INTO n FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN ('User_email_key', 'Tenant_slug_key',
                         'TenantMember_tenantId_userId_key',
                         'Document_tenantId_type_number_key',
                         'DocumentNumbering_tenantId_type_key',
                         'DocumentNumberSequence_tenantId_type_period_key');
    RAISE NOTICE 'A4. key unique constraints present | found=% (expect 6) | %', n,
        CASE WHEN n = 6 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN ('document_one_invoice_per_source',
                         'TenantMember_userId_isDefault_partial',
                         'ContactAddress_contactId_type_isDefault_partial');
    RAISE NOTICE 'A5. partial indexes (SQL-only, not expressible in Prisma) | found=% (expect 3) | %', n,
        CASE WHEN n = 3 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- ── B. RBAC catalog: the matrix the code mirrors ─────────────────────────────
DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n FROM "Permission";
    RAISE NOTICE 'B1. permission catalog rows | count=% (expect 38) | %', n,
        CASE WHEN n = 38 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "RolePermission";
    RAISE NOTICE 'B2. role-permission rows | count=% (expect 112) | %', n,
        CASE WHEN n = 112 THEN 'PASS' ELSE 'FAIL' END;

    -- Exact per-role totals; SUPPORT is deliberately empty (provider access is a
    -- time-boxed grant, not a permission set). `roleKey` is text guarded by a
    -- CHECK against the nine roles, and grants link to Permission by id.
    RAISE NOTICE 'B3. per-role totals | owner=% admin=% sales=% ops=% finance=% viewer=% super=% portal=% support=% | %',
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_OWNER'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_ADMIN'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SALES'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'OPERATIONS'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'FINANCE'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'VIEWER'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SUPER_ADMIN'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'CUSTOMER_PORTAL_USER'),
        (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SUPPORT'),
        CASE WHEN (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_OWNER') = 31
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'TENANT_ADMIN') = 31
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SALES') = 13
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'OPERATIONS') = 12
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'FINANCE') = 11
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'VIEWER') = 7
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SUPER_ADMIN') = 5
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'CUSTOMER_PORTAL_USER') = 2
              AND  (SELECT count(*) FROM "RolePermission" WHERE "roleKey" = 'SUPPORT') = 0
             THEN 'PASS' ELSE 'FAIL' END;

    -- The nine roles of the matrix live in two enums: seven tenant seats and two
    -- platform identities. Assert the exact label sets, not just counts.
    SELECT count(*) INTO n FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE (t.typname = 'TenantRole' AND e.enumlabel NOT IN
            ('TENANT_OWNER','TENANT_ADMIN','SALES','FINANCE','OPERATIONS','VIEWER',
             'CUSTOMER_PORTAL_USER'))
        OR (t.typname = 'PlatformRole' AND e.enumlabel NOT IN ('SUPER_ADMIN','SUPPORT'));
    RAISE NOTICE 'B4. role enums carry exactly the nine modelled roles | unexpected=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname IN ('TenantRole','PlatformRole');
    RAISE NOTICE 'B4b. total role labels across both enums | count=% (expect 9) | %', n,
        CASE WHEN n = 9 THEN 'PASS' ELSE 'FAIL' END;

    -- The legacy names must be gone from the type itself, not just from rows.
    SELECT count(*) INTO n FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname IN ('TenantRole', 'PlatformRole')
       AND e.enumlabel IN ('BUSINESS_OWNER','BUSINESS_ADMIN','SALES_STAFF',
                           'DOCUMENT_MANAGER','VIEWER_ONLY','PLATFORM_ADMIN',
                           'PLATFORM_SUPPORT');
    RAISE NOTICE 'B5. legacy role labels removed from the enums | leftovers=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "RolePermission" r
     WHERE NOT EXISTS (SELECT 1 FROM "Permission" p WHERE p.id = r."permissionId");
    RAISE NOTICE 'B6. every role grant points at a real permission | orphans=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- No role may be missing from the matrix entirely (a role with zero grants
    -- is how a regression in a seed file hides). SUPPORT is the one that is
    -- deliberately empty.
    SELECT count(*) INTO n FROM (VALUES
        ('TENANT_OWNER'),('TENANT_ADMIN'),('SALES'),('FINANCE'),('OPERATIONS'),
        ('VIEWER'),('CUSTOMER_PORTAL_USER'),('SUPER_ADMIN')) known(roleKey)
     WHERE NOT EXISTS (SELECT 1 FROM "RolePermission" r WHERE r."roleKey" = known.roleKey);
    RAISE NOTICE 'B7. every modelled role has grants in the matrix | roleless=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- A role cannot hold the same permission twice, and platform/tenant domains
    -- must agree with the role they are attached to.
    SELECT count(*) INTO n FROM (
        SELECT "roleKey", "permissionId" FROM "RolePermission"
         GROUP BY "roleKey", "permissionId" HAVING count(*) > 1
    ) d;
    RAISE NOTICE 'B8. no duplicated role/permission pair | duplicates=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "RolePermission"
     WHERE ("roleKey" IN ('SUPER_ADMIN','SUPPORT')) <> (domain = 'platform');
    RAISE NOTICE 'B9. platform grants belong to platform roles only | mismatched=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- ── C. the conversion preserved the data it was handed (fixture-dependent) ───
-- Runs only when the Phase 1 fixture is loaded, so the same script is safe to
-- point at an empty deployment or at the live project, where these counts would
-- otherwise describe real customers instead of the fixture.
DO $$
DECLARE n integer;
BEGIN
    IF (SELECT count(*) FROM "User" WHERE email IN
            ('owner.a@example.com','owner.b@example.com','member.c@example.com',
             'support.d@example.com','invitee@example.com','owner.e@example.com')) <> 6 THEN
        RAISE NOTICE 'C1-C18. conversion preserves the rows it was handed | Phase 1 fixture not loaded | SKIP';
        RETURN;
    END IF;

    SELECT count(*) INTO n FROM "User";                RAISE NOTICE 'C1. users preserved | count=% (expect 6) | %', n, CASE WHEN n = 6 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Tenant";              RAISE NOTICE 'C2. tenants preserved | count=% (expect 2) | %', n, CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "TenantMember";        RAISE NOTICE 'C3. memberships preserved | count=% (expect 6) | %', n, CASE WHEN n = 6 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Contact";             RAISE NOTICE 'C4. contacts preserved | count=% (expect 2) | %', n, CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Item";                RAISE NOTICE 'C5. items preserved | count=% (expect 2) | %', n, CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "Document";            RAISE NOTICE 'C6. documents preserved | count=% (expect 3) | %', n, CASE WHEN n = 3 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "DocumentLine";        RAISE NOTICE 'C7. document lines preserved | count=% (expect 3) | %', n, CASE WHEN n = 3 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "DocumentPayment";     RAISE NOTICE 'C8. payments preserved | count=% (expect 2) | %', n, CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "DocumentStatusEvent"; RAISE NOTICE 'C9. status events preserved | count=% (expect 3) | %', n, CASE WHEN n = 3 THEN 'PASS' ELSE 'FAIL' END;

    -- Platform remap: one super admin, one support, everyone else plain.
    SELECT count(*) INTO n FROM "User" WHERE "platformRole" = 'SUPER_ADMIN';
    RAISE NOTICE 'C10. PLATFORM_ADMIN became SUPER_ADMIN | count=% (expect 1) | %', n, CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;
    SELECT count(*) INTO n FROM "User" WHERE "platformRole" = 'SUPPORT';
    RAISE NOTICE 'C11. PLATFORM_SUPPORT became SUPPORT | count=% (expect 1) | %', n, CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;
    -- The old catch-all `USER` platform role is gone (B5 proves it left the
    -- enum); here the surviving fact is that only two accounts carry platform
    -- authority at all, and they are the two the fixture said so.
    SELECT count(*) INTO n FROM "User" WHERE "platformRole" IS NOT NULL;
    RAISE NOTICE 'C12. only remapped accounts carry platform authority | count=% (expect 2) | %', n,
        CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "User"
     WHERE ("platformRole" = 'SUPER_ADMIN' AND email = 'owner.a@example.com')
        OR ("platformRole" = 'SUPPORT'     AND email = 'support.d@example.com');
    RAISE NOTICE 'C12b. platform authority sits on the right two people | matched=% (expect 2) | %', n,
        CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END;

    -- The legacy seat labels landed on the right new roles: two owners in alpha
    -- (BUSINESS_OWNER x2), one admin in beta (BUSINESS_ADMIN), one sales
    -- (SALES_STAFF), one viewer (VIEWER), one operations (DOCUMENT_MANAGER).
    SELECT count(*) INTO n FROM (
        SELECT role, count(*) AS c FROM "TenantMember" GROUP BY role
    ) m FULL OUTER JOIN (
        SELECT * FROM (VALUES
            ('TENANT_OWNER'::"TenantRole", 2), ('TENANT_ADMIN', 1), ('SALES', 1),
            ('VIEWER', 1), ('OPERATIONS', 1)) AS e(role, c)
    ) x ON x.role = m.role AND x.c = m.c
     WHERE m.role IS NULL OR x.role IS NULL;
    RAISE NOTICE 'C13. legacy seat labels mapped to the new roles | mismatches=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- Attribution columns are real foreign keys now, and a tenant that predates
    -- the anchor stays honest (createdById NULL rather than a fabricated author).
    SELECT count(*) INTO n FROM "Tenant" WHERE "createdById" IS NULL;
    RAISE NOTICE 'C14. pre-existing tenants keep NULL createdById | count=% (expect 2) | %', n, CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "Tenant"
     WHERE "activatedById" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = "Tenant"."activatedById");
    RAISE NOTICE 'C15. activation attribution resolves to a user | orphans=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- Immutable snapshots survive the conversion.
    SELECT count(*) INTO n FROM "Document" WHERE "status" = 'ISSUED' AND "snapshot" IS NULL;
    RAISE NOTICE 'C16. issued documents still carry their snapshot | missing=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "DocumentPayment"
     WHERE "reversedAt" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = "DocumentPayment"."reversedBy");
    RAISE NOTICE 'C17. reversal still attributed to a real user | orphans=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- Orphan scan across the owned tables: every non-null parent reference resolves.
-- (The foreign keys enforce this, so a nonzero count means a constraint was
-- dropped somewhere in the chain.)
DO $$
DECLARE
    v_bad integer := 0;
    v_n   integer;
    r     record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('Contact',              'tenantId',            'Tenant'),
        ('Item',                 'tenantId',            'Tenant'),
        ('TenantMember',         'tenantId',            'Tenant'),
        ('TenantMember',         'userId',              'User'),
        ('Invitation',           'tenantId',            'Tenant'),
        ('AuditLog',             'tenantId',            'Tenant'),
        ('TenantStatusHistory',  'tenantId',            'Tenant'),
        ('SupportAccessGrant',   'tenantId',            'Tenant'),
        ('SupportAccessGrant',   'platformUserId',      'User'),
        ('SupportAccessGrant',   'grantedById',         'User'),
        ('Document',             'tenantId',            'Tenant'),
        ('Document',             'contactId',           'Contact'),
        ('DocumentLine',         'documentId',          'Document'),
        ('DocumentPayment',      'documentId',          'Document'),
        ('DocumentStatusEvent',  'documentId',          'Document'),
        ('DocumentNumbering',    'tenantId',            'Tenant'),
        ('DocumentNumberSequence','tenantId',           'Tenant'),
        ('ContactAddress',       'contactId',           'Contact'),
        ('ContactItem',          'contactId',           'Contact'),
        ('ContactItem',          'itemId',              'Item'),
        ('TaxRate',              'categoryId',          'TaxCategory')
    ) AS t(child, col, parent)
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM public.%I c WHERE c.%I IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE p.id = c.%I)',
            r.child, r.col, r.parent, r.col)
        INTO v_n;
        IF v_n > 0 THEN
            v_bad := v_bad + 1;
            RAISE NOTICE '  orphan rows in %.% -> %: %', r.child, r.col, r.parent, v_n;
        END IF;
    END LOOP;
    RAISE NOTICE 'C18. every parent reference resolves | broken_paths=% (expect 0) | %', v_bad,
        CASE WHEN v_bad = 0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- ── D. row level security is on, and it is on for the right roles ────────────
DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN _owned_tables o ON o.name = c.relname
     WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
    RAISE NOTICE 'D1. RLS enabled on every owned table | disabled=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN _owned_tables o ON o.name = c.relname
     WHERE ns.nspname = 'public' AND c.relkind = 'r'
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);
    RAISE NOTICE 'D2. every owned table has at least one policy | policyless=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- The runtime role must be subject to RLS, not above it: no SUPERUSER, no
    -- BYPASSRLS, and NOINHERIT so its privileges come only from its own grants.
    SELECT count(*) INTO n FROM pg_roles
     WHERE rolname = 'amisibiz_app' AND (rolsuper OR rolbypassrls OR rolinherit);
    RAISE NOTICE 'D3. runtime role cannot bypass row security | offenders=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- `anon` and `authenticated` must not reach business tables at all; they
    -- exist for Storage, where the tenant path segment does the authorising.
    SELECT count(*) INTO n FROM pg_policies pol
      JOIN _owned_tables o ON o.name = pol.tablename
     WHERE pol.schemaname = 'public'
       AND EXISTS (SELECT 1 FROM unnest(pol.roles) AS r WHERE r::text IN ('anon','authenticated','public'));
    RAISE NOTICE 'D4. no anon/authenticated/public policies on business tables | count=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- …and every business policy is written for exactly the runtime role.
    SELECT count(*) INTO n FROM pg_policies pol
      JOIN _owned_tables o ON o.name = pol.tablename
     WHERE pol.schemaname = 'public'
       AND ARRAY(SELECT r::text FROM unnest(pol.roles) r) <> ARRAY['amisibiz_app'];
    RAISE NOTICE 'D5. every business policy targets amisibiz_app only | odd=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN _owned_tables o ON o.name = c.relname
     WHERE ns.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'O';
    RAISE NOTICE 'D6. guard triggers all enabled | disabled=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

SELECT 'D7. policy counts on the platform tables' AS check,
       t.tablename, t.cnt AS policies,
       CASE WHEN t.tablename = 'Tenant' AND t.cnt = 3              THEN 'PASS'
            WHEN t.tablename = 'User' AND t.cnt = 3                THEN 'PASS'
            WHEN t.tablename = 'TenantMember' AND t.cnt = 4        THEN 'PASS'
            WHEN t.tablename = 'AuditLog' AND t.cnt = 2            THEN 'PASS'
            WHEN t.tablename = 'TenantStatusHistory' AND t.cnt = 2 THEN 'PASS'
            WHEN t.tablename = 'SupportAccessGrant' AND t.cnt = 3  THEN 'PASS'
            WHEN t.tablename IN ('Permission','RolePermission') AND t.cnt = 1 THEN 'PASS'
            ELSE 'FAIL' END AS result
FROM (SELECT tablename, count(*) AS cnt FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('Tenant','User','TenantMember','AuditLog','TenantStatusHistory',
                          'SupportAccessGrant','Permission','RolePermission')
      GROUP BY tablename) t
ORDER BY t.tablename;

-- ── E. privileges: exactly the owned tables, nothing else ────────────────────
DO $$
DECLARE
    n integer; v_missing integer; v_leak integer; v_granted boolean;
BEGIN
    SELECT count(*) INTO n FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN _owned_tables o ON o.name = c.relname
     WHERE ns.nspname = 'public' AND c.relkind = 'r'
       AND has_table_privilege('amisibiz_app', c.oid, 'SELECT');
    RAISE NOTICE 'E1. app role can SELECT each owned table | tables=% (expect 24) | %', n,
        CASE WHEN n = 24 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO v_missing FROM _owned_tables o
     WHERE NOT has_table_privilege('amisibiz_app', 'public.' || quote_ident(o.name), 'SELECT');
    RAISE NOTICE 'E2. no owned table missing its grant | missing=% (expect 0) | %', v_missing,
        CASE WHEN v_missing = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- Anything in `public` that is not ours must be invisible to the runtime
    -- role: the shared project's other application lives here, and in the live
    -- Supabase project that is roughly 95 tables owned by a different system.
    SELECT count(*) INTO v_leak FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      LEFT JOIN _owned_tables o ON o.name = c.relname
     WHERE ns.nspname = 'public' AND c.relkind IN ('r','v','m','p') AND o.name IS NULL
       AND c.relname <> '_prisma_migrations'
       AND (has_table_privilege('amisibiz_app', c.oid, 'SELECT')
         OR has_table_privilege('amisibiz_app', c.oid, 'INSERT')
         OR has_table_privilege('amisibiz_app', c.oid, 'UPDATE')
         OR has_table_privilege('amisibiz_app', c.oid, 'DELETE'));
    RAISE NOTICE 'E3. no privileges on foreign tables | leaking=% (expect 0) | %', v_leak,
        CASE WHEN v_leak = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- The clean-room harness plants a real foreign table (`other_app_data`)
    -- before the remediation runs, so E3 is proven against something that used
    -- to be reachable rather than against an empty schema.
    IF to_regclass('public.other_app_data') IS NOT NULL THEN
        SELECT has_table_privilege('amisibiz_app', 'public.other_app_data', 'SELECT')
            OR has_table_privilege('amisibiz_app', 'public.other_app_data', 'INSERT')
          INTO v_granted;
        RAISE NOTICE 'E4. harness foreign table unreachable by the app role | granted=% | %',
            v_granted, CASE WHEN NOT v_granted THEN 'PASS' ELSE 'FAIL' END;
    ELSE
        RAISE NOTICE 'E4. harness foreign table unreachable by the app role | table absent (run the clean room) | SKIP';
    END IF;

    -- Schema reach: `public` and nothing else (auth/storage belong to Supabase's
    -- own roles, not to the AmisiBiz runtime role).
    SELECT count(*) INTO n FROM pg_namespace ns
     WHERE ns.nspname NOT LIKE 'pg_%' AND ns.nspname <> 'information_schema'
       AND ns.nspname <> 'public'
       AND has_schema_privilege('amisibiz_app', ns.oid, 'USAGE');
    RAISE NOTICE 'E5. app role schema usage limited to public | others=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;
    SELECT has_schema_privilege('amisibiz_app', 'public', 'USAGE') INTO v_granted;
    RAISE NOTICE 'E6. app role keeps USAGE on public (positive control) | granted=% | %',
        v_granted, CASE WHEN v_granted THEN 'PASS' ELSE 'FAIL' END;

    -- Sequences: ids come from gen_random_uuid() and the numbering counters are
    -- rows, so the app role must hold no sequence privileges anywhere.
    SELECT count(*) INTO n FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'S'
       AND (has_sequence_privilege('amisibiz_app', c.oid, 'USAGE')
         OR has_sequence_privilege('amisibiz_app', c.oid, 'SELECT')
         OR has_sequence_privilege('amisibiz_app', c.oid, 'UPDATE'));
    RAISE NOTICE 'E7. no sequence privileges for the app role | granted=% | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
        SELECT has_table_privilege('amisibiz_app', 'public._prisma_migrations', 'SELECT')
            OR has_table_privilege('amisibiz_app', 'public._prisma_migrations', 'INSERT')
            OR has_table_privilege('amisibiz_app', 'public._prisma_migrations', 'UPDATE')
            OR has_table_privilege('amisibiz_app', 'public._prisma_migrations', 'DELETE')
          INTO v_granted;
        RAISE NOTICE 'E8. migration bookkeeping closed to the app role | reachable=% | %',
            v_granted, CASE WHEN NOT v_granted THEN 'PASS' ELSE 'FAIL' END;
    ELSE
        RAISE NOTICE 'E8. migration bookkeeping closed to the app role | table absent (raw-SQL scratch) | SKIP';
    END IF;
END $$;

-- The grant ceiling, table by table: no TRUNCATE, no TRIGGER, no REFERENCES, no
-- extra verb beyond the migration's GRANT list.
SELECT 'E9. grant ceiling matches the migration' AS check,
       coalesce(string_agg(x, ', ' ORDER BY x), 'none') AS mismatched,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result
FROM (
    SELECT e.name AS x
      FROM _expected_grants e
      LEFT JOIN (
        SELECT d.relname, string_agg(d.privilege_type, ',' ORDER BY d.privilege_type) AS verbs
          FROM (SELECT DISTINCT c.relname, a.privilege_type::text AS privilege_type
                  FROM pg_class c
                  JOIN pg_namespace ns ON ns.oid = c.relnamespace
                  CROSS JOIN LATERAL aclexplode(c.relacl) a
                 WHERE ns.nspname = 'public' AND c.relkind = 'r'
                   AND a.grantee = 'amisibiz_app'::regrole::oid) d
         GROUP BY d.relname
      ) act ON act.relname = e.name
     WHERE coalesce(act.verbs, '') <> e.verbs
) s;

-- PUBLIC and the PostgREST roles must hold nothing on business tables: a grant
-- to PUBLIC is a policy bypass waiting for some other connection role to appear.
SELECT 'E10. no PUBLIC/anon/authenticated table privileges on owned tables' AS check,
       coalesce(string_agg(x, ', ' ORDER BY x), 'none') AS offending,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result
FROM (
    SELECT DISTINCT c.relname AS x
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN _owned_tables o ON o.name = c.relname
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE ns.nspname = 'public' AND c.relkind = 'r'
       AND (a.grantee = 0
            OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated')))
) s;

-- The default-privilege river: a table created AFTER remediation must be born
-- invisible to the runtime role. Probed inside a transaction and rolled back, so
-- the check itself leaves no schema drift.
BEGIN;
CREATE TABLE public._phase1_probe_table (id integer);
DO $$
DECLARE v boolean;
BEGIN
    SELECT has_table_privilege('amisibiz_app', 'public._phase1_probe_table', 'SELECT')
        OR has_table_privilege('amisibiz_app', 'public._phase1_probe_table', 'INSERT')
      INTO v;
    RAISE NOTICE 'E11. default privileges stopped (new table unreachable) | granted=% | %',
        v, CASE WHEN NOT v THEN 'PASS' ELSE 'FAIL' END;
END $$;
ROLLBACK;

-- Function privileges: the policy machinery is callable by the runtime role and
-- by nobody else, except the two Storage helpers `authenticated` needs to
-- evaluate its own policies. PUBLIC reach is read from proacl directly, because
-- a NULL acl still means "PUBLIC may execute".
DO $$
DECLARE v integer;
BEGIN
    SELECT count(*) INTO v FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN _helper_fns h ON h.name = p.proname
     WHERE ns.nspname = 'public'
       AND (p.proacl IS NULL
            OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
    RAISE NOTICE 'E12. policy helpers revoked from PUBLIC | still_public=% (expect 0) | %', v,
        CASE WHEN v = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO v FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN _helper_fns h ON h.name = p.proname
     WHERE ns.nspname = 'public'
       AND NOT has_function_privilege('amisibiz_app', p.oid::regprocedure, 'EXECUTE');
    RAISE NOTICE 'E13. policy helpers executable by the app role | missing=% (expect 0) | %', v,
        CASE WHEN v = 0 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO v FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('app_object_tenant_id','app_is_tenant_member')
       AND NOT has_function_privilege('authenticated', p.oid::regprocedure, 'EXECUTE');
    RAISE NOTICE 'E14. Storage policy helpers executable by authenticated | missing=% (expect 0) | %', v,
        CASE WHEN v = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- The functions that answer "who am I in this tenant" must not be callable
    -- through the REST roles, or an anonymous caller could probe membership.
    SELECT count(*) INTO v FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN _helper_fns h ON h.name = p.proname
     WHERE ns.nspname = 'public' AND to_regclass('public.other_app_data') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'authenticated')
       AND has_function_privilege('authenticated', p.oid::regprocedure, 'EXECUTE')
       AND p.proname NOT IN ('app_object_tenant_id','app_is_tenant_member');
    RAISE NOTICE 'E15. only the two Storage helpers reach authenticated | extra=% (expect 0) | %', v,
        CASE WHEN v = 0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- ── F. Storage: private bucket, membership-derived path, nothing for anon ────
DO $$
DECLARE v integer; b boolean;
BEGIN
    IF to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'F0. storage schema absent | SKIP (Supabase-only section)';
        RETURN;
    END IF;

    SELECT count(*) INTO v FROM storage.buckets
     WHERE id = 'tenant-branding' AND public = false
       AND file_size_limit = 5242880
       AND cardinality(allowed_mime_types) = 3
       AND allowed_mime_types <@ ARRAY['image/png','image/jpeg','image/webp']::text[];
    RAISE NOTICE 'F1. tenant-branding bucket is private, 5MB, three image types | matches=% (expect 1) | %', v,
        CASE WHEN v = 1 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO v FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'tenant_branding_objects_%';
    RAISE NOTICE 'F2. four object policies (select/insert/update/delete) | count=% (expect 4) | %', v,
        CASE WHEN v = 4 THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO v FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'tenant_branding_objects_%'
       AND EXISTS (SELECT 1 FROM unnest(roles) r WHERE r::text IN ('anon','public'));
    RAISE NOTICE 'F3. no anon/public branding policies | count=% (expect 0) | %', v,
        CASE WHEN v = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- The path parser is the only thing standing between two tenants that share
    -- a bucket: anything not shaped `tenants/<uuid>/…` yields no tenant and is
    -- therefore refused by the membership test.
    SELECT public.app_object_tenant_id('tenants/11111111-2222-4333-8444-555555555555/logo/x.png') IS NOT NULL
       AND public.app_object_tenant_id('other/11111111-2222-4333-8444-555555555555.png') IS NULL
       AND public.app_object_tenant_id('tenants/not-a-uuid/logo/x.png') IS NULL
       AND public.app_object_tenant_id('tenants/') IS NULL
      INTO b;
    RAISE NOTICE 'F4. path parser accepts only tenant-scoped keys | ok=% | %', b,
        CASE WHEN b THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- ── G. numbering: the preview and the allocator must never disagree ──────────
DO $$
DECLARE v integer; v_peek text;
BEGIN
    -- G1/G2 read the fixture's `alpha` tenant; skip them where it is absent.
    IF NOT EXISTS (SELECT 1 FROM "Tenant" WHERE slug = 'alpha') THEN
        RAISE NOTICE 'G1-G2. preview numbering matches the allocator | fixture tenant absent | SKIP';
    ELSE
    -- `peek_document_number` is the read-only twin of the allocator: it must
    -- render the default pattern without moving the counter. Checked on a period
    -- the fixture never used, so the answer is the documented default.
    SELECT public.peek_document_number(t.id, 'QUOTATION', DATE '2031-03-01') INTO v_peek
      FROM "Tenant" t WHERE t.slug = 'alpha';
    RAISE NOTICE 'G1. peek builds the default pattern without allocating | value=% (expect QUO-2031-0001) | %', v_peek,
        CASE WHEN v_peek = 'QUO-2031-0001' THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO v FROM "DocumentNumberSequence" s
      JOIN "Tenant" t ON t.id = s."tenantId"
     WHERE t.slug = 'alpha' AND s.period = '2031';
    RAISE NOTICE 'G2. peek left no sequence row behind | rows=% (expect 0) | %', v,
        CASE WHEN v = 0 THEN 'PASS' ELSE 'FAIL' END;
    END IF;

    SELECT count(*) INTO v FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('allocate_document_number','peek_document_number')
       AND p.prosecdef = true;
    RAISE NOTICE 'G3. numbering functions are SECURITY DEFINER | count=% (expect 2) | %', v,
        CASE WHEN v = 2 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- ── H. the context readers fail closed ───────────────────────────────────────
DO $$
DECLARE v integer;
BEGIN
    SELECT count(*) INTO v
      FROM (SELECT public.current_tenant_id() AS a, public.current_user_id() AS b) s
     WHERE s.a IS NULL AND s.b IS NULL;
    RAISE NOTICE 'H1. unset context reads as NULL (policies match nothing) | ok=% | %', v,
        CASE WHEN v = 1 THEN 'PASS' ELSE 'FAIL' END;

    -- A malformed value is refused at the gate, not smuggled in as text that
    -- would then error on every later policy evaluation.
    BEGIN
        PERFORM public.set_tenant_context('not-a-uuid', '', '', false, false);
        RAISE NOTICE 'H2. malformed tenant id rejected at set_tenant_context | accepted | FAIL';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'H2. malformed tenant id rejected at set_tenant_context | sqlstate=% | PASS', SQLSTATE;
    END;

    -- With no context at all, even a real tenant id resolves to nothing: the
    -- helpers find no membership and no platform role for a NULL actor.
    SELECT count(*) INTO v FROM "Tenant" t
     WHERE public.has_tenant_read_access(t.id)
        OR public.has_tenant_write_access(t.id)
        OR public.has_tenant_admin_access(t.id);
    RAISE NOTICE 'H3. empty context grants access to no tenant | matches=% (expect 0) | %', v,
        CASE WHEN v = 0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- ── I. platform authority is re-derived, never trusted from the caller ──────
-- The single most important property of the design: the GUC role/flags a request
-- sets are advisory. A caller that claims to be a platform administrator, or a
-- tenant owner it is not, gets exactly what the rows say.
DO $$
DECLARE
    v_tid uuid; v_uid uuid; v boolean; v_role text; n integer;
BEGIN
    SELECT id INTO v_tid FROM "Tenant" WHERE slug = 'alpha';
    -- invitee E has no seat in alpha and no platform role.
    SELECT id INTO v_uid FROM "User" WHERE email = 'invitee@example.com';

    -- Section I speaks about named fixture people, so an empty database skips it
    -- rather than passing for the wrong reason.
    IF v_tid IS NULL OR v_uid IS NULL THEN
        RAISE NOTICE 'I1-I6. platform authority is re-derived from rows | fixture rows absent | SKIP';
        RETURN;
    END IF;

    PERFORM public.set_tenant_context(v_tid::text, v_uid::text, 'TENANT_OWNER', true, true);

    SELECT public.is_platform_admin() INTO v;
    RAISE NOTICE 'I1. claimed is_platform_admin ignored (DB says USER) | value=% | %', v,
        CASE WHEN NOT v THEN 'PASS' ELSE 'FAIL' END;

    SELECT public.is_platform_support() INTO v;
    RAISE NOTICE 'I2. claimed is_platform_support ignored | value=% | %', v,
        CASE WHEN NOT v THEN 'PASS' ELSE 'FAIL' END;

    SELECT public.app_tenant_role(v_tid)::text INTO v_role;
    RAISE NOTICE 'I3. claimed TENANT_OWNER role yields no real role | value=% (expect NULL) | %', v_role,
        CASE WHEN v_role IS NULL THEN 'PASS' ELSE 'FAIL' END;

    SELECT count(*) INTO n FROM "Tenant" t
      WHERE public.has_tenant_read_access(t.id) OR public.has_tenant_write_access(t.id);
    RAISE NOTICE 'I4. forged context can reach zero tenants | reachable=% (expect 0) | %', n,
        CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END;

    -- Positive control: the same helpers do grant when the rows back the claim,
    -- so I1-I4 above cannot be a helper that simply always says no.
    SELECT id INTO v_uid FROM "User" WHERE email = 'owner.e@example.com';
    PERFORM public.set_tenant_context(v_tid::text, v_uid::text, 'VIEWER', false, false);
    SELECT public.app_tenant_role(v_tid)::text INTO v_role;
    SELECT public.has_tenant_read_access(v_tid) INTO v;
    RAISE NOTICE 'I5. real owner seat is honoured despite a VIEWER claim | role=% read=% | %',
        v_role, v, CASE WHEN v_role = 'TENANT_OWNER' AND v THEN 'PASS' ELSE 'FAIL' END;

    PERFORM public.clear_tenant_context();
    SELECT count(*) INTO n
      FROM (SELECT public.current_tenant_id() AS a, public.current_user_id() AS b) s
     WHERE s.a IS NULL AND s.b IS NULL;
    RAISE NOTICE 'I6. clear_tenant_context scrubs session scope too | ok=% | %', n,
        CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;
END $$;
