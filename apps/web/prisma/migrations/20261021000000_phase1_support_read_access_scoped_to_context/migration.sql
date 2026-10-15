-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 follow-up (task #50) — scope the SUPPORT branch of the read family to
-- the active tenant context.
--
-- Why this migration exists
-- ─────────────────────────────────────────────────────────────────────────────
-- `has_tenant_read_access(p_tenant_id)` is the single predicate every tenant
-- read policy funnels through. Since migration 10 its third disjunct was:
--
--     OR (public.is_platform_support() AND public.has_support_grant(p_tenant_id))
--
-- which asks only "does this support user hold a live grant on that tenant?" and
-- never asks "is that the tenant this session is acting on?". The DB-backed
-- harness (docs/implementation/phase-01-security-harness-report.md §4,
-- docs/architecture/security-model.md §13.7) found the consequence: a SUPPORT
-- user granted on tenant A who sets context to tenant B still reads A's rows.
-- B's own rows stay invisible without a B grant, so it is not a cross-tenant
-- leak — but the session's tenant label becomes advisory at row level, and an
-- audit row written under one context can accompany reads of another. Audit
-- trails and support access are exactly the two things this product promises
-- providers they can trust.
--
-- What changes
-- ─────────────────────────────────────────────────────────────────────────────
-- The support disjunct now also requires the granted tenant to be the tenant the
-- context names — or no tenant context at all. The no-context case is kept open
-- deliberately: the provider console lists the workspaces a support user is
-- allowed into before it enters any of them, and per-workspace reads then go
-- through `authorizePlatformTenant(...)`, which sets the target tenant context
-- (apps/web/src/server/auth/authorization.ts) before querying. Dropping rows for
-- that listing would break a supported flow to close a hole that does not exist
-- in it.
--
-- This is a TIGHTENING, not a relaxation. No policy is dropped, no grant is
-- widened, and the membership and platform-admin disjuncts are byte-identical to
-- migration 10. Migrations 1–11 stay frozen; the fix is a new migration, as the
-- Phase 1 gate requires.
--
-- Verification performed (disposable cluster, never the shared project)
-- ─────────────────────────────────────────────────────────────────────
--   * new harness cases in apps/web/tests/integration-security.test.ts:
--     grant on A + context A -> visible; grant on A + context B -> invisible;
--     grant on A + no context -> visible (provider console listing);
--   * `sh scripts/db/cleanroom-chain.sh <db>` end to end, whose step 13 applies
--     this migration on top of 1–11 and re-runs the behaviour battery — 72 PASS,
--     including the new fence cases T9i–T9m and the whole original T9 block
--     (support without a grant, with a grant, the write refusal, revocation,
--     expiry). The same battery run against the frozen 1..11 chain at steps 8 and
--     11 reports T9j as a labelled SKIP, not a pass: that stage really does still
--     carry the loose branch, and the next step of the chain is what closes it.
-- ─────────────────────────────────────────────────────────────────────────────

-- The read family: membership in the active context (never a portal seat), or a
-- platform administrator, or support holding a live grant on the active context.
CREATE OR REPLACE FUNCTION public.has_tenant_read_access(p_tenant_id uuid) RETURNS boolean AS $$
    SELECT (
        (p_tenant_id IS NOT NULL
         AND p_tenant_id = public.current_tenant_id()
         AND public.app_tenant_role(p_tenant_id) IS NOT NULL
         AND public.app_tenant_role(p_tenant_id) <> 'CUSTOMER_PORTAL_USER')
        OR public.is_platform_admin()
        OR (public.is_platform_support()
            AND public.has_support_grant(p_tenant_id)
            AND (public.current_tenant_id() IS NULL
                 OR p_tenant_id = public.current_tenant_id()))
    );
$$ LANGUAGE sql STABLE;

-- EXECUTE privileges survive CREATE OR REPLACE, but state them again so this
-- migration is readable in isolation: the runtime role needs it (policy
-- expressions evaluate with the querying role's privileges) and nobody else does.
REVOKE EXECUTE ON FUNCTION public.has_tenant_read_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_tenant_read_access(uuid) TO amisibiz_app;

COMMENT ON FUNCTION public.has_tenant_read_access(uuid) IS
  'Read family: tenant context + non-portal membership, platform admin, or support with an active grant on the ACTIVE context (or no context at all, so the provider console can list its granted workspaces). See migration 20261021000000.';
