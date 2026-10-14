-- Migration: Phase 2 — provider administration: plans, suspension gates and the
--            platform permission set.
-- Created: 2026-10-19
--
-- Why this file exists: the Phase 2 directive makes Amisi Genuine the sole
-- controller of the tenant lifecycle ("the MVP uses manual provider-controlled
-- activation and suspension"), gives the provider a subscription-plan label and
-- tenant-facing branding/domain management, and defines what suspension actually
-- means. The owner chose four semantics that this file encodes in the database:
--
--   1. SUSPENDED denies WRITES and synchronization writes, but READS and
--      downloads of already-issued documents keep working. Suspension never
--      deletes a business row and never touches a storage object — so nothing
--      here cascades, archives or removes tenant data.
--   2. A plan is information only: no price, no limit, no entitlement. It exists
--      so an operator can record the commercial arrangement they are acting on,
--      and it grants no access. That is also why no job, trigger or check in this
--      file can suspend a tenant for a payment that is overdue: the lifecycle
--      moves only through an authorized platform action (see
--      `tenant_status_guard` from 20261018000002, untouched here).
--   3. Platform authority is never gated by tenant status. A provider must be
--      able to rename, re-brand, re-plan and reactivate a suspended workspace,
--      so every `is_platform_admin()` branch stays unconditional and the new
--      status check is applied to the MEMBER branch only.
--   4. Tenant-facing self-service is unchanged in shape: the same
--      `business.branding.update` permission will drive tenant branding later,
--      because the branding row and its policies already exist — only a provider
--      branch is added here, no document-facing column moves.
--
-- Migrations 1–10 are frozen (checksum-clean and applied to the live project),
-- so every one of these changes is a NEW migration rather than an edit.
--
-- Operational indicators (section 2) are the columns the owner chose for the
-- console: `lastActivityAt`, `lastSyncAt`, `lastSyncErrorCode`. They are written
-- only through two narrow SECURITY DEFINER functions (section 7), because the
-- row-level policies that guard the rest of `Tenant` are deliberately too strict
-- to be usable from a write path belonging to a ordinary member. Both functions
-- write fixed columns and nothing else, and the meaning of each value is
-- documented on the column itself — including the fact that an offline device is
-- invisible until it next connects, which no schema can improve.

-- ─── 1. Plan catalogue (informational) ────────────────────────────────────────

-- CreateEnum
CREATE TYPE "public"."PlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Plan" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "public"."PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id"),
    -- The code is the stable label an operator picks and the seed key; the name
    -- is what the console shows. Bounded lengths keep the console readable
    -- without a validation library in the database.
    CONSTRAINT "Plan_code_is_well_formed"
        CHECK ("code" ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT "Plan_name_is_bounded"
        CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "Plan_description_is_bounded"
        CHECK (char_length(btrim("description")) BETWEEN 1 AND 300),
    -- There is no price column and there will not be a limit column added by
    -- accident: this table carries no authority, and a CHECK that refuses the
    -- shape of a billing table is the cheapest way to keep it that way.
    CONSTRAINT "Plan_sort_order_is_non_negative"
        CHECK ("sortOrder" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE INDEX "Plan_status_sortOrder_idx" ON "Plan"("status", "sortOrder");

-- ─── 2. Tenant.planId: a loose text reference becomes a real FK ───────────────
-- `planId` has existed as untyped TEXT since the init migration and has never
-- had a writer — the console only displays it. Converting it to a UUID foreign
-- key is what makes "assign a plan" a trusted operation: the value must name a
-- row in a catalogue the runtime role cannot edit, instead of any string a
-- client invented.

-- An empty string is what a form with no selection tends to produce; it is not a
-- reference to anything, so it normalises to NULL before the cast.
UPDATE "Tenant" SET "planId" = NULL WHERE btrim(coalesce("planId", '')) = '';

-- Fail loudly rather than silently NULLing a value: if a row already carries a
-- non-UUID plan reference, an operator has written something here and the
-- migration must stop and be read, not guess.
DO $$
DECLARE
    v_bad integer;
BEGIN
    SELECT count(*) INTO v_bad
      FROM "Tenant"
     WHERE "planId" IS NOT NULL
       AND "planId" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    IF v_bad > 0 THEN
        RAISE EXCEPTION
            'Cannot convert Tenant.planId to a UUID: % row(s) hold a non-UUID plan reference. Inspect them and decide their plan assignment before deploying.',
            v_bad
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- AlterTable
ALTER TABLE "Tenant" ALTER COLUMN "planId" TYPE uuid USING "planId"::uuid;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Tenant_planId_idx" ON "Tenant"("planId");

-- Deleting a plan label must never reach into a tenant's row, so the FK is
-- SET NULL; the application does not offer plan deletion at all (ARCHIVED is the
-- supported way to retire a label).
COMMENT ON COLUMN "Tenant"."planId" IS 'Provider-recorded plan label (informational). Set only by a platform action holding platform.tenants.plan.assign; a tenant actor cannot move it (tenant_provider_columns_guard_update).';

-- Seed: exactly one plan. The owner has not published a commercial tier list, so
-- inventing "Starter / Growth / Enterprise" rows would be fabricating pricing
-- structure the product does not have. `standard` is the label that matches the
-- business name and lets the assignment flow be built, tested and used today;
-- further labels arrive by migration (or operator SQL) when the tiers are real.
DO $$
DECLARE
    v_inserted integer;
    v_expected constant integer := 1;
BEGIN
    INSERT INTO "Plan" ("id", "code", "name", "description", "status", "sortOrder", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), v."code", v."name", v."description", v."status"::"public"."PlanStatus", v."sortOrder",
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM (VALUES
        ('standard',
         'Amisi Genuine Standard',
         'The plan every workspace on the Amisi Genuine MVP is assigned. Informational only: it carries no price, no limits and no feature gating.',
         'ACTIVE', 0)
      ) AS v("code", "name", "description", "status", "sortOrder");

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted <> v_expected THEN
        RAISE EXCEPTION 'Plan seed inserted % row(s), expected %', v_inserted, v_expected
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── 2b. Operational indicator columns ───────────────────────────────────────
-- NULL means "never recorded", which is a different fact from "long ago", so all
-- three are nullable and the console renders them separately. No default, no
-- backfill and no trigger: a value appears only when the event that justifies it
-- actually happened.

ALTER TABLE "Tenant"
    ADD COLUMN "lastActivityAt" TIMESTAMP(3),
    ADD COLUMN "lastSyncAt" TIMESTAMP(3),
    ADD COLUMN "lastSyncErrorCode" TEXT;

COMMENT ON COLUMN "Tenant"."lastActivityAt" IS 'When the workspace last presented an authorized write request to the application (the provider''s "last activity" indicator). Evidence lives in AuditLog; this is a convenience read, refreshed by touch_tenant_activity().';
COMMENT ON COLUMN "Tenant"."lastSyncAt" IS 'The last synchronization attempt the server answered, accepted or refused alike. NULL means no device has ever synced — the MVP has no sync transport yet, so a NULL here is expected and is displayed as "not recorded", never as "up to date".';
COMMENT ON COLUMN "Tenant"."lastSyncErrorCode" IS 'Short machine code from the most recent rejected sync attempt (for example "tenant_suspended"). Cleared when an attempt succeeds. An offline device keeps its cached data until it next connects and is refused: this column is when that happens, not before.';

CREATE INDEX "Tenant_lastActivityAt_idx" ON "Tenant"("lastActivityAt");

-- ─── 3. Permission catalogue: the four provider permissions ──────────────────
-- Mirrors `packages/auth/src/permissions.ts`. Migrations 1–10 are frozen, so the
-- catalog grows here rather than by editing the 38-row seed: 38 + 4 = 42 and
-- 112 + 4 = 116, asserted below so a missed row fails the migration.

DO $$
DECLARE
    v_inserted integer;
    v_expected constant integer := 4;
BEGIN
    INSERT INTO "Permission" ("id", "key", "domain", "area", "description")
    SELECT gen_random_uuid(), v."key", v."domain", v."area", v."description"
      FROM (VALUES
        ('platform.tenants.update',       'platform', 'tenants', 'Edit a tenant''s profile, branding and document settings'),
        ('platform.tenants.plan.assign',  'platform', 'tenants', 'Assign a subscription plan to a tenant'),
        ('platform.tenants.domain.manage','platform', 'tenants', 'Manage a tenant''s workspace slug and hostnames'),
        ('platform.audit.read',           'platform', 'audit',   'View the provider audit trail for any tenant')
      ) AS v("key", "domain", "area", "description");

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted <> v_expected THEN
        RAISE EXCEPTION 'Permission seed inserted % row(s), expected %', v_inserted, v_expected
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- SUPER_ADMIN only (4 rows). SUPPORT stays at zero permissions: a support actor
-- reaches tenant data through an expiring, audited grant and nothing else, which
-- is exactly why provider branding/plan/domain authority must not be handed to it.
DO $$
DECLARE
    v_inserted integer;
    v_expected constant integer := 4;
BEGIN
    INSERT INTO "RolePermission" ("id", "roleKey", "domain", "permissionId")
    SELECT gen_random_uuid(), m."roleKey", p."domain", p."id"
      FROM (VALUES
        ('SUPER_ADMIN', 'platform.tenants.update'),
        ('SUPER_ADMIN', 'platform.tenants.plan.assign'),
        ('SUPER_ADMIN', 'platform.tenants.domain.manage'),
        ('SUPER_ADMIN', 'platform.audit.read')
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

-- Catalog totals, stated once so drift is a failed migration instead of a
-- quieter authorization bug.
DO $$
DECLARE
    v_permissions integer;
    v_matrix integer;
    v_super_admin integer;
BEGIN
    SELECT count(*) INTO v_permissions FROM "Permission";
    IF v_permissions <> 42 THEN
        RAISE EXCEPTION 'Permission catalog holds % rows after the Phase 2 seed, expected 42', v_permissions
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO v_matrix FROM "RolePermission";
    IF v_matrix <> 116 THEN
        RAISE EXCEPTION 'RolePermission matrix holds % rows after the Phase 2 seed, expected 116', v_matrix
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO v_super_admin FROM "RolePermission" WHERE "roleKey" = 'SUPER_ADMIN';
    IF v_super_admin <> 9 THEN
        RAISE EXCEPTION 'SUPER_ADMIN holds % platform permissions, expected 9', v_super_admin
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM "RolePermission" WHERE "roleKey" = 'SUPPORT') THEN
        RAISE EXCEPTION 'SUPPORT must hold zero permissions; support access runs through SupportAccessGrant'
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

-- ─── 4. The suspension gate ──────────────────────────────────────────────────
-- One narrow fact, expressed once: a workspace that the provider has taken
-- offline accepts no tenant-side writes. This is precisely the Phase 2 rule —
-- "when suspended, a tenant must be denied prohibited online writes and
-- synchronization writes" — and nothing more.
--
-- PENDING deliberately still passes here, and that is a decision rather than an
-- oversight. A workspace being provisioned is PENDING, and provisioning writes:
-- the creator claims the OWNER seat, the initial settings/branding/domain rows
-- land, and the owner invitation the provider issued is accepted by its
-- recipient — none of which can be refused without breaking registration itself
-- (`acceptInvitationAction` is intentionally not a tenant-permission operation).
-- "PENDING is not usable" is therefore enforced one layer up, by
-- `resolveTenantContext`/`getWorkspaceState` refusing a PENDING context for any
-- workspace operation, and by activation being reachable only through a platform
-- permission (the `tenant_status_guard` trigger). Both layers are stated in
-- docs/architecture/security-model.md; the database gate exists because
-- suspension, unlike PENDING, has no legitimate writes at all.
--
-- SECURITY DEFINER for the same reason as its neighbours in 20261018000002: the
-- answer must not depend on whether the caller can already see the Tenant row,
-- and reading Tenant through a definer function avoids policy recursion. An
-- absent tenant answers false, so an orphaned row can never be written to.

CREATE OR REPLACE FUNCTION public.app_tenant_accepts_writes(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public."Tenant" t
         WHERE t."id" = p_tenant_id
           AND t."status" <> 'SUSPENDED'
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- The write family, member branch now status-aware. The platform-admin branch is
-- left exactly as it was: a provider must be able to act on a suspended tenant,
-- and `tenant_status_guard` is what confines who may move the status itself.
CREATE OR REPLACE FUNCTION public.has_tenant_write_access(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT (
        (p_tenant_id IS NOT NULL
         AND p_tenant_id = public.current_tenant_id()
         AND public.app_tenant_role(p_tenant_id) IN
             ('TENANT_OWNER', 'TENANT_ADMIN', 'SALES', 'FINANCE', 'OPERATIONS')
         AND public.app_tenant_accepts_writes(p_tenant_id))
        OR public.is_platform_admin()
    );
$$ LANGUAGE sql STABLE;

-- A WRITE-specific twin of the admin family, for the policies that mutate
-- settings, branding, domains, memberships, invitations and the tenant row.
--
-- Why not simply gate `has_tenant_admin_access()`: that family is also the read
-- gate for the audit trail (`audit_log_select`). A suspended business keeps its
-- own records and its own visibility — "suspension must preserve business
-- records" — so reads stay open and only the write policies move to this
-- function. That distinction is the whole of the owner's decision, and it is why
-- two functions exist rather than one.

CREATE OR REPLACE FUNCTION public.has_tenant_admin_write_access(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT (
        (p_tenant_id IS NOT NULL
         AND p_tenant_id = public.current_tenant_id()
         AND public.app_tenant_role(p_tenant_id) IN ('TENANT_OWNER', 'TENANT_ADMIN')
         AND public.app_tenant_accepts_writes(p_tenant_id))
        OR public.is_platform_admin()
    );
$$ LANGUAGE sql STABLE;

REVOKE EXECUTE ON FUNCTION public.app_tenant_accepts_writes(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_tenant_admin_write_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_tenant_accepts_writes(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.has_tenant_admin_write_access(uuid) TO amisibiz_app;

-- ─── 5. Policies that move to the write-aware gate ────────────────────────────
-- The plain business tables (Contact, Item, Document, numbering series, …) need
-- no rewrite at all: their INSERT/UPDATE/DELETE policies call
-- `has_tenant_write_access()`, whose body changed above. This section is the
-- explicit policies only.

-- Tenant row: profile edits, lifecycle actions and (new) branding of the tenant
-- itself. A member must now be an owner/admin of a workspace the provider has
-- not suspended; a platform admin is unaffected.
DROP POLICY IF EXISTS tenant_admin_update ON "Tenant";
CREATE POLICY tenant_admin_update ON "Tenant"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_write_access("id"))
    WITH CHECK (public.has_tenant_admin_write_access("id"));

-- Settings and branding: the same gate, keeping the registration anchor for the
-- provisioning rows (a still-PENDING tenant's creator writes its first settings,
-- branding and domain rows — that path is anchored on `app_is_tenant_creator()`,
-- which is what provisioning actually relies on today, so removing it would
-- break registration rather than tighten it).
--
-- `OR public.is_platform_admin()` inside the new helper is also the fix for a
-- real gap: the old branding/settings policies had NO platform branch at all, so
-- an Amisi Genuine operator could not have edited a workspace's branding without
-- being a member of it. Provider branding is a Phase 2 requirement, so the
-- branch belongs here rather than in a follow-up migration.
DROP POLICY IF EXISTS tenant_settings_insert ON "TenantSettings";
CREATE POLICY tenant_settings_insert ON "TenantSettings"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        public.has_tenant_admin_write_access("tenantId")
        OR public.app_is_tenant_creator("tenantId")
    );

DROP POLICY IF EXISTS tenant_settings_update ON "TenantSettings";
CREATE POLICY tenant_settings_update ON "TenantSettings"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_write_access("tenantId"))
    WITH CHECK (public.has_tenant_admin_write_access("tenantId"));

DROP POLICY IF EXISTS tenant_branding_insert ON "TenantBranding";
CREATE POLICY tenant_branding_insert ON "TenantBranding"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        public.has_tenant_admin_write_access("tenantId")
        OR public.app_is_tenant_creator("tenantId")
    );

DROP POLICY IF EXISTS tenant_branding_update ON "TenantBranding";
CREATE POLICY tenant_branding_update ON "TenantBranding"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_write_access("tenantId"))
    WITH CHECK (public.has_tenant_admin_write_access("tenantId"));

-- Domains: provider-side hostname and slug management (item 8) rides the same
-- gate, so a suspended workspace cannot re-point its own hostname while the
-- provider can.
DROP POLICY IF EXISTS tenant_domain_insert ON "TenantDomain";
CREATE POLICY tenant_domain_insert ON "TenantDomain"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        public.has_tenant_admin_write_access("tenantId")
        OR public.app_is_tenant_creator("tenantId")
    );

DROP POLICY IF EXISTS tenant_domain_update ON "TenantDomain";
CREATE POLICY tenant_domain_update ON "TenantDomain"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_write_access("tenantId") OR public.app_is_tenant_creator("tenantId"))
    WITH CHECK (public.has_tenant_admin_write_access("tenantId") OR public.app_is_tenant_creator("tenantId"));

-- Deleting a hostname is part of provider domain management (the DELETE grant
-- is added in §8). A suspended workspace cannot remove its own hostname — the
-- member branch is gated — while the provider can, which is what "take this
-- tenant off a customer domain" needs. The tenant's business records and storage
-- objects are untouched by anything in this section.
DROP POLICY IF EXISTS tenant_domain_delete ON "TenantDomain";
CREATE POLICY tenant_domain_delete ON "TenantDomain"
    FOR DELETE TO amisibiz_app
    USING (public.has_tenant_admin_write_access("tenantId"));

-- Memberships: an owner may not reshape their team while offline to the platform
-- (that is how a suspended business would "recover" by promoting a colleague).
-- The tenant READ policies are untouched: the team list stays visible.
DROP POLICY IF EXISTS tenant_member_update ON "TenantMember";
CREATE POLICY tenant_member_update ON "TenantMember"
    FOR UPDATE TO amisibiz_app
    USING (public.has_tenant_admin_write_access("tenantId"))
    WITH CHECK (public.has_tenant_admin_write_access("tenantId"));

DROP POLICY IF EXISTS tenant_member_delete ON "TenantMember";
CREATE POLICY tenant_member_delete ON "TenantMember"
    FOR DELETE TO amisibiz_app
    USING (public.has_tenant_admin_write_access("tenantId"));

-- Invitations: creating one is a write, and so is accepting one. The recipient
-- branch of the UPDATE policy is gated explicitly, because accepting an
-- invitation into a suspended workspace would create a membership row through the
-- INSERT policy below — the pair has to refuse together or the denial leaks.
DROP POLICY IF EXISTS invitation_insert ON "Invitation";
CREATE POLICY invitation_insert ON "Invitation"
    FOR INSERT TO amisibiz_app
    WITH CHECK (public.has_tenant_admin_write_access("tenantId"));

DROP POLICY IF EXISTS invitation_update ON "Invitation";
CREATE POLICY invitation_update ON "Invitation"
    FOR UPDATE TO amisibiz_app
    USING (
        public.has_tenant_admin_write_access("tenantId")
        OR (lower("email") = lower(public.app_current_user_email())
            AND public.app_tenant_accepts_writes("tenantId"))
    )
    WITH CHECK (
        public.has_tenant_admin_write_access("tenantId")
        OR (lower("email") = lower(public.app_current_user_email())
            AND public.app_tenant_accepts_writes("tenantId"))
    );

-- The invitation-derived membership branch only, for the same reason. The
-- creator branch is untouched: claiming the OWNER seat of a tenant the actor has
-- just provisioned is the registration flow, and its tenant is PENDING by
-- design — gating it would break provisioning.
DROP POLICY IF EXISTS tenant_member_insert ON "TenantMember";
CREATE POLICY tenant_member_insert ON "TenantMember"
    FOR INSERT TO amisibiz_app
    WITH CHECK (
        public.is_platform_admin()
        OR ("userId" = public.current_user_id()
            AND (
                ("role" = 'TENANT_OWNER' AND public.app_is_tenant_creator("tenantId"))
                OR (public.app_tenant_accepts_writes("tenantId")
                    AND EXISTS (
                        SELECT 1
                          FROM "Invitation" i
                         WHERE i."tenantId" = "TenantMember"."tenantId"
                           AND lower(i."email") = lower(public.app_current_user_email())
                           AND i."role" = "TenantMember"."role"
                           AND i."status" = 'ACCEPTED'
                    ))
            ))
    );

-- The tenant's own status history: the write family already refuses a member of
-- a non-ACTIVE workspace, and a platform transition (which is the only kind
-- there is) arrives through `is_platform_admin()` in the same function. The
-- registration anchor keeps producing the initial PENDING row.
DROP POLICY IF EXISTS tenant_status_history_insert ON "TenantStatusHistory";
CREATE POLICY tenant_status_history_insert ON "TenantStatusHistory"
    FOR INSERT TO amisibiz_app
    WITH CHECK (public.has_tenant_write_access("tenantId") OR public.app_is_tenant_creator("tenantId"));

-- ─── 6. Column guards: what a tenant actor may not move at all ───────────────
-- RLS answers "which rows", triggers answer "which transitions". The admin
-- family admits an owner/admin to the whole Tenant row, so the provider-owned
-- columns need a transition-level refusal: the workspace slug, the plan label,
-- and the activation/suspension bookkeeping. Status itself is already confined
-- by `tenant_status_guard` (20261018000002) and is deliberately not repeated
-- here — the acceptance criterion "tenant admins cannot activate themselves" is
-- proven by that trigger, and a second copy would only give future edits two
-- places to disagree.
CREATE OR REPLACE FUNCTION public.tenant_provider_columns_guard_update() RETURNS trigger AS $$
BEGIN
    IF public.is_platform_admin() THEN
        RETURN NEW;
    END IF;

    IF NEW."slug" IS NOT DISTINCT FROM OLD."slug"
       AND NEW."planId" IS NOT DISTINCT FROM OLD."planId"
       AND NEW."activatedAt" IS NOT DISTINCT FROM OLD."activatedAt"
       AND NEW."activatedById" IS NOT DISTINCT FROM OLD."activatedById"
       AND NEW."suspendedAt" IS NOT DISTINCT FROM OLD."suspendedAt"
       AND NEW."suspendedById" IS NOT DISTINCT FROM OLD."suspendedById"
       AND NEW."suspensionReason" IS NOT DISTINCT FROM OLD."suspensionReason" THEN
        RETURN NEW;
    END IF;

    IF NEW."slug" IS DISTINCT FROM OLD."slug" THEN
        RAISE EXCEPTION 'A workspace slug is managed by the platform provider'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW."planId" IS DISTINCT FROM OLD."planId" THEN
        RAISE EXCEPTION 'A subscription plan is assigned by the platform provider'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RAISE EXCEPTION 'Activation and suspension bookkeeping is written only by the platform lifecycle workflow'
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_provider_columns_guard_update ON "Tenant";
CREATE TRIGGER tenant_provider_columns_guard_update
    BEFORE UPDATE ON "Tenant"
    FOR EACH ROW EXECUTE FUNCTION public.tenant_provider_columns_guard_update();

-- ─── 7. Indicator writers ────────────────────────────────────────────────────
-- The audit trail stays the evidence log, and this index is what makes reading
-- per-tenant history cheap on a paged console list:
--   SELECT "tenantId", max("createdAt") … WHERE "tenantId" IN (…) GROUP BY 1
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_createdAt_idx"
    ON "AuditLog"("tenantId", "createdAt" DESC);

-- Why functions and not the application's own UPDATE: the row policies around
-- `Tenant` are deliberately strict (`tenant_admin_update` admits owner/admin and
-- platform admins only, on the whole row). A SALES member recording a contact is
-- neither, and widening that policy to let write paths stamp an indicator would
-- also let them edit the workspace name, currency and locale. Two definer
-- functions that each move fixed columns are the narrow version of the same
-- capability, and they follow the pattern already set by
-- `allocate_document_number` in 20261018000002 §6.

-- An authorized write request arrived for this workspace. Refuses to stamp an
-- arbitrary tenant: the caller must already be acting in that tenant's context
-- (or be a platform admin, whose provider-side edits are also activity).
CREATE OR REPLACE FUNCTION public.touch_tenant_activity(p_tenant_id uuid) RETURNS void AS $$
BEGIN
    IF p_tenant_id IS NULL THEN
        RETURN;
    END IF;

    IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id
       AND NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Workspace activity can only be recorded in the context of that workspace'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A suspended workspace keeps the timestamp it had when it went offline: the
    -- indicator then reads as "nothing since suspension", which is the truth.
    UPDATE public."Tenant"
       SET "lastActivityAt" = CURRENT_TIMESTAMP
     WHERE "id" = p_tenant_id
       AND "status" <> 'SUSPENDED';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- The server answered a synchronization attempt — accepted or refused. Recording
-- a refusal is the whole of the offline story the provider gets: the row is
-- written by whoever is handling the request (the tenant's own context, or a
-- platform action), and an attempt that never reached the server leaves no trace.
CREATE OR REPLACE FUNCTION public.record_tenant_sync_attempt(
    p_tenant_id  uuid,
    p_accepted   boolean,
    p_error_code text DEFAULT NULL
) RETURNS void AS $$
DECLARE
    v_code text := NULLIF(btrim(coalesce(p_error_code, '')), '');
BEGIN
    IF p_tenant_id IS NULL OR p_accepted IS NULL THEN
        RAISE EXCEPTION 'record_tenant_sync_attempt requires a tenant and an outcome'
            USING ERRCODE = 'check_violation';
    END IF;

    IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id
       AND NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Sync results can only be recorded in the context of that workspace'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A refusal must be named, and named shortly: a free-text reason belongs in
    -- the audit event, not in an indicator column the console renders raw.
    IF NOT p_accepted AND v_code IS NULL THEN
        RAISE EXCEPTION 'A rejected sync attempt requires an error code'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_code IS NOT NULL AND char_length(v_code) > 64 THEN
        RAISE EXCEPTION 'Sync error code % is longer than 64 characters', v_code
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public."Tenant" t
       SET "lastSyncAt" = CURRENT_TIMESTAMP,
           "lastSyncErrorCode" = CASE WHEN p_accepted THEN NULL ELSE v_code END,
           "lastActivityAt" = CASE
               WHEN p_accepted AND t."status" <> 'SUSPENDED' THEN CURRENT_TIMESTAMP
               ELSE t."lastActivityAt"
           END
     WHERE t."id" = p_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

REVOKE EXECUTE ON FUNCTION public.touch_tenant_activity(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_tenant_sync_attempt(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_tenant_activity(uuid) TO amisibiz_app;
GRANT EXECUTE ON FUNCTION public.record_tenant_sync_attempt(uuid, boolean, text) TO amisibiz_app;

COMMENT ON FUNCTION public.touch_tenant_activity(uuid) IS 'Stamps Tenant.lastActivityAt for an authorized write request; refuses outside the workspace''s own context and leaves a suspended workspace''s timestamp untouched.';
COMMENT ON FUNCTION public.record_tenant_sync_attempt(uuid, boolean, text) IS 'Stamps Tenant.lastSyncAt / lastSyncErrorCode for a sync attempt the server answered, accepted or refused. A refusal requires a short machine code.';

-- ─── 8. Plan visibility and the runtime role ─────────────────────────────────
-- Seeded and edited by migrations; read at runtime by the provider console only.
-- No INSERT/UPDATE/DELETE grant: if the catalogue ever needs a row, that is a
-- migration or an operator decision recorded in the RUNBOOK, not something an
-- application request can invent.

ALTER TABLE "Plan" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_select ON "Plan";
CREATE POLICY plan_select ON "Plan"
    FOR SELECT TO amisibiz_app
    USING (public.is_platform_admin());

REVOKE ALL ON "Plan" FROM amisibiz_app;
GRANT SELECT ON "Plan" TO amisibiz_app;

-- The PostgREST roles never touch AmisiBiz tables (migration 10 §8(d) states the
-- rule for the tables that existed then; Plan follows it for the same reason).
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    LOOP
        EXECUTE format('REVOKE ALL ON public."Plan" FROM %I', r.rolname);
    END LOOP;
END
$$;

-- Domain deletion needs the DELETE verb, which migration 10 §8(c) did not grant
-- to TenantDomain. Added here — and narrowed by the policy above, so the verb is
-- not the control.
GRANT DELETE ON "TenantDomain" TO amisibiz_app;

-- One primary hostname per workspace. Routing resolves a tenant by hostname, and
-- a second primary makes "which address is this tenant's real one" unanswerable,
-- so the console's "set primary" action needs the database to hold the line.
-- Checked before creating so a violation names the workspace instead of failing
-- as an opaque index error mid-deploy.
DO $$
DECLARE
    v_offending text;
BEGIN
    SELECT string_agg(t."name" || ' (' || d."count" || ')', ', ')
      INTO v_offending
      FROM (
        SELECT "tenantId", count(*) AS "count"
          FROM "TenantDomain"
         WHERE "isPrimary"
         GROUP BY "tenantId"
        HAVING count(*) > 1
      ) d
      JOIN "Tenant" t ON t."id" = d."tenantId";

    IF v_offending IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot enforce one primary hostname per workspace: these tenants already have several (%). Decide which hostname is primary before deploying.',
            v_offending
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

CREATE UNIQUE INDEX "TenantDomain_one_primary_per_tenant"
    ON "TenantDomain"("tenantId") WHERE "isPrimary";

-- ─── 9. Number allocation: the same status rule, in the definer ──────────────
-- `allocate_document_number` is SECURITY DEFINER, so it runs as the owner and no
-- row policy reaches it. Without this guard a member of a suspended workspace who
-- called it directly would consume a sequence value (and, in a future
-- implementation, could reach a document row the policies would then reject —
-- leaving a hole in the series). Redefinition is verbatim from
-- 20261018000002 §6 plus the one refusal marked below: a definer function must be
-- replaced whole, so this is the reviewed copy, not a diff.

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

    -- NEW (Phase 2): issuing is a write, and a suspended workspace does not
    -- accept writes. Checked after the role tests so that an unprivileged caller
    -- still gets the pre-existing, already-tested refusal.
    IF NOT public.app_tenant_accepts_writes(p_tenant_id) THEN
        RAISE EXCEPTION 'This workspace is suspended and cannot allocate document numbers'
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

-- ─── 10. Comments ────────────────────────────────────────────────────────────

COMMENT ON TABLE "Plan" IS 'Informational subscription-plan catalogue: code, name, description, status, order. No price, no limits, no entitlements. Seeded by migration; the runtime role holds SELECT for platform admins only.';
COMMENT ON FUNCTION public.app_tenant_accepts_writes(uuid) IS 'The Phase 2 suspension rule: tenant-side writes are refused while the workspace is SUSPENDED. PENDING still passes (provisioning and owner-invitation acceptance legitimately write into a not-yet-activated workspace); an absent tenant answers false. Platform authority is never gated by this.';
COMMENT ON FUNCTION public.has_tenant_write_access(uuid) IS 'Write family: tenant context + a writing role + a workspace that is not suspended, or platform admin. Support is absent (read-only by design).';
COMMENT ON FUNCTION public.has_tenant_admin_write_access(uuid) IS 'Write-scoped admin family: the admin roles of a workspace that is not suspended, or platform admin. The read counterpart (has_tenant_admin_access) stays status-blind so a suspended tenant keeps reading its own records.';
COMMENT ON FUNCTION public.tenant_provider_columns_guard_update() IS 'Provider-owned Tenant columns: slug, plan and the activation/suspension bookkeeping move only under platform authority. Status itself is confined by tenant_status_guard.';
