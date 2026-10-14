-- Migration: Phase 1 — RBAC catalog, support access and tenant status history.
-- Created: 2026-10-18
--
-- Why this file exists: the Phase 1 directive names "permissions" and a
-- "tenant status history" as schema items, and the separately authorized
-- support-access mechanism (§6 of docs/implementation/phase-01-security-design.md)
-- needs its grant table. Four tables are created here, together with the
-- authoritative seed of the permission catalog and the role→permission matrix.
--
-- Rules this file implements:
--   * The permission catalog is defined in code
--     (`packages/auth/src/permissions.ts`) and mirrored here by seed. An
--     integration test asserts the two are identical in both directions, so
--     the database copy can never silently drift. The seed counts are asserted
--     inside the migration itself — a typo'd key fails the migration instead of
--     quietly seeding a smaller catalog.
--   * RolePermission rows are inserted against the permission's OWN domain
--     (`p.domain`), and a CHECK ties the role name to the domain: a tenant
--     role can never hold a `platform.*` permission and a platform role can
--     never hold a tenant permission. That is the schema-level half of the
--     separation invariant; the code matrix is the other half.
--   * SupportAccessGrant is the audited door through which platform support
--     staff reach a tenant's data: time-boxed (`expiresAt` in the future,
--     enforced against `createdAt`), revocable (`revokedAt`), and always
--     carrying a real business justification. Grants confer read-only access —
--     enforced by the policies in 20261018000002, not by convention here.
--   * TenantStatusHistory is append-only (trigger, not convention): the
--     lifecycle log of a tenant is evidence and is never rewritten.
--   * Row level security is enabled on all four tables here; the policies
--     arrive in 20261018000002_rls_enforcement_storage_and_grants. Until that
--     migration is applied the runtime role sees nothing (deny by default),
--     which is the correct posture for the window between two migrations that
--     are applied as one unit.
--   * Grants are explicit (the Phase 03 blanket grants that sweep in the other
--     application's tables are revoked in 20261018000002; this file already
--     revokes the inherited default privileges on its own tables so its end
--     state is exact on its own).

-- ─── A. Permission catalog ───────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Permission" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Permission_domain_idx" ON "Permission"("domain");

-- CreateIndex
CREATE INDEX "Permission_area_idx" ON "Permission"("area");

-- ─── B. Role → permission matrix ─────────────────────────────────────────────

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "roleKey" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "permissionId" uuid NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleKey_permissionId_key" ON "RolePermission"("roleKey", "permissionId");

-- CreateIndex
CREATE INDEX "RolePermission_roleKey_idx" ON "RolePermission"("roleKey");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- ─── C. Support access grants ────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "SupportAccessGrant" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" uuid NOT NULL,
    "platformUserId" uuid NOT NULL,
    "grantedById" uuid,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportAccessGrant_tenantId_idx" ON "SupportAccessGrant"("tenantId");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_platformUserId_idx" ON "SupportAccessGrant"("platformUserId");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_platformUserId_tenantId_idx" ON "SupportAccessGrant"("platformUserId", "tenantId");

-- ─── D. Tenant status history ────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "TenantStatusHistory" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" uuid NOT NULL,
    "fromStatus" "TenantStatus",
    "toStatus" "TenantStatus" NOT NULL,
    "changedById" uuid,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantStatusHistory_tenantId_idx" ON "TenantStatusHistory"("tenantId");

-- CreateIndex
CREATE INDEX "TenantStatusHistory_tenantId_createdAt_idx" ON "TenantStatusHistory"("tenantId", "createdAt");

-- ─── Foreign keys ────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantStatusHistory" ADD CONSTRAINT "TenantStatusHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantStatusHistory" ADD CONSTRAINT "TenantStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Constraints ─────────────────────────────────────────────────────────────
-- The database repeats the shape rules the application enforces, so a write
-- that bypasses the application (a script, a manual UPDATE) cannot mint a
-- malformed permission, a cross-domain role grant or a backdated support grant.

ALTER TABLE "Permission"
    ADD CONSTRAINT "Permission_domain_is_known"
        CHECK ("domain" IN ('platform', 'tenant')),
    -- The domain split is a prefix rule, not a lookup: everything `platform.*`
    -- is internal staff authority, everything else is tenant business data.
    ADD CONSTRAINT "Permission_domain_matches_prefix"
        CHECK (("domain" = 'platform') = ("key" LIKE 'platform.%')),
    ADD CONSTRAINT "Permission_key_is_well_formed"
        CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    ADD CONSTRAINT "Permission_area_is_well_formed"
        CHECK ("area" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
    ADD CONSTRAINT "Permission_description_is_bounded"
        CHECK (char_length(btrim("description")) BETWEEN 1 AND 300);

ALTER TABLE "RolePermission"
    ADD CONSTRAINT "RolePermission_role_is_known"
        CHECK ("roleKey" IN (
            'SUPER_ADMIN', 'SUPPORT',
            'TENANT_OWNER', 'TENANT_ADMIN', 'SALES', 'FINANCE', 'OPERATIONS',
            'VIEWER', 'CUSTOMER_PORTAL_USER'
        )),
    ADD CONSTRAINT "RolePermission_domain_is_known"
        CHECK ("domain" IN ('platform', 'tenant')),
    -- The separation invariant, enforced per row: platform roles hold only
    -- platform permissions, tenant roles only tenant permissions. An owner
    -- membership can therefore never confer platform authority, whatever the
    -- application does.
    ADD CONSTRAINT "RolePermission_domain_matches_role"
        CHECK (("roleKey" IN ('SUPER_ADMIN', 'SUPPORT')) = ("domain" = 'platform'));

ALTER TABLE "SupportAccessGrant"
    ADD CONSTRAINT "SupportAccessGrant_reason_is_a_justification"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
    -- A grant that expires before it exists is a configuration mistake, not a
    -- shorter grant; refusing it keeps "expired" a meaningful state.
    ADD CONSTRAINT "SupportAccessGrant_expiry_is_after_creation"
        CHECK ("expiresAt" > "createdAt"),
    ADD CONSTRAINT "SupportAccessGrant_revocation_is_after_creation"
        CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt");

ALTER TABLE "TenantStatusHistory"
    -- A history row records a transition; a row where nothing moved is noise
    -- that would confuse the lifecycle trail.
    ADD CONSTRAINT "TenantStatusHistory_transition_is_not_a_no_op"
        CHECK ("fromStatus" IS DISTINCT FROM "toStatus"),
    ADD CONSTRAINT "TenantStatusHistory_reason_is_bounded"
        CHECK (coalesce(char_length("reason"), 0) <= 500);

-- Append-only, at the database level: suspension and reactivation must stay
-- reconstructable, so a history row is written once and never touched again.
CREATE OR REPLACE FUNCTION tenant_status_history_is_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Tenant status history is append-only; row % cannot be changed or removed', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_status_history_is_append_only
    BEFORE UPDATE OR DELETE ON "TenantStatusHistory"
    FOR EACH ROW EXECUTE FUNCTION tenant_status_history_is_append_only();

-- ─── Seed: the 38-permission catalog (mirrors PERMISSION_DEFINITIONS) ────────
-- Descriptions are part of the mirrored data: the parity test compares them.

DO $$
DECLARE
    v_inserted integer;
    v_expected constant integer := 38;
BEGIN
    INSERT INTO "Permission" ("id", "key", "domain", "area", "description")
    SELECT gen_random_uuid(), v."key", v."domain", v."area", v."description"
      FROM (VALUES
        -- Platform domain
        ('platform.tenants.read',        'platform', 'tenants',  'View tenant list and details'),
        ('platform.tenants.create',      'platform', 'tenants',  'Provision new tenants'),
        ('platform.tenants.activate',    'platform', 'tenants',  'Activate (or reactivate) a tenant'),
        ('platform.tenants.suspend',     'platform', 'tenants',  'Suspend a tenant'),
        ('platform.support.grant',       'platform', 'support',  'Grant and revoke support access to a tenant'),

        -- Business settings / branding
        ('business.settings.read',       'tenant',   'settings', 'View workspace settings'),
        ('business.settings.update',     'tenant',   'settings', 'Update workspace settings'),
        ('business.branding.read',       'tenant',   'branding', 'View tenant branding'),
        ('business.branding.update',     'tenant',   'branding', 'Update tenant branding and logo'),
        ('business.members.read',        'tenant',   'members',  'View team members and invitations'),
        ('business.members.manage',      'tenant',   'members',  'Invite, update and remove team members'),

        -- Contacts
        ('contacts.read',                'tenant',   'contacts', 'View contacts'),
        ('contacts.create',              'tenant',   'contacts', 'Create contacts'),
        ('contacts.update',              'tenant',   'contacts', 'Update contacts'),
        ('contacts.delete',              'tenant',   'contacts', 'Delete contacts'),

        -- Items (catalogue)
        ('items.read',                   'tenant',   'items',    'View catalogue items'),
        ('items.create',                 'tenant',   'items',    'Create catalogue items'),
        ('items.update',                 'tenant',   'items',    'Update catalogue items'),
        ('items.delete',                 'tenant',   'items',    'Delete catalogue items'),

        -- Documents (generic read/download)
        ('documents.read',               'tenant',   'documents', 'View sales documents'),
        ('documents.download',           'tenant',   'documents', 'Download sales document PDFs'),

        -- Quotations
        ('documents.quotation.create',       'tenant', 'documents.quotation', 'Create quotations'),
        ('documents.quotation.update_draft', 'tenant', 'documents.quotation', 'Edit draft quotations'),
        ('documents.quotation.issue',        'tenant', 'documents.quotation', 'Issue quotations'),
        ('documents.quotation.void',         'tenant', 'documents.quotation', 'Void quotations'),

        -- Invoices
        ('documents.invoice.create',       'tenant', 'documents.invoice', 'Create invoices'),
        ('documents.invoice.update_draft', 'tenant', 'documents.invoice', 'Edit draft invoices'),
        ('documents.invoice.issue',        'tenant', 'documents.invoice', 'Issue invoices'),
        ('documents.invoice.void',         'tenant', 'documents.invoice', 'Void invoices'),

        -- Delivery notes
        ('documents.delivery_note.create',       'tenant', 'documents.delivery_note', 'Create delivery notes'),
        ('documents.delivery_note.update_draft', 'tenant', 'documents.delivery_note', 'Edit draft delivery notes'),
        ('documents.delivery_note.issue',        'tenant', 'documents.delivery_note', 'Issue delivery notes'),
        ('documents.delivery_note.void',         'tenant', 'documents.delivery_note', 'Void delivery notes'),

        -- Customer portal
        ('portal.access.manage',         'tenant',   'portal',   'Grant and revoke customer portal access'),
        ('portal.documents.read',        'tenant',   'portal',   'View own documents in the customer portal'),
        ('portal.documents.download',    'tenant',   'portal',   'Download own documents in the customer portal'),

        -- Exports / audit
        ('exports.create',               'tenant',   'exports',  'Export business data'),
        ('audit.read',                   'tenant',   'audit',    'View the audit trail')
      ) AS v("key", "domain", "area", "description");

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted <> v_expected THEN
        RAISE EXCEPTION 'Permission seed inserted % row(s), expected %', v_inserted, v_expected
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── Seed: the role → permission matrix (mirrors TENANT_ROLE_PERMISSIONS / ───
--           PLATFORM_ROLE_PERMISSIONS; 112 rows) ──────────────────────────────
-- SUPPORT deliberately has no rows: support staff hold zero permissions until
-- an active SupportAccessGrant, and even then via the read-only set checked in
-- `has_support_grant()` (code) and the database policies.

DO $$
DECLARE
    v_inserted integer;
    v_expected constant integer := 112;
BEGIN
    INSERT INTO "RolePermission" ("id", "roleKey", "domain", "permissionId")
    SELECT gen_random_uuid(), m."roleKey", p."domain", p."id"
      FROM (VALUES
        -- TENANT_OWNER (31): full control of the workspace
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

        -- TENANT_ADMIN (31): routine operations incl. members, with guards
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

        -- SALES (13): contacts/catalogue without deletes, quotations e2e
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

        -- FINANCE (11): invoices e2e, exports; the rest read-only
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

        -- OPERATIONS (12): catalogue create/update, delivery notes e2e
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

        -- VIEWER (7): read-only
        ('VIEWER', 'business.settings.read'),
        ('VIEWER', 'business.branding.read'),
        ('VIEWER', 'business.members.read'),
        ('VIEWER', 'contacts.read'),
        ('VIEWER', 'items.read'),
        ('VIEWER', 'documents.read'),
        ('VIEWER', 'documents.download'),

        -- CUSTOMER_PORTAL_USER (2): the portal only, never internal records
        ('CUSTOMER_PORTAL_USER', 'portal.documents.read'),
        ('CUSTOMER_PORTAL_USER', 'portal.documents.download'),

        -- SUPER_ADMIN (5): every platform permission
        ('SUPER_ADMIN', 'platform.tenants.read'),
        ('SUPER_ADMIN', 'platform.tenants.create'),
        ('SUPER_ADMIN', 'platform.tenants.activate'),
        ('SUPER_ADMIN', 'platform.tenants.suspend'),
        ('SUPER_ADMIN', 'platform.support.grant')
      ) AS m("roleKey", "permission")
      JOIN "Permission" p ON p."key" = m."permission";

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted <> v_expected THEN
        RAISE EXCEPTION
            'RolePermission seed inserted % row(s), expected % — a permission key in the seed does not exist in the catalog',
            v_inserted, v_expected
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── Row level security ──────────────────────────────────────────────────────
-- Enabled here, policed in 20261018000002. With RLS on and no policy yet, the
-- runtime role sees nothing — the window between the two migrations is closed,
-- not open.

ALTER TABLE "Permission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportAccessGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantStatusHistory" ENABLE ROW LEVEL SECURITY;

-- ─── Grants (exact, per table) ───────────────────────────────────────────────
-- The Phase 03 `ALTER DEFAULT PRIVILEGES` would otherwise sweep these tables
-- into a SELECT/INSERT/UPDATE/DELETE grant; revoking first keeps this file's
-- end state exact. `amisibiz_app` reads the catalogs, appends history and
-- manages grants (policies decide who, within those verbs).

REVOKE ALL ON "Permission", "RolePermission", "TenantStatusHistory", "SupportAccessGrant" FROM amisibiz_app;

GRANT SELECT ON "Permission" TO amisibiz_app;
GRANT SELECT ON "RolePermission" TO amisibiz_app;
GRANT SELECT, INSERT ON "TenantStatusHistory" TO amisibiz_app;
GRANT SELECT, INSERT, UPDATE ON "SupportAccessGrant" TO amisibiz_app;

-- ─── Comments ────────────────────────────────────────────────────────────────

COMMENT ON TABLE "Permission" IS 'Permission catalog mirrored from packages/auth/src/permissions.ts; kept identical by an integration test.';
COMMENT ON TABLE "RolePermission" IS 'Role → permission matrix mirrored from the code matrices; platform rows never mix with tenant rows (CHECK).';
COMMENT ON TABLE "SupportAccessGrant" IS 'Time-boxed, revocable, audited, read-only support access. Granted by platform super admins only; every use is audited.';
COMMENT ON TABLE "TenantStatusHistory" IS 'Append-only tenant lifecycle log (created PENDING, activated, suspended, reactivated).';
