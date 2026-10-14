# AmisiBiz — Security Model

- **Status:** Live document. §1–§10 are the Phase 00 contract; §11–§14 record
  implementation status per phase. **Phase 1 (§13) supersedes §3, §4 and §6
  wherever they disagree** — those sections still describe the pre-Phase 1
  Auth.js / cuid / application-only model and are kept as the decision trail.
  **Phase 2 (§14) supersedes §4.1's original "read and write are blocked"
  suspension rule**; the current policy is writes + synchronization denied, reads
  - downloads preserved.
- **Applies to:** all phases
- **Companion docs:** `permission-matrix.md`, `../RUNBOOK.md`,
  `../administration/provider-console.md`,
  `../implementation/phase-01-security-design.md`,
  `../implementation/phase-02-provider-administration-report.md`

This document states the trust boundaries, threat model, required controls, and the **current gaps** observed in the repository. It is the contract that later phases must satisfy.

---

## 1. Assets and trust boundaries

**Assets:** tenant business data, user credentials, session tokens, invitation/reset tokens, audit logs, uploaded documents, PDFs, platform admin capability.

**Trust boundaries:**

```
[Untrusted: browser/attacker]
        │  every field is attacker-controlled
        ▼
[Boundary A] Middleware (routing + session gate)
        ▼
[Boundary B] Server Actions / Route Handlers  ← validate + authorise here
        ▼
[Boundary C] Domain services (business rules, transactions)
        ▼
[Boundary D] Prisma → PostgreSQL (single source of truth for authz)
```

**Rules:** never trust tenant id, role, price, total, permission, document status or activation flags from the client (constitution rule 6). The database is the authority for membership/role.

---

## 2. Threat model (STRIDE-oriented, prioritised)

| Threat                 | Scenario                                   | Required control                                                      |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| Spoofing               | Stolen/forged session                      | Signed JWT (`AUTH_SECRET`), HttpOnly cookies, status re-check on read |
| Tampering              | Client sends another `tenantId`            | Server-side membership lookup on every request                        |
| Repudiation            | Denied privileged action                   | Append-only `AuditLog` for auth + privileged mutations                |
| Information disclosure | Cross-tenant read via guessed id           | Tenant scope enforced in service layer; no id-only lookups            |
| Denial of service      | Credential stuffing / SMS bombing          | Rate limiting + lockout/backoff                                       |
| Elevation of privilege | Invite/assign role ≥ own; modify superiors | Hierarchy guards (implemented) + peer/superior guards                 |
| Auth bypass            | Dotted path skips middleware guard         | Fix middleware static-file exception (**R1**)                         |

---

## 3. Authentication

**Superseded by Phase 04.5a / Phase 1 — the current mechanism is in §13.3.** The
description below is the original Auth.js-era contract, retained because the
required controls (status re-check, revocation, enumeration safety, rate
limits) still apply and are still met.

- **Credentials:** bcrypt (cost 12); account-status check performed **before** password comparison.
- **Sessions:** JWT strategy, 8h max age / 15m rotation; the `jwt` callback stores `userId`, `platformRole`, `status`, `sessionVersion`; the `session` callback re-reads the DB so status changes take effect and revoked (version-bumped)/suspended/deleted users are invalidated.
- **Secrets:** `AUTH_SECRET` ≥ 32 bytes, never committed; `.env.local` is git-ignored.
- **CSRF:** Auth.js handles auth routes; Next Server Actions provide same-origin/POST protections by default.
- **Recovery:** password reset uses single-use, hashed, 1h TTL tokens and revokes sessions on use; forgot-password always returns the same response (no enumeration).
- **Rate limiting:** login (per IP and per email) and register/forgot/reset, in-memory (see Section 11 for the distributed-store requirement).
- **Required before production registration (gaps):**
  - Wire a real email transport; enable `REQUIRE_EMAIL_VERIFICATION` (email verification is currently optional).
  - Optional MFA for platform admins.
  - OAuth providers (if enabled) must map/link accounts safely.

---

## 4. Authorization (RBAC + tenant isolation)

- **Platform roles** (`PlatformRole`, nullable): `SUPER_ADMIN`, `SUPPORT`, and
  `null` = no platform privileges (the default for every account). See
  `permission-matrix.md` §1 for the directive-name mapping.
- **Tenant roles** (`TenantRole`, seven values): `TENANT_OWNER > TENANT_ADMIN >
SALES / FINANCE / OPERATIONS > VIEWER > CUSTOMER_PORTAL_USER`. Ranks come from
  `TENANT_ROLE_RANK` in `src/lib/auth/helpers.ts`; the sibling permissions are
  not ordered by rank, only by the matrix.
- **Enforcement point:** `authorizeTenant(userId, tenantId, permission)`,
  `authorizePlatform(userId, permission)` and `authorizePlatformTenant(...)` in
  `src/server/auth/authorization.ts`, called by every action/route.
  Deny-by-default. Since Phase 1 this is **two-layer**: the same request also
  runs under PostgreSQL RLS as the `amisibiz_app` role (§13.2), so a forgotten
  `where: { tenantId }` no longer reads across tenants.
- **Implemented guards:**
  - membership (or an active support grant) required; a `PENDING` tenant is
    refused outright and a `SUSPENDED` one is limited to reads/downloads (§4.1);
    missing permission rejected;
  - cannot invite/assign a role ≥ your own;
  - cannot modify/remove a member with a higher role; self-modification blocked;
  - last-`TENANT_OWNER` protection;
  - platform privileges never granted by tenant membership;
  - since Phase 1 the three guards above are **also trigger-enforced in the
    database** (`users_guard_update`, `tenant_members_guard_role_change`,
    `tenant_members_guard_delete`), so they cannot be bypassed by a code path
    that forgot to check.
- **Page-level guard:** `getWorkspaceState(locale[, permission])` in `src/server/auth/workspace.ts` runs server-side on every `/app/*` render (layout + each module page). It resolves membership and tenant status, and — where a permission is supplied — authorizes it against the database, rendering a controlled denied/unavailable state otherwise. A `PENDING` workspace renders as unavailable; a `SUSPENDED` one renders with `readonly: true`, so the UI can hide write affordances while `authorizeTenant` and the policies do the actual refusing (§4.1).
- **Rules for new modules (M4–M9):** every service signature takes `actorUserId` + `tenantId`; every query filters by `tenantId`; platform scopes are explicit, separately gated, and audited.
- **Open decisions:** visibility of pending invitation emails (R11) — `SUPPORT`
  read-only platform access is **settled** by Phase 1 (no permissions without
  an explicit, expiring, audited `SupportAccessGrant`).

### 4.1 Tenant lifecycle & suspension policy (Phase 03, split restated by Phase 2)

Tenants follow `PENDING → ACTIVE ⇄ SUSPENDED`. Only `ACTIVE` tenants are
operational; a `SUSPENDED` tenant is **read-only**, and a `PENDING` tenant is
closed.

- **Activation** (`PENDING → ACTIVE`): `platform.tenants.activate`, audited
  (`platform.tenantActivated`). A provisioned tenant is never usable before
  activation.
- **Suspension** (`ACTIVE → SUSPENDED`): `platform.tenants.suspend`, **a reason
  is required**, audited (`platform.tenantSuspended`). Suspension preserves all
  tenant data — it never deletes or mutates business records, and it never
  removes storage objects.
- **Reactivation** (`SUSPENDED → ACTIVE`): `platform.tenants.activate`, audited
  (`platform.tenantReactivated`); suspension metadata is cleared.
- **Transition integrity:** each lifecycle action uses an atomic, status-guarded
  `updateMany` (`where: { id, status: <expected> }`). A transition is rejected
  unless the tenant is in the exact expected prior state, so duplicate or
  contradictory transitions are impossible even under concurrency. The three
  transitions above are the complete set: `TENANT_STATUS_TRANSITIONS` in
  `src/server/services/tenant-lifecycle.ts` is the single source for the UI
  buttons, the action refusals and the verified list in
  `../implementation/phase-02-provider-administration-report.md`.
- **Suspension effect — writes and synchronization are denied; reads and
  downloads are kept.** This is the owner's Phase 2 decision, and it replaced the
  earlier "read _and_ write are blocked" rule. `resolveTenantContext` accepts a
  member of a suspended workspace and marks the context `readonly: true`
  (`suspended && !isPlatformAdmin`); `authorizeTenant` then routes every write
  through `assertWritableContext`, which refuses the permission and appends a
  `tenant.writeDenied` audit row (`{ reason: "tenant_suspended" }`) **before**
  throwing. Read and download permissions
  (`documents.read`, `documents.download`, `contacts.read`, …) resolve normally.
  Database-side, `app_tenant_accepts_writes()` gates the
  `has_tenant_write_access` family with `status <> 'SUSPENDED'`, while every
  `is_platform_admin()` branch in the read/write/admin families lets the provider
  that suspended the workspace keep repairing it. `PENDING` is enforced one layer
  up (`READABLE_TENANT_STATUSES = ["ACTIVE", "SUSPENDED"]`), because a workspace
  that was never opened has nothing to read.
- **Page-level guard:** `getWorkspaceState(locale[, permission])` in
  `src/server/auth/workspace.ts` runs server-side on every `/app/*` render. It
  returns `blocked`/`pending` for a `PENDING` workspace, and `status: "ok"` with
  `readonly: true` for a suspended one, so pages hide write affordances while the
  guard and the policies remain the enforcement. A suspended business sees a
  plain statement of why changes are paused — never a claim that data was lost.
- **Existing sessions:** nothing is revoked by suspension. Every protected request
  re-reads tenant status from the database, so the next request after a
  suspension is already read-only; a cached session can never authorize a write.
- **Offline clients are not reached by suspension.** The server answers a
  synchronization attempt with a refusal code (`tenant_suspended`,
  `no_membership`, `support_read_only`) through
  `src/server/services/tenant-indicators.ts`, records `sync.rejected`, and updates
  `Tenant.lastSyncAt` / `lastSyncErrorCode`. It cannot recall data already cached
  on a device, and no UI or document claims otherwise; the provider console states
  the limitation, and the indicator columns are what make "the device has not
  reported in since X" visible. **No transport calls `answerSyncRequest()` yet** —
  the sync endpoint is Phase 06 work, so `lastSyncAt` is honestly `null` today.
- **No automatic suspension.** Nothing in the platform suspends a tenant for an
  overdue payment or any other computed condition; `Plan` is an informational
  catalogue label with no entitlement logic. Suspension is a manual,
  permission-gated, reason-bearing provider action.
- **Admin surface:** `/admin/*` shows tenant lifecycle/administration metadata
  (status, timestamps, hostnames, membership counts, settings/branding/numbering
  summaries, plan label, indicators and the audit trail). It never reads tenant
  business rows — contact, catalogue and document content is not selectable by
  any provider query.

### 4.2 Hostname routing

- Tenant workspaces are served from `<slug>.<APP_BASE_DOMAIN>`, where the base
  domain is **configurable** (`APP_BASE_DOMAIN` / `NEXT_PUBLIC_APP_BASE_DOMAIN`)
  and never hardcoded. See `src/lib/tenancy/host.ts`.
- Slugs are validated (format + length) and checked against a reserved-hostname
  list (`www`, `admin`, `api`, …); a reserved subdomain can never be a tenant.
- `X-Forwarded-Host` is **untrusted** and ignored unless `TRUST_PROXY=true` is
  explicitly set behind a known proxy (`resolveRequestHost`).
- Host is **not** an authorization input: private data is gated by session +
  membership + tenant status, so an unknown, unverified or suspended host cannot
  expose private data. Reserved hosts are rejected in middleware.

---

## 5. Tenant data leakage risks & mitigations

| Leak vector                          | Mitigation                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Client-supplied `tenantId`           | Re-verified against membership; never used raw                                                                                                  |
| Id-only lookups (`findUnique({id})`) | Always confirm `record.tenantId === tenantId`; since Phase 1 the row is also invisible under RLS                                                |
| List endpoints missing tenant filter | Mandatory `where: { tenantId }` in every service query — **and** the policy family `has_tenant_read_access` as the database-side backstop       |
| Query with no tenant context at all  | `packages/database/src/scope.ts` is fail-closed: a scoped query without a context raises `ScopeNotSetError` rather than seeing every row        |
| Audit `metadata`                     | Minimise PII; `sanitize()` runs before serialisation, and a test asserts no credential-shaped key or value survives (§13.4)                     |
| Storage URLs                         | Private `tenant-branding` bucket; object policies scope by the tenant segment of the path; signed, short-lived URLs; never expose `sb_secret_*` |
| PDF generation                       | Snapshot tenant-scoped data at render time (M8)                                                                                                 |
| Session token                        | Carries identity + session version only — no tenant business data; platform standing is re-read from the `User` row per authorization           |

---

## 6. Input validation, output encoding & secrets

- **Input:** Zod schemas per action; emails trimmed/normalised before validation; identifiers validated as **UUID** (`z.string().uuid()`) since Phase 1 — non-UUID input fails as `VALIDATION_ERROR`, not as a lookup miss.
- **Output:** React escapes by default; avoid `dangerouslySetInnerHTML`; PDF/HTML templates must be sanitised.
- **DB access:** Prisma parameterised queries only — no string-built SQL. Raw SQL is
  limited to the template-literal tag (`$queryRaw`/`$executeRaw`) and exists for
  three deliberate reasons: the tenant-context GUC call
  (`set_config(…, true)`), the health probe, and audit appends (an ORM `create()`
  would be filtered by the SELECT policy for the runtime role). Values reach the
  server as bound parameters in a fixed column order; empty strings are encoded
  to SQL `NULL` with `nullif(…,'')`.
- **Secrets:** server-only; no `NEXT_PUBLIC_` prefix on `SUPABASE_SECRET_KEY`
  (`sb_secret_*`), `SMTP_PASSWORD`, `DATABASE_URL`, `DIRECT_URL` or
  `APP_DATABASE_URL`. Never log secrets (R9) — including connection errors,
  which is why probes catch `error.name` rather than the message.
- **Error handling:** generic client messages; detailed errors logged server-side only.
- **File uploads:** MIME/extension/size allow-lists (branding logo: image types,
  5 MB), stored outside the web root; Supabase Storage adoption is tracked in
  §13.5.

---

## 7. Token handling

- **Invitation tokens:** currently random 32-byte hex (fixed in Phase 01). **Recommendation:** store only a hash at rest; compare hashes; single-use, 7-day TTL; mark `EXPIRED` on timeout.
- **Password-reset tokens:** to be introduced; single-use, short TTL, hashed at rest, invalidate on use/password change.
- **Account verification tokens:** reuse Auth.js `VerificationToken` semantics.

---

## 8. Audit logging

- Writer: central `src/lib/audit` — **exists**; callers pass actor, tenant,
  action, resource, metadata.
- **Log:** authentication events, tenant/membership changes, role changes,
  invitation lifecycle, platform-admin actions, support-grant lifecycle
  (`support.accessGranted` / `…Revoked` / `…Used` / `…Denied`), authorization
  denials (`authz.denied`), document access, exports.
- **Protect:** append-only — the runtime role holds `SELECT, INSERT` on
  `AuditLog` and no update/delete path exists in the application. Metadata is
  sanitised of credential-shaped keys **before** serialisation, and a test
  re-introduces the defect to prove the assertion bites.
- **Read:** `audit.read` (owner/admin only) plus the support-grant read set;
  nothing in the UI exposes another tenant's trail.
- **Contract:** `AuditLog.action` strings (`auth.signIn`, `tenant.updated`,
  `team.*`, …) are stable identifiers — do not rename (see compatibility table).

---

## 9. Current gaps (must be closed) vs. present controls

| Control                                    | Status                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Server-side RBAC + tenant isolation        | **Present**                                                                               |
| Privilege-escalation guards                | **Present** (app layer + Phase 1 database triggers)                                       |
| Password hashing + status check            | **Present** (delegated to Supabase Auth; app re-checks status)                            |
| Audit of auth/tenant events                | **Present** — append-only by grant, sanitised metadata                                    |
| Middleware auth-bypass fix (R1)            | **Present** (Phase 02)                                                                    |
| Rate limiting (R3)                         | **Present (in-memory)**                                                                   |
| Email verification (R4)                    | **Present (no transport)**                                                                |
| Active-tenant enforcement (R5)             | **Present** (Phase 03; write/sync-vs-read split restated by Phase 2, §4.1)                |
| PostgreSQL row-level security              | **Present but inert** — see §13.1 (runtime role has no password)                          |
| Least-privileged database role             | **Present but unproven** — `amisibiz_app` grants exist, `APP_DATABASE_URL` is unpublished |
| Unique default membership constraint (R5b) | **Missing** (app-level only)                                                              |
| Integration isolation tests (R7)           | **Missing** (#37; the mock suites prove decisions, not policies)                          |
| Central redacting logger (R9)              | **Missing**                                                                               |
| Baseline commit / VCS protection (R2)      | **Present** — `a35c7aa` established the repository baseline                               |

---

## 10. Required security tests per phase (definition of done)

1. Cross-tenant access attempts are rejected (read **and** write).
2. Privilege escalation is rejected (invite, role change, platform actions).
3. Unauthenticated access to protected routes/actions is rejected.
4. Input validation rejects malformed/oversized/unknown fields.
5. Suspended tenants/users are denied.
6. Token replay/expiry/reuse is rejected.
7. Rate limits engage under burst load.
8. No secret or cross-tenant data appears in responses, logs, or bundles.

---

## 11. Phase 02 implementation status (Authentication, Authorization, RBAC)

**Implemented**

- Two disjoint security domains: `PlatformRole` (`PLATFORM_ADMIN`,
  `PLATFORM_SUPPORT` disabled, `USER`) and `TenantRole` (`BUSINESS_OWNER`,
  `BUSINESS_ADMIN`, `DOCUMENT_MANAGER`, `SALES_STAFF`, `VIEWER`).
- Central permission definitions + documented matrix (`lib/auth/permissions.ts`,
  `docs/architecture/permission-matrix.md`) and a server-side authorization
  service (`server/auth/authorization.ts`) with deny-by-default and audited
  denials.
- Auth actions: register (least-privileged platform role, owner membership),
  forgot-password (enumeration-safe), reset-password (single-use hashed token,
  session revocation), email verification.
- Login rate limiting (per IP and per email) and audited login failures;
  consistent recovery responses.
- Session expiry (8h) and revocation via `sessionVersion`; role change/removal
  revoke sessions.
- Middleware auth-bypass fixed (static-asset allow-list, **R1**); platform
  console route protected.
- `AccountToken` model stores only SHA-256 token hashes; audit metadata is
  sanitised of secrets.

**Still open (tracked, not claimed as done)**

| Item                                            | Reason / next step                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL Row-Level Security (RLS)             | **Closed by Phase 1** — policies + guard triggers landed in `20261018000002`; see §13 for why they are not yet _effective_ for the running app.           |
| Least-privileged database role                  | **Closed by Phase 1 in schema** — `amisibiz_app` (`NOINHERIT`, no `BYPASSRLS`, per-table verbs). Activation is an operator step: `docs/RUNBOOK.md` §3.    |
| Email transport (verification / reset delivery) | `lib/email` is a documented no-op; **production registration must stay disabled** until a transport is wired and `REQUIRE_EMAIL_VERIFICATION` is enabled. |
| Distributed rate limiting                       | In-memory only; move to a shared store (Redis/Upstash/Vercel KV) for multi-instance.                                                                      |
| Invitation token hashing at rest (R8)           | Invitations still store the raw token; migrate to hash-at-rest like `AccountToken`.                                                                       |
| Unique default membership constraint (R5b)      | `isDefault` is enforced in application logic only; add a partial unique index at the DB level.                                                            |
| DB-backed integration isolation tests (R7)      | Tests mock Prisma; add ephemeral-Postgres tests (task #37).                                                                                               |
| Baseline commit / VCS protection (R2)           | Done — `a35c7aa`.                                                                                                                                         |

---

## 12. Phase 03 implementation status (Tenant Lifecycle & Provider Administration)

**Implemented**

- Tenant lifecycle `PENDING | ACTIVE | SUSPENDED` with `activatedAt/By`,
  `suspendedAt/By` and `suspensionReason`. Only `ACTIVE` tenants are operational
  (see §4.1).
- Shared provisioning service (`server/services/tenant-provisioning.ts`): unique,
  validated, non-reserved slug; default `TenantSettings` (document numbering),
  `TenantBranding` and a `TenantDomain` hostname mapping; tenant created
  `PENDING`. Registration and platform-created tenants both use it.
- Owner provisioning is by invitation only: a `BUSINESS_OWNER` invitation is
  issued and must be accepted by the signed-in matching email — an owner is
  never assigned from a submitted email alone.
- Platform lifecycle actions (`server/actions/platform.ts`): `create`,
  `activate` (`PENDING→ACTIVE`), `suspend` (reason required, `ACTIVE→SUSPENDED`)
  and `reactivate` (`SUSPENDED→ACTIVE`), each permission-gated, atomic
  (status-guarded `updateMany`) and audited. New permission
  `platform.tenants.create`.
- Provider admin UI: `/admin` overview (counts by status + recently changed),
  `/admin/tenants` (search by name/slug + status filter) and
  `/admin/tenants/[id]` (lifecycle metadata + confirmation dialogs). Only
  administration metadata is shown — never tenant business data.
- Hostname routing utilities + middleware reserved-subdomain rejection, with a
  configurable base domain and untrusted forwarded-host handling (§4.2).

**Still open**

| Item                                                            | Reason / next step                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| DB-backed hostname verification (unknown/inactive host → block) | Host resolution does not query the database in middleware; relies on session/membership/status gating. |
| Subdomain → locale/tenant rewrite                               | Requests still route by `/{locale}` path; host is validated but not yet rewritten into tenant context. |
| Custom/verified domains (`TenantDomain.verifiedAt`)             | Model is present; verification workflow not implemented.                                               |
| Email delivery of owner invitations                             | Same no-transport limitation as Phase 02; invitation token is stored but not delivered.                |

---

## 13. Phase 1 implementation status (Core Authorization, RBAC catalog and RLS)

Migrations `20261018000000` (UUID identity + role alignment),
`20261018000001` (RBAC catalog, support access, tenant status history) and
`20261018000002` (RLS enforcement, storage policies, grant remediation) are the
Phase 1 schema layer. Design rationale lives in
`../implementation/phase-01-security-design.md`; operations live in
`../RUNBOOK.md`.

### 13.1 Present, but not yet _effective_

The policies exist in the database and are correct under the offline battery,
but they do not yet govern the running application, because the runtime still
connects as a role that is not subject to them: `amisibiz_app` is created
**password-less on purpose** (so no placeholder secret can be committed) and
`APP_DATABASE_URL` is therefore unpublished. Two consequences to keep straight:

- outside production the scoped client falls back to `DATABASE_URL` with one
  loud warning — a development convenience, not a security posture;
- in production the fallback is **refused at boot**
  (`packages/database/src/client.ts`): an unavailable service beats an
  unprotected one.

Until the operator step (`RUNBOOK.md` §3) is performed and `pnpm db:assert-rls`
exits `0`, no statement in this section may be described as "RLS enforced".

### 13.2 Two-layer enforcement and the tenant context

- **Application layer:** `authorizeTenant` / `authorizePlatform` /
  `authorizePlatformTenant` (`src/server/auth/authorization.ts`), deny-by-default,
  audited denials, `assertWritableContext` rejecting write paths on a read-only
  (support-grant) context.
- **Database layer:** policies written `TO amisibiz_app`, three families —
  `has_tenant_read_access` (members, or an active support grant),
  `has_tenant_write_access` (members only; **no support branch**),
  `has_tenant_admin_access` (owner/admin) — plus guard triggers that answer
  "which transitions" where policies answer "which rows".
- **Context:** five transaction-local GUCs (`app.current_tenant_id`,
  `app.current_user_id`, `app.current_tenant_role`, `app.is_platform_admin`,
  `app.is_platform_support`), written only by
  `public.set_tenant_context(text, text, text, boolean, boolean)` from
  `packages/database/src/scope.ts` (`enterScope` / `runInScope` / `runScoped`,
  fail-closed `ScopeNotSetError`). `set_config(…, true)` keeps the setting inside
  the transaction, which is the pooling-safe form under PgBouncer/Supavisor.
- **The claims are informational.** `is_platform_admin()`,
  `app_tenant_role(uuid)` and `has_support_grant(uuid)` re-read the `User` /
  `TenantMember` / `SupportAccessGrant` rows through `SECURITY DEFINER`
  functions, so a client-influenced claim cannot widen access. Role ranks exist
  in both layers and agree in ordering (`TENANT_ROLE_RANK` 6/5/4-4-4/2/1 and
  `app_tenant_role_rank(text)` 50/40/30-30-30/20/10).
- **Grants are the outer bound.** Migration `20261018000002` revokes the blanket
  `ALTER DEFAULT PRIVILEGES` river that migration `20261013000001` opened and
  grants exact verbs per table: `AuditLog` / `TenantStatusHistory` /
  `DocumentStatusEvent` are `SELECT, INSERT`; `Permission` / `RolePermission` are
  `SELECT`; `anon` and `authenticated` are stripped from AmisiBiz tables; there
  are no sequence grants (identities are UUIDs, document counters are rows
  updated inside `allocate_document_number()`).

### 13.3 Authentication (current mechanism)

Identity authority is Supabase Auth (GoTrue), adopted in Phase 04.5a;
migration `20261017000000` dropped the tables that backed the retired Auth.js
credentials stack. The trust chain in `src/lib/auth/session-user.ts`:

1. `getUser()` validates the access token against Supabase Auth server-side;
2. the token's `app_metadata.amisibiz_session_version` claim must equal
   `User.sessionVersion` in our database — revocation is enforced **here**, not
   by trusting the token, because a pre-bump token stays valid at Supabase until
   natural expiry (verified live in Phase 04.5a);
3. `User.status` must be `ACTIVE`; email verification is enforced only when
   `REQUIRE_EMAIL_VERIFICATION` is set, which requires a transport that does not
   exist yet.

Credentials are submitted server-side only; the browser never holds a Supabase
client. `sb_secret_*` stays out of bundles, logs and errors.

### 13.4 Audit trail

`AuditLog` is append-only by grant (§13.2) and its `metadata` is sanitised
**before** serialisation; the ordering is the defect that was fixed during
Phase 1 review (persisting the raw payload would have written a supplied
`password`/`token`/`secret` straight into the trail) and `security.test.ts`
asserts both the surviving key set and the serialised row, so reintroducing the
raw-payload version fails the suite.

### 13.5 Storage

Migration `20261018000002` §7 creates the private `tenant-branding` bucket (5 MB,
image MIME types) and `storage.objects` policies keyed on the tenant segment of
the path (`tenants/<uuid>/logo/<file>`, resolved by `app_object_tenant_id`).
**The application does not use it yet**: logo upload/serve still writes to the
filesystem `/uploads` path, so the DB-side policies are unexercised end-to-end.
Adoption plus cross-tenant policy proofs is tracked as task #36 — until then the
storage isolation claim is schema-only.

### 13.6 The eight required proofs — honest status

| #   | Required proof                                                 | Where it is decided                                                                           | Evidence today                                                                                                   |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | An anonymous caller cannot reach private tenant data           | No `anon`/`authenticated` privileges on AmisiBiz tables + middleware gate                     | grants in migration 10 (offline); **not** exercised live                                                         |
| 2   | Tenant A cannot read Tenant B                                  | `has_tenant_read_access` + `where: { tenantId }`                                              | offline scratch battery (67 assertions) and `integration-security.test.ts` (skipped without `TEST_DATABASE_URL`) |
| 3   | Tenant A cannot mutate Tenant B                                | `has_tenant_write_access` (no support branch)                                                 | same as #2                                                                                                       |
| 4   | A viewer cannot issue documents                                | matrix (`documents.*.issue` absent for `VIEWER`) + `authorizeTenant`                          | unit tests (mocked Prisma); the issuance flow itself is Phase 05 work                                            |
| 5   | A portal user cannot access internal business records          | `CUSTOMER_PORTAL_USER` holds 2 permissions; portal scoping                                    | unit assertion of the permission set; record-level portal filtering **unproven**                                 |
| 6   | Users cannot elevate their own role                            | `users_guard_update`, `tenant_members_guard_role_change`, `platformRole` not self-serviceable | offline battery; DB-enforced, not merely app-enforced                                                            |
| 7   | Tenant ids cannot be manipulated to bypass RLS                 | claims are re-derived from rows by `SECURITY DEFINER` helpers                                 | offline battery; `ScopeNotSetError` fail-closed path unit-tested                                                 |
| 8   | Privileged database credentials are absent from client bundles | only `NEXT_PUBLIC_*` may reach the client; `SUPABASE_SECRET_KEY` is server-only               | by construction + review; **no automated bundle scan exists**                                                    |
| —   | Storage policies prevent cross-tenant logo access              | `storage.objects` policies                                                                    | schema only — see §13.5                                                                                          |

**What is missing to call Phase 1 done:** a committed, CI-wired DB-backed
harness that runs #2, #3, #5, #6, #7 against a real PostgreSQL as
`amisibiz_app` (task #37), a code↔database permission-catalog parity test, an
automated bundle check for #8, and the operator step that makes any of it true
for the deployed app (task #38).

One evidence caveat worth stating plainly: the behavioral RLS battery that
produced the "offline" results above (67 assertions, run against a throwaway
local cluster) currently exists only as a git-ignored scratch file under `.tmp/`
(committing the work did not commit that battery — that is task #37). The
committed `apps/web/prisma/scripts/phase01-migration-checks.sql` covers the
structural side (policies present, grants narrowed, helpers executable) with
some role-switched checks, but the cross-tenant read/write behaviour is not yet
reproducible from the repository alone. Folding that battery into the harness is
part of #37 — until then those results cannot be re-run by anyone else, which is
exactly why they are not reported as "passing".

Until #37 and #38 land, business feature work (Phase 05, tasks #11–#15) stays
gated by the directive: _"Do not begin business feature development until the
core authorization and RLS tests pass."_

---

## 14. Phase 2 implementation status (Provider administration)

Migration `20261019000000_phase02_provider_administration_plans_and_suspension_gates`
is the Phase 2 schema layer. It is **authored and applied to a throwaway
database for checks only — not applied to the live Supabase project**, which is
still at migration 10 (owner decision: keep forward). Deliverable detail, the
verified transition list and the operator walkthrough live in
`../implementation/phase-02-provider-administration-report.md` and
`../administration/provider-console.md`.

**Implemented**

- **Permission catalog widened to 42 (9 platform / 33 tenant)** —
  `platform.tenants.update`, `platform.tenants.plan.assign`,
  `platform.tenants.domain.manage` and `platform.audit.read` join the five
  originals; `SUPER_ADMIN` holds all nine and `SUPPORT` still holds none.
- **Manual, provider-controlled lifecycle:** activate / suspend / reactivate,
  each with a mandatory reason and a confirmation step, each authorization-checked
  and written inside one `$transaction` together with its `TenantStatusHistory`
  row and its audit event. The status update is `updateMany` guarded on the
  expected prior status, so a concurrent transition cannot double-apply.
- **Suspension semantics (§4.1):** writes and synchronization denied, reads and
  downloads preserved; no row deletion, no storage deletion, no read-only mode
  removed from any existing tenant role.
- **No automatic suspension anywhere:** `Plan` is an informational catalogue
  (`PlanStatus` = `ACTIVE`/`ARCHIVED`, no price, no limit column, and a CHECK that
  refuses the shape of a billing table); assignment is a permission-gated,
  audited platform action and grants no access.
- **Operational indicators:** `Tenant.lastActivityAt`, `lastSyncAt`,
  `lastSyncErrorCode`, written only through the `SECURITY DEFINER` functions
  `touch_tenant_activity` / `record_tenant_sync_attempt` (granted to
  `amisibiz_app` only). `lastActivityAt` is stamped by `authorizeTenant` when a
  write permission is granted; a failure to stamp never refuses the operation.
- **Synchronization answers:** `answerSyncRequest()` returns
  `accepted`/`refused{code}` and records `sync.rejected` plus the indicator for a
  refusal. **It has no production caller yet** — the sync transport is Phase 06 —
  so `lastSyncAt` is legitimately `null` on the live project today.
- **Provisioning, search, domain/slug, branding, numbering and owner assignment**
  for the provider console, all through `authorizePlatform` /
  `authorizePlatformTenant` and `executeProviderWrite`, all audited
  (`platform.tenantUpdated`, `platform.tenantPlanAssigned`,
  `platform.tenantBrandingUpdated`, `platform.tenantNumberingUpdated`,
  `platform.tenantDomainUpdated`, `platform.tenantOwnerAssigned`,
  `platform.tenantOwnerInvited`, `tenant.created`).
- **Provider console UI** at `/admin`, `/admin/tenants` (search, status and plan
  filters, pagination that preserves filters), `/admin/tenants/new` and
  `/admin/tenants/[id]` with the lifecycle actions derived from
  `TENANT_STATUS_TRANSITIONS`, the status-history trail, the audit panel (shown
  as an explicit refusal when `platform.audit.read` is missing), branding,
  domains, numbering and document-preview shells.

**Still open (recorded, not claimed)**

| Item                                   | Why                                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration 11 not applied to live       | Applying it is an owner-gated operation; the schema is unexercised on the project until then, so the Phase 2 indicators and plan catalogue exist only in code + local checks. |
| DB-backed proof of the suspension gate | Same gap as §13.6 / #37 — the write-vs-read split is proven by unit tests against the mock and by `app_tenant_accepts_writes()` in SQL, not by a live cross-role test.        |
| RLS inert                              | #38 operator step still pending (§13.1).                                                                                                                                      |
| Real document previews                 | What ships is a branding preview shell; per-document rendering is Phase 05 (#13).                                                                                             |
| Provider-side logo storage             | Still the filesystem `/uploads` path; bucket + object policies exist since migration 10 (#36).                                                                                |
| Tenant self-service branding           | Intentionally not enabled: the permission (`business.branding.update`) and row already exist so it can be switched on without touching document templates.                    |
