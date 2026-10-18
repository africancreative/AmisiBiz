-- Migration: H1 permission-catalog reseed (task #87).
-- Created: 2026-10-30
--
-- Why this file exists: the permission catalog in code
-- (`packages/auth/src/permissions.ts`) and the mirrored database copy
-- ("Permission" / "RolePermission") have drifted. Databases built from the
-- committed migration chain hold 42 keys (the Phase 07 admin-auth catalog seed
-- in 20261024000000_phase07_admin_auth/up.sql is not applied by Prisma — only
-- migration.sql is, and it is an empty shell); the live Neon database holds
-- the same 42. The code catalog is the single source of truth and now holds
-- 57 keys and a 122-row role matrix. This migration brings ANY
-- database at or below that state to exact parity, idempotently.
--
-- Rules this file implements:
--   * Forward-only and ADDITIVE on data: no DELETE, no UPDATE, no TRUNCATE,
--     and no RLS policy touched. It can never weaken a database that is
--     already at parity. The only non-insert statement is section 0, which
--     replaces one CHECK expression with an equivalent-strength rule so the
--     code catalogue becomes seedable (see the section's comment).
--   * Idempotent: every insert is ON CONFLICT DO NOTHING, so re-running the
--     statement (or running it against a fully-seeded database) is a no-op.
--   * The rows below are GENERATED from the code catalog, not hand-written;
--     the generator is kept out-of-band (.tmp/h1_gen_reseed.mts, notes in
--     .tmp/h1-seed-facts.md) and the catalog's parity with the database is
--     asserted by tests/integration-security.test.ts after every deploy.
--   * The in-migration checks make a typo'd or missing row fail the migration
--     loudly instead of leaving a short catalog behind, matching the
--     convention of 20261018000001 and 20261019000000.
--   * RolePermission rows follow the existing seed convention: the row's
--     "domain" is the permission's own domain (p."domain"), which the
--     RolePermission_domain_matches_role CHECK ties to the role — platform
--     roles (SUPER_ADMIN) can therefore only receive platform rows, and
--     SUPPORT receives NO rows at all (by design: support reaches tenant data
--     only through an active, audited SupportAccessGrant).

-- ─── 0. Align the domain CHECK with the code catalog (runs before seeding) ─────
-- 20261018000001 froze the domain split as a PREFIX rule:
--     ("domain" = 'platform') = ("key" LIKE 'platform.%')
-- The code catalogue — the single source of truth — now assigns the platform
-- domain to five keys whose names carry no `platform.` prefix:
--   platform_users.read
--   platform_users.manage
--   audit_logs.read
--   security_events.read
--   support.access_request
-- Keeping the prefix rule makes exact parity unreachable: those rows cannot be
-- inserted with domain 'platform' (the CHECK refuses), and seeding them as
-- 'tenant' is refused by RolePermission_domain_matches_role when SUPER_ADMIN
-- holds them. The CHECK is therefore replaced with the equivalent explicit
-- membership rule: the domain stays fully determined by the key — nothing is
-- unconstrained that was constrained before, and every catalog row becomes
-- representable. All rows seeded by 20261018000001/20261019000000 already
-- satisfy the replacement, so no data changes; this is a realignment to the
-- authoritative code, not a relaxation of the separation invariant.

ALTER TABLE "Permission" DROP CONSTRAINT "Permission_domain_matches_prefix";

ALTER TABLE "Permission"
    ADD CONSTRAINT "Permission_domain_matches_prefix"
        CHECK (("domain" = 'platform') =
               ("key" LIKE 'platform.%' OR "key" IN ('platform_users.read', 'platform_users.manage', 'audit_logs.read', 'security_events.read', 'support.access_request')));

-- ─── A. Permission catalog: upsert all 57 keys ──────────────────────────
-- ON CONFLICT ("key") DO NOTHING: unique index "Permission_key_key" backs the
-- target. Existing rows keep their existing metadata; the seeds that put them
-- there used the same catalogue, and the parity test compares keys.

DO $$
BEGIN
    INSERT INTO "Permission" ("id", "key", "domain", "area", "description")
    SELECT gen_random_uuid(), v."key", v."domain", v."area", v."description"
      FROM (VALUES
        -- Platform domain,
        ('platform.tenants.read', 'platform', 'tenants', 'View tenant list and details'),
        ('platform.tenants.create', 'platform', 'tenants', 'Provision new tenants'),
        ('platform.tenants.update', 'platform', 'tenants', 'Edit a tenant''s profile, branding and document settings'),
        ('platform.tenants.activate', 'platform', 'tenants', 'Activate (or reactivate) a tenant'),
        ('platform.tenants.suspend', 'platform', 'tenants', 'Suspend a tenant'),
        ('platform.tenants.plan.assign', 'platform', 'tenants', 'Assign a subscription plan to a tenant'),
        ('platform.tenants.domain.manage', 'platform', 'tenants', 'Manage a tenant''s workspace slug and hostnames'),
        ('platform.audit.read', 'platform', 'audit', 'View the provider audit trail for any tenant'),
        ('platform.support.grant', 'platform', 'support', 'Grant and revoke support access to a tenant'),
        -- Tenant domain,
        ('business.settings.read', 'tenant', 'settings', 'View workspace settings'),
        ('business.settings.update', 'tenant', 'settings', 'Update workspace settings'),
        ('business.branding.read', 'tenant', 'branding', 'View tenant branding'),
        ('business.branding.update', 'tenant', 'branding', 'Update tenant branding and logo'),
        ('business.members.read', 'tenant', 'members', 'View team members and invitations'),
        ('business.members.manage', 'tenant', 'members', 'Invite, update and remove team members'),
        ('contacts.read', 'tenant', 'contacts', 'View contacts'),
        ('contacts.create', 'tenant', 'contacts', 'Create contacts'),
        ('contacts.update', 'tenant', 'contacts', 'Update contacts'),
        ('contacts.delete', 'tenant', 'contacts', 'Delete contacts'),
        ('items.read', 'tenant', 'items', 'View catalogue items'),
        ('items.create', 'tenant', 'items', 'Create catalogue items'),
        ('items.update', 'tenant', 'items', 'Update catalogue items'),
        ('items.delete', 'tenant', 'items', 'Delete catalogue items'),
        ('documents.read', 'tenant', 'documents', 'View sales documents'),
        ('documents.download', 'tenant', 'documents', 'Download sales document PDFs'),
        ('documents.quotation.create', 'tenant', 'documents.quotation', 'Create quotations'),
        ('documents.quotation.update_draft', 'tenant', 'documents.quotation', 'Edit draft quotations'),
        ('documents.quotation.issue', 'tenant', 'documents.quotation', 'Issue quotations'),
        ('documents.quotation.void', 'tenant', 'documents.quotation', 'Void quotations'),
        ('documents.invoice.create', 'tenant', 'documents.invoice', 'Create invoices'),
        ('documents.invoice.update_draft', 'tenant', 'documents.invoice', 'Edit draft invoices'),
        ('documents.invoice.issue', 'tenant', 'documents.invoice', 'Issue invoices'),
        ('documents.invoice.void', 'tenant', 'documents.invoice', 'Void invoices'),
        ('documents.delivery_note.create', 'tenant', 'documents.delivery_note', 'Create delivery notes'),
        ('documents.delivery_note.update_draft', 'tenant', 'documents.delivery_note', 'Edit draft delivery notes'),
        ('documents.delivery_note.issue', 'tenant', 'documents.delivery_note', 'Issue delivery notes'),
        ('documents.delivery_note.void', 'tenant', 'documents.delivery_note', 'Void delivery notes'),
        ('portal.access.manage', 'tenant', 'portal', 'Grant and revoke customer portal access'),
        ('portal.documents.read', 'tenant', 'portal', 'View own documents in the customer portal'),
        ('portal.documents.download', 'tenant', 'portal', 'Download own documents in the customer portal'),
        ('exports.create', 'tenant', 'exports', 'Export business data'),
        -- Platform domain,
        ('platform.dashboard.read', 'platform', 'dashboard', 'View the platform administration dashboard'),
        -- Tenant domain,
        ('tenants.read', 'tenant', 'tenants', 'View tenant list and details'),
        ('tenants.create', 'tenant', 'tenants', 'Provision new tenants'),
        ('tenants.activate', 'tenant', 'tenants', 'Activate (or reactivate) a tenant'),
        ('tenants.suspend', 'tenant', 'tenants', 'Suspend a tenant'),
        ('tenants.reactivate', 'tenant', 'tenants', 'Reactivate a suspended tenant'),
        ('subscriptions.read', 'tenant', 'subscriptions', 'View subscription plans and tenant subscription status'),
        ('subscriptions.manage', 'tenant', 'subscriptions', 'Assign or modify subscription plans for tenants'),
        ('branding.read', 'tenant', 'branding', 'View tenant branding configuration'),
        ('branding.manage', 'tenant', 'branding', 'Update tenant branding and logo'),
        -- Platform domain,
        ('platform_users.read', 'platform', 'platform_users', 'View platform administrator accounts and roles'),
        ('platform_users.manage', 'platform', 'platform_users', 'Create, update and revoke platform administrator accounts'),
        ('audit_logs.read', 'platform', 'audit_logs', 'View the platform administration audit trail'),
        ('security_events.read', 'platform', 'security_events', 'View security-relevant events and access control changes'),
        ('support.access_request', 'platform', 'support', 'Submit and track support access grant requests'),
        -- Tenant domain,
        ('audit.read', 'tenant', 'audit', 'View the audit trail')
      ) AS v("key", "domain", "area", "description")
     ON CONFLICT ("key") DO NOTHING;

    IF (SELECT count(*) FROM "Permission") <> 57 THEN
        RAISE EXCEPTION
            'H1 reseed: "Permission" holds % row(s) after the upsert, expected exactly 57 — a key in the database is not in the code catalog (additive reseed cannot remove it)',
            (SELECT count(*) FROM "Permission")
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── B. Role → permission matrix: upsert all 122 pairs ───────────────────
-- permissionId resolves through the "Permission" table by key (the catalogue
-- rows above are guaranteed present by block A). ON CONFLICT targets the
-- unique index RolePermission_roleKey_permissionId_key, matching the
-- convention of 20261018000001 / 20261019000000.

DO $$
BEGIN
    INSERT INTO "RolePermission" ("id", "roleKey", "domain", "permissionId")
    SELECT gen_random_uuid(), m."roleKey", p."domain", p."id"
      FROM (VALUES
        -- TENANT_OWNER (31)
        ('TENANT_OWNER', 'business.settings.read'),
        ('TENANT_OWNER', 'business.settings.update'),
        ('TENANT_OWNER', 'business.branding.read'),
        ('TENANT_OWNER', 'business.branding.update'),
        ('TENANT_OWNER', 'business.members.read'),
        ('TENANT_OWNER', 'business.members.manage'),
        ('TENANT_OWNER', 'contacts.read'),
        ('TENANT_OWNER', 'contacts.create'),
        ('TENANT_OWNER', 'contacts.update'),
        ('TENANT_OWNER', 'contacts.delete'),
        ('TENANT_OWNER', 'items.read'),
        ('TENANT_OWNER', 'items.create'),
        ('TENANT_OWNER', 'items.update'),
        ('TENANT_OWNER', 'items.delete'),
        ('TENANT_OWNER', 'documents.read'),
        ('TENANT_OWNER', 'documents.download'),
        ('TENANT_OWNER', 'documents.quotation.create'),
        ('TENANT_OWNER', 'documents.quotation.update_draft'),
        ('TENANT_OWNER', 'documents.quotation.issue'),
        ('TENANT_OWNER', 'documents.quotation.void'),
        ('TENANT_OWNER', 'documents.invoice.create'),
        ('TENANT_OWNER', 'documents.invoice.update_draft'),
        ('TENANT_OWNER', 'documents.invoice.issue'),
        ('TENANT_OWNER', 'documents.invoice.void'),
        ('TENANT_OWNER', 'documents.delivery_note.create'),
        ('TENANT_OWNER', 'documents.delivery_note.update_draft'),
        ('TENANT_OWNER', 'documents.delivery_note.issue'),
        ('TENANT_OWNER', 'documents.delivery_note.void'),
        ('TENANT_OWNER', 'portal.access.manage'),
        ('TENANT_OWNER', 'exports.create'),
        ('TENANT_OWNER', 'audit.read'),
        -- TENANT_ADMIN (31)
        ('TENANT_ADMIN', 'business.settings.read'),
        ('TENANT_ADMIN', 'business.settings.update'),
        ('TENANT_ADMIN', 'business.branding.read'),
        ('TENANT_ADMIN', 'business.branding.update'),
        ('TENANT_ADMIN', 'business.members.read'),
        ('TENANT_ADMIN', 'business.members.manage'),
        ('TENANT_ADMIN', 'contacts.read'),
        ('TENANT_ADMIN', 'contacts.create'),
        ('TENANT_ADMIN', 'contacts.update'),
        ('TENANT_ADMIN', 'contacts.delete'),
        ('TENANT_ADMIN', 'items.read'),
        ('TENANT_ADMIN', 'items.create'),
        ('TENANT_ADMIN', 'items.update'),
        ('TENANT_ADMIN', 'items.delete'),
        ('TENANT_ADMIN', 'documents.read'),
        ('TENANT_ADMIN', 'documents.download'),
        ('TENANT_ADMIN', 'documents.quotation.create'),
        ('TENANT_ADMIN', 'documents.quotation.update_draft'),
        ('TENANT_ADMIN', 'documents.quotation.issue'),
        ('TENANT_ADMIN', 'documents.quotation.void'),
        ('TENANT_ADMIN', 'documents.invoice.create'),
        ('TENANT_ADMIN', 'documents.invoice.update_draft'),
        ('TENANT_ADMIN', 'documents.invoice.issue'),
        ('TENANT_ADMIN', 'documents.invoice.void'),
        ('TENANT_ADMIN', 'documents.delivery_note.create'),
        ('TENANT_ADMIN', 'documents.delivery_note.update_draft'),
        ('TENANT_ADMIN', 'documents.delivery_note.issue'),
        ('TENANT_ADMIN', 'documents.delivery_note.void'),
        ('TENANT_ADMIN', 'portal.access.manage'),
        ('TENANT_ADMIN', 'exports.create'),
        ('TENANT_ADMIN', 'audit.read'),
        -- SALES (13)
        ('SALES', 'business.settings.read'),
        ('SALES', 'business.branding.read'),
        ('SALES', 'contacts.read'),
        ('SALES', 'contacts.create'),
        ('SALES', 'contacts.update'),
        ('SALES', 'items.read'),
        ('SALES', 'items.create'),
        ('SALES', 'items.update'),
        ('SALES', 'documents.read'),
        ('SALES', 'documents.download'),
        ('SALES', 'documents.quotation.create'),
        ('SALES', 'documents.quotation.update_draft'),
        ('SALES', 'documents.quotation.issue'),
        -- FINANCE (11)
        ('FINANCE', 'business.settings.read'),
        ('FINANCE', 'business.branding.read'),
        ('FINANCE', 'contacts.read'),
        ('FINANCE', 'items.read'),
        ('FINANCE', 'documents.read'),
        ('FINANCE', 'documents.download'),
        ('FINANCE', 'documents.invoice.create'),
        ('FINANCE', 'documents.invoice.update_draft'),
        ('FINANCE', 'documents.invoice.issue'),
        ('FINANCE', 'documents.invoice.void'),
        ('FINANCE', 'exports.create'),
        -- OPERATIONS (12)
        ('OPERATIONS', 'business.settings.read'),
        ('OPERATIONS', 'business.branding.read'),
        ('OPERATIONS', 'contacts.read'),
        ('OPERATIONS', 'items.read'),
        ('OPERATIONS', 'items.create'),
        ('OPERATIONS', 'items.update'),
        ('OPERATIONS', 'documents.read'),
        ('OPERATIONS', 'documents.download'),
        ('OPERATIONS', 'documents.delivery_note.create'),
        ('OPERATIONS', 'documents.delivery_note.update_draft'),
        ('OPERATIONS', 'documents.delivery_note.issue'),
        ('OPERATIONS', 'documents.delivery_note.void'),
        -- VIEWER (7)
        ('VIEWER', 'business.settings.read'),
        ('VIEWER', 'business.branding.read'),
        ('VIEWER', 'business.members.read'),
        ('VIEWER', 'contacts.read'),
        ('VIEWER', 'items.read'),
        ('VIEWER', 'documents.read'),
        ('VIEWER', 'documents.download'),
        -- CUSTOMER_PORTAL_USER (2)
        ('CUSTOMER_PORTAL_USER', 'portal.documents.read'),
        ('CUSTOMER_PORTAL_USER', 'portal.documents.download'),
        -- SUPER_ADMIN (15)
        ('SUPER_ADMIN', 'platform.tenants.read'),
        ('SUPER_ADMIN', 'platform.tenants.create'),
        ('SUPER_ADMIN', 'platform.tenants.update'),
        ('SUPER_ADMIN', 'platform.tenants.activate'),
        ('SUPER_ADMIN', 'platform.tenants.suspend'),
        ('SUPER_ADMIN', 'platform.tenants.plan.assign'),
        ('SUPER_ADMIN', 'platform.tenants.domain.manage'),
        ('SUPER_ADMIN', 'platform.audit.read'),
        ('SUPER_ADMIN', 'platform.support.grant'),
        ('SUPER_ADMIN', 'platform.dashboard.read'),
        ('SUPER_ADMIN', 'platform_users.read'),
        ('SUPER_ADMIN', 'platform_users.manage'),
        ('SUPER_ADMIN', 'audit_logs.read'),
        ('SUPER_ADMIN', 'security_events.read'),
        ('SUPER_ADMIN', 'support.access_request')
        -- SUPPORT (0): holds no permissions by design
      ) AS m("roleKey", "permission")
      JOIN "Permission" p ON p."key" = m."permission"
     ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

    -- Every matrix pair is now present (insert above covers all of them); a
    -- total above 122 means the database holds a matrix row that is NOT
    -- in the code catalog — additive reseeding cannot fix that, so fail loud.
    IF (SELECT count(*) FROM "RolePermission") <> 122 THEN
        RAISE EXCEPTION
            'H1 reseed: "RolePermission" holds % row(s) after the upsert, expected exactly 122 — the database carries a matrix row outside the code catalog',
            (SELECT count(*) FROM "RolePermission")
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── C. Verification (informational, run after deploy) ────────────────────────
-- SELECT count(*) FROM "Permission";      -- expect 57
-- SELECT count(*) FROM "RolePermission";  -- expect 122
-- SELECT "roleKey", count(*) FROM "RolePermission" GROUP BY "roleKey" ORDER BY 1;
--   CUSTOMER_PORTAL_USER 2 | FINANCE 11 | OPERATIONS 12 | SALES 13 |
--   SUPER_ADMIN 15 | TENANT_ADMIN 31 | TENANT_OWNER 31 | VIEWER 7 | SUPPORT 0

-- The catalog and matrix remain mirrored from packages/auth/src/permissions.ts;
-- tests/integration-security.test.ts ("code ↔ database catalog parity") keeps
-- them identical in both directions after this point.
