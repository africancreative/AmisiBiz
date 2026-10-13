# AmisiBiz — Security Model

- **Status:** Alignment document (Phase 00)
- **Applies to:** all phases
- **Companion docs:** `repository-audit.md`, `system-design.md`

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

- **Platform roles** (`PlatformRole`): `PLATFORM_ADMIN`, `PLATFORM_SUPPORT` (disabled), `USER`. See `permission-matrix.md`.
- **Tenant roles** (`TenantRole`): `BUSINESS_OWNER > BUSINESS_ADMIN > DOCUMENT_MANAGER > SALES_STAFF > VIEWER`.
- **Enforcement point:** `authorizeTenant(userId, tenantId, permission)` and `authorizePlatform(userId, permission)` in `src/server/auth/authorization.ts`, called by every action/route. Deny-by-default.
- **Implemented guards:**
  - membership required; non-`ACTIVE` tenant (`PENDING`/`SUSPENDED`) rejected; missing permission rejected;
  - cannot invite/assign a role ≥ your own;
  - cannot modify/remove a member with a higher role; self-modification blocked;
  - last-`BUSINESS_OWNER` protection;
  - platform privileges never granted by tenant membership.
- **Page-level guard:** `getWorkspaceState(locale[, permission])` in `src/server/auth/workspace.ts` runs server-side on every `/app/*` render (layout + each module page). It resolves membership and tenant status, and — where a permission is supplied — authorizes it against the database, rendering a controlled denied/unavailable state otherwise. Suspended tenants cannot load any `/app/*` screen.
- **Rules for new modules (M4–M9):** every service signature takes `actorUserId` + `tenantId`; every query filters by `tenantId`; platform scopes are explicit, separately gated, and audited.
- **Open decisions:** visibility of pending invitation emails (R11) and whether `SUPPORT` gets read-only platform access.

### 4.1 Tenant lifecycle & suspension policy (Phase 03)

Tenants follow `PENDING → ACTIVE ⇄ SUSPENDED`. Only `ACTIVE` tenants are
operational.

- **Activation** (`PENDING → ACTIVE`): `platform.tenants.activate`, audited
  (`platform.tenantActivated`). A provisioned tenant is never usable before
  activation.
- **Suspension** (`ACTIVE → SUSPENDED`): `platform.tenants.suspend`, **a reason
  is required**, audited (`platform.tenantSuspended`). Suspension preserves all
  tenant data — it never deletes or mutates business records.
- **Reactivation** (`SUSPENDED → ACTIVE`): `platform.tenants.activate`, audited
  (`platform.tenantReactivated`); suspension metadata is cleared.
- **Transition integrity:** each lifecycle action uses an atomic, status-guarded
  `updateMany` (`where: { id, status: <expected> }`). A transition is rejected
  unless the tenant is in the exact expected prior state, so duplicate or
  contradictory transitions are impossible even under concurrency.
- **Suspension effect — read _and_ write are blocked.** `authorizeTenant`
  denies every tenant operation while a tenant is not `ACTIVE`, and the
  page-level guard `getWorkspaceState` renders a controlled "workspace
  unavailable" state for all `/app/*` screens. This is enforced consistently
  across UI, server actions and (future) export/PDF paths, which all call the
  same authorization entry point. There is no read-only-after-suspension mode.
- **Revalidation:** status is re-read from the database on every protected
  request; a cached session can never authorize a suspended tenant.
- **Admin surface:** `/admin/*` shows only tenant lifecycle/administration
  metadata (status, timestamps, hostname, membership count, settings/branding
  summaries). It never exposes tenant business data (contacts, invoices,
  catalogue/documents).

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

| Leak vector                          | Mitigation                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Client-supplied `tenantId`           | Re-verified against membership; never used raw                                       |
| Id-only lookups (`findUnique({id})`) | Always confirm `record.tenantId === tenantId` (pattern already used in team actions) |
| List endpoints missing tenant filter | Mandatory `where: { tenantId }` in every service query                               |
| Audit `metadata`                     | Minimise PII; never store secrets (R8)                                               |
| Storage URLs                         | Signed, short-lived URLs; never expose service-role keys (M7)                        |
| PDF generation                       | Snapshot tenant-scoped data at render time (M8)                                      |
| Session/JWT                          | Contains only `userId`/role/status — no tenant business data                         |

---

## 6. Input validation, output encoding & secrets

- **Input:** Zod schemas per action; emails trimmed/normalised before validation; IDs validated as `cuid`.
- **Output:** React escapes by default; avoid `dangerouslySetInnerHTML`; PDF/HTML templates must be sanitised.
- **DB access:** Prisma parameterised queries only — no string-built SQL. Raw SQL (`SELECT 1` health check) uses the template literal tag.
- **Secrets:** server-only; no `NEXT_PUBLIC_` prefix on `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_PASSWORD`, `AUTH_SECRET`, `DATABASE_URL`. Never log secrets (R9).
- **Error handling:** generic client messages; detailed errors logged server-side only.
- **File uploads (future):** enforce MIME/extension/size allow-lists and store outside the web root.

---

## 7. Token handling

- **Invitation tokens:** currently random 32-byte hex (fixed in Phase 01). **Recommendation:** store only a hash at rest; compare hashes; single-use, 7-day TTL; mark `EXPIRED` on timeout.
- **Password-reset tokens:** to be introduced; single-use, short TTL, hashed at rest, invalidate on use/password change.
- **Account verification tokens:** reuse Auth.js `VerificationToken` semantics.

---

## 8. Audit logging

- Writer: central `src/lib/audit` (to be created); callers pass actor, tenant, action, resource, metadata.
- **Log:** authentication events, tenant/membership changes, role changes, invitation lifecycle, platform-admin actions, document access, exports.
- **Protect:** append-only (no delete/update paths exposed); restrict read access; never store passwords/tokens/secrets.
- **Contract:** `AuditLog.action` strings (`auth.signIn`, `tenant.updated`, `team.*`, …) are stable identifiers — do not rename (see compatibility table).

---

## 9. Current gaps (must be closed) vs. present controls

| Control                                    | Status                       |
| ------------------------------------------ | ---------------------------- |
| Server-side RBAC + tenant isolation        | **Present**                  |
| Privilege-escalation guards                | **Present**                  |
| Password hashing + status check            | **Present**                  |
| Audit of auth/tenant events                | **Present (write-only)**     |
| Middleware auth-bypass fix (R1)            | **Present** (Phase 02)       |
| Rate limiting (R3)                         | **Present (in-memory)**      |
| Email verification (R4)                    | **Present (no transport)**   |
| Active-tenant enforcement (R5)             | **Present** (Phase 03)       |
| Unique default membership constraint (R5b) | **Missing** (app-level only) |
| Integration isolation tests (R7)           | **Missing**                  |
| Central redacting logger (R9)              | **Missing**                  |
| Baseline commit / VCS protection (R2)      | **Missing**                  |

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
| PostgreSQL Row-Level Security (RLS)             | Not enabled. Must be tested under the **application** DB role and use `SET LOCAL` scoped to the connection; do not assume a privileged role enforces RLS. |
| Least-privileged database role                  | Currently the Supabase `postgres` role is used. Introduce a restricted app role with no `BYPASSRLS`.                                                      |
| Email transport (verification / reset delivery) | `lib/email` is a documented no-op; **production registration must stay disabled** until a transport is wired and `REQUIRE_EMAIL_VERIFICATION` is enabled. |
| Distributed rate limiting                       | In-memory only; move to a shared store (Redis/Upstash/Vercel KV) for multi-instance.                                                                      |
| Invitation token hashing at rest (R8)           | Invitations still store the raw token; migrate to hash-at-rest like `AccountToken`.                                                                       |
| Unique default membership constraint (R5b)      | `isDefault` is enforced in application logic only; add a partial unique index at the DB level.                                                            |
| DB-backed integration isolation tests (R7)      | Tests mock Prisma; add ephemeral-Postgres tests.                                                                                                          |
| Baseline commit / VCS protection (R2)           | Repository still has no commits.                                                                                                                          |

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
