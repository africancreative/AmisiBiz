# Frozen Shared Contracts — Orchestrator Step 2

Date: 2026-10-18
Status: binding on all agents (specialist scopes, subagents, and the
orchestrator) from this date until the owner amends it. Purpose per Step 2 of
the orchestrator procedure: no feature agent may create a competing
implementation of anything in this document. Anything not frozen here is
owned by the area's active agent; conflicts resolve to the orchestrator.

---

## C1 — Canonical data model

Authority: `../agent-0-canonical-data-model-audit.md` (coverage: 22/27 items
existing, no duplicate tables wanted). The 24 models of
`apps/web/prisma/schema.prisma` are the single model authority. Binding
rules:

- One table per concept. The enumerated equivalents stay equivalents: roles =
  `TenantRole` enum + code matrix; plan history = `Tenant.planId` + audit;
  portal membership = `Contact.portalUserId` + `CUSTOMER_PORTAL_USER` +
  `@@unique([tenantId, portalUserId])`; customer invitations = the ordinary
  `Invitation` flow with the portal role; document events =
  `DocumentStatusEvent`; correction/void = void columns + `replacementOfId`.
- The **only** sanctioned in-flight model change is the peer agent's
  contact/item remodel toward `DocumentItem`/`DocumentContactItem`. On
  landing, the Agent 0 catalogue rows repoint and the canonical audit is
  re-issued. No other agent touches `Contact`, `Item`, `ContactItem`,
  `Document*` model definitions.
- Refinements R1–R4 (same-tenant composite FKs, `portalUserId` index,
  timestamptz standardization, hostname CHECK) and the R5 `Subscription*`
  ruling land as **new migrations only**, sequenced after the C1 completion
  migration (backlog §2 items 2, 6).
- No eTIMS schema work: `TenantBranding.etims*` columns are inert
  placeholders, assert no capability, and are out of R1.

## C2 — Authentication

Native credentials only: bcrypt `passwordHash` on `User` (no external IdP).
Sessions are signed HTTP-only cookies embedding a `sessionVersion`; any
revocation bumps the column and kills the token family server-side. The
session cookie is the only credential in a browser; API routes and Server
Actions re-derive authorization from it per request. Token-holding artifacts
(invitation tokens) are `randomBytes(32)`, stored only as SHA-256 hashes,
expire in 7 days, and are never rendered in UI or logs. Portal users are
ordinary users whose entire access is the contact link — never internal
records. Session-expiry policy differentiation is an open decision (A6 §3.2);
until ruled, 7-day sessions stand and no code may introduce per-role session
stores.

## C3 — Tenant resolution

A request's tenant comes from the hostname, never from client-supplied IDs:
`resolveRequestHost`/`extractSubdomain` anchored to `APP_BASE_DOMAIN`;
reserved subdomains 404 in middleware; workspace context is resolved by
membership (`resolveTenantContext`), portal context by the contact link
(`resolvePortalContext`), platform context by `authorizePlatform`. Lifecycle
semantics are frozen: PENDING refuses all operations (provisioning writes
excepted); SUSPENDED refuses writes and sync only — reads and downloads keep
working, enforced at the database by `app_tenant_accepts_writes()` and at the
application by `authorizeTenant`, with the UI banner as explanation only.
Slug and hostname are unique; hostnames are lowercased at the write path (DB
hardening queued as R4).

## C4 — Authorization utilities

One catalog, one matrix: `PERMISSIONS` (57 keys) and `tenantRoleHasPermission`
in `packages/auth`, mirrored into `Permission`/`RolePermission` by migration
with a bidirectional parity test. Server enforcement utilities:
`authorizeTenant` (permission + tenant status + support-grant handling),
`authorizePlatform`, `authorizeByDocumentType`, and the scoped-context
primitives (`runInScope`, `sessionScope`, `enterWith`) in
`@amisibiz/database`. Rules: deny by default; support grants are read-only,
time-boxed, audited, and never grant write or portal management; UI
permission checks are cosmetics that mirror server checks, never the
enforcement. H1 (seeds 42 vs 57) is a defect against this contract, closed by
backlog item 5 — not by editing the code matrix downward.

## C5 — Migration conventions

- Applied migrations are immutable (live chain 1–10 frozen by application;
  treat 11–16 as frozen by policy). All change is new migration files.
- The five comment-only shells (20261024000000…20261028000000) are dead
  artifacts of a schema-sync shortcut; they are retired, not edited — their
  intended content ships as one new completion migration (backlog item 2).
- Every `prisma` CLI invocation pins BOTH `DATABASE_URL` and `DIRECT_URL`
  (the `.env` DIRECT_URL points at a live pooler — the standing trap).
- Before any migration touches a shared database: full offline verification
  on the throwaway cluster (fresh deploy of the whole chain → checks battery
  → RLS battery → `migrate diff` prints empty → behavioral harness).
- Live or Neon application requires the owner's explicit go-ahead each time.
- RLS is part of the schema, not an afterthought: every table a non-owner
  role can reach gets policies in the same migration that creates it
  (H2's lesson). The runtime role is the scoped operator, never a table
  owner.

## C6 — Service boundaries

- Shared packages: `@amisibiz/documents` (decimal-string calculation engine,
  rounding policy `half-up-per-line-v1`, snapshot v1, PDF writer),
  `@amisibiz/auth` (catalog/matrix), `@amisibiz/database` (Prisma client +
  scoped context), `@amisibiz/ui`, `@amisibiz/sync`. Feature code imports;
  none re-implements.
- Server Actions return `ActionResult` and authorize internally; services
  under `apps/web/src/server/services/**` own business logic; routes under
  `app/api/**` authorize then delegate. No SQL string interpolation anywhere
  (verified: zero raw-unsafe calls).
- Financial figures shown in any UI come from the shared resolver or the
  stored document columns; a client may preview via the same resolver but
  the server recomputes and overwrites at write time. Totals equalities are
  CHECK constraints, not conventions.
- A commercial document's PDF renders from its frozen snapshot and is never
  labeled a KRA/eTIMS tax invoice. Payment confirmation is never fabricated;
  provider consoles display recorded facts only.
- Audit: every state-changing admin/financial action records an AuditLog
  entry (ids and metadata, no PII/credentials in logs or errors).

## C7 — Reserved-surface protocol (integration contract)

Until the reserving agent's all-clear: `apps/web/src/server/services/documents/*.ts`
and `apps/web/src/server/actions/document*.ts` are read-only to everyone
else; `Contact`/`Item`/`ContactItem` models are being remodeled; no tests may
be added or revalidated against contact, item, or document surfaces. The
orchestrator adopts this reservation as the integration contract — it is how
Step 2 prevents competing implementations on the most contract-heavy surface.
The all-clear triggers, in order: remodel lands → resolver repoint (#72) →
A5 closures (#75) → R1 composite FKs → document-adjacent i18n (#83) →
re-verification (Step 9).

## C8 — Verification gates

Every changed tree runs, in order: `pnpm format:check` (after fixing), lint,
type-check, test:run, build, check:bundles, `pnpm audit --prod`; database-
touching changes additionally run the offline migration verification of C5.
The 33-proof behavioral harness is the acceptance instrument for tenant
isolation and must reach 33/33 before Step 9. Reports never claim a gate
passed that was not executed in the reported state of the tree.
