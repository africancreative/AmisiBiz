# AmisiBiz — Phased Implementation Checklist

- **Status:** Active plan (Phases 00–03 complete)
- **Companion docs:** `../architecture/repository-audit.md`, `../architecture/system-design.md`, `../architecture/security-model.md`

Rules: implement **one phase at a time**; do not start a phase whose dependencies are unmet; every phase ends with the verification suite below green and a completion report.

---

## 1. Migration strategy

- **Engine:** Prisma Migrate against Supabase PostgreSQL.
- **Connections:** migrations use `DIRECT_URL`; runtime uses pooled `DATABASE_URL` (`pgbouncer=true&connection_limit=1`).
- **Baseline:** `prisma/migrations/20261013000000_init` is the initial migration (**authored offline, not yet applied to any DB**). Apply with `prisma migrate deploy` once a database exists; `prisma migrate dev` only for local authoring.
- **Never** use `prisma db push` against shared/staging/production databases.
- **Change discipline:** expand → backfill → contract for breaking changes; one logical change per migration; review generated SQL before applying; no manual production edits.
- **Data safety:** no destructive drops without a backup and a reversible plan; seed scripts must be idempotent and must not contain default credentials.
- **Naming:** `<timestamp>_<snake_case_summary>`; keep `migration_lock.toml` committed.
- **Rollback:** prefer forward-fix migrations; document any irreversible step in the phase report.

---

## 2. Testing strategy

| Layer          | Tool                                                            | Scope                                                           | Gate          |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| Unit           | Vitest                                                          | Pure logic, validators, guards (mocked Prisma/Auth)             | every phase   |
| Integration    | Vitest + ephemeral Postgres (Testcontainers or Supabase branch) | Real queries, tenant isolation, RBAC, transactions              | from Phase 01 |
| Contract       | Vitest                                                          | Server-action/route input→output contracts                      | from Phase 02 |
| E2E            | Playwright                                                      | Critical journeys (register, login, invite/accept, module CRUD) | from Phase 03 |
| Security suite | Vitest                                                          | Section 10 of `security-model.md`                               | every phase   |

**Definition of done for every phase:** `type-check`, `lint`, `test`, `build` all green + phase-specific security tests. Coverage thresholds to be set in Phase 07.

---

## 3. Minimum environment variables

| Variable                                          | Local dev | Test                     | Vercel             | Notes                          |
| ------------------------------------------------- | --------- | ------------------------ | ------------------ | ------------------------------ |
| `NEXT_PUBLIC_APP_URL`                             | required  | —                        | required           | public; used by metadata/links |
| `NEXT_PUBLIC_APP_NAME`                            | optional  | —                        | optional           | public                         |
| `DATABASE_URL`                                    | required  | dummy (mocked)           | required           | pooled Supabase URL            |
| `DIRECT_URL`                                      | required  | dummy                    | required           | direct URL for migrations      |
| `AUTH_SECRET`                                     | required  | dummy (`tests/setup.ts`) | required           | ≥ 32 bytes                     |
| `AUTH_URL`                                        | required  | —                        | optional (derived) | local dev only                 |
| `AUTH_TRUST_HOST`                                 | optional  | —                        | as needed          | for non-Vercel hosts           |
| `APP_BASE_DOMAIN` / `NEXT_PUBLIC_APP_BASE_DOMAIN` | optional  | —                        | required (routing) | tenant hostname base domain    |
| `TRUST_PROXY`                                     | optional  | —                        | as needed          | trust `X-Forwarded-Host`       |
| `SEED_*`, `ALLOW_PROD_SEED`                       | optional  | —                        | optional           | super-admin bootstrap          |
| `SUPABASE_*`, `SMTP_*`, `EMAIL_FROM`              | optional  | —                        | optional           | server-only keys               |

Tests run with mocks; `tests/setup.ts` supplies placeholder values. Never place real secrets in `.env.example` or client bundles. `.env.example` was updated in Phase 00 to document `AUTH_TRUST_HOST`.

---

## 4. Phase checklist

### Phase 00 — Repository audit ✅ COMPLETE

- **Deliverables:** `repository-audit.md`, `system-design.md`, `security-model.md`, `phase-checklist.md`; `.env.example` clarified.
- **Acceptance:** accurately describes current state, identifies material risks (R1–R12), defines module boundaries, migration/testing strategies, env vars, phase plan.

### Phase 01 — Foundation (auth, tenants, minimal RBAC) ✅ SUPERSEDED BY PHASE 02

- Credentials auth, registration, initial RBAC helpers, team actions, login/register/dashboard/team UI, initial migration, safe seed.
- The role model and enforcement from this phase were replaced by the Phase 02
  authorization service and permission matrix.

### Phase 02 — Authentication, Authorization & RBAC ✅ COMPLETE

- **Delivered:** two disjoint role domains (`PlatformRole` / `TenantRole`);
  central permission definitions + documented matrix
  (`docs/architecture/permission-matrix.md`); server-side authorization service
  with deny-by-default + audited denials; register/login/logout/password-reset/
  email-verification flows; login rate limiting; session expiry + revocation;
  platform console (suspend/activate); middleware auth-bypass fix (**R1**);
  `AccountToken` (hashed, single-use); 39 passing security tests.
- **Still open:** RLS + least-privileged DB role; email transport (blocks
  production registration); distributed rate limiting; hash invitation tokens
  (**R8**); active-tenant/unique-default (**R5**); DB-backed isolation tests
  (**R7**); baseline commit (**R2**).
- **Depends on:** Phase 01.

### Phase 03 — Tenant lifecycle & provider administration ✅ COMPLETE

- **Delivered:** tenant lifecycle `PENDING | ACTIVE | SUSPENDED` with
  activation/suspension metadata; `TenantSettings`, `TenantBranding` and
  `TenantDomain` models; shared provisioning service (unique/validated slug,
  default settings/branding, hostname mapping, `PENDING` on create); owner
  provisioning by invitation only; platform lifecycle actions (`create`,
  `activate`, `suspend` with required reason, `reactivate`) — permission-gated,
  atomic (status-guarded), audited; provider admin UI (overview counts + recently
  changed, searchable/filterable tenant list, tenant detail with confirmation
  dialogs, metadata only); configurable-base-domain hostname routing with reserved
  hostnames and untrusted forwarded-host handling; suspension blocks all
  workspace read/write while preserving data. New permission
  `platform.tenants.create`. 63 passing tests.
- **Still open:** DB-backed hostname verification / subdomain→tenant rewrite;
  custom-domain verification (`TenantDomain.verifiedAt`); email delivery of owner
  invitations; unique-default membership DB constraint (**R5b**).
- **Depends on:** Phase 02.

### Phase 04 — Contacts

- Tasks: `Contact` model (customer/supplier), CRUD services with tenant scoping, dedupe, soft-delete, import/export — each guarded by `contacts.*` permissions.
- **Acceptance:** contacts are tenant-isolated; permissions enforced; search works; E2E CRUD journey green.
- **Depends on:** Phase 03 (settings).

### Phase 05 — Catalogue

- Tasks: `Product`, `Unit`, `PriceList`, tax linkage to settings — guarded by `items.*`.
- **Acceptance:** products/prices tenant-isolated; tax derives from settings; role-gated writes.
- **Depends on:** Phase 04.

### Phase 06 — Documents & PDF generation

- Tasks: `Document` metadata + storage adapter (Supabase Storage, signed URLs); `lib/pdf` renderer from DTOs; issue/void/download guarded by `documents.*`.
- **Acceptance:** uploads validated (type/size/extension); URLs signed/short-lived; no service-role key client-side; PDFs deterministic and tenant-branded.
- **Depends on:** Phase 05.

### Phase 07 — Audit viewer & observability

- Tasks: central `lib/audit` writer (done); audit viewer for platform/tenant admins; structured redacting logger; error tracking.
- **Acceptance:** privileged actions emit audit rows; viewer permission-gated; no secrets/PII leakage in logs.
- **Depends on:** Phase 03.

### Phase 08 — Hardening & release readiness

- Tasks: full security suite, RLS + least-privileged DB role, distributed rate limiting, email transport, coverage thresholds, performance/load, E2E breadth, accessibility pass, deployment config (`vercel.json`), CI pipeline, backups/DR runbook.
- **Acceptance:** green CI on PRs; documented deployment actually executed and verified; DR tested.
- **Depends on:** Phases 02–07.

---

## 5. Change-control / compatibility notes

- Do not upgrade `next-intl` to v4 without a coordinated migration (breaking).
- Do not re-enable `experimental.typedRoutes` without casting locale-prefixed hrefs.
- Keep middleware on the Node runtime while the session callback uses Prisma.
- Do not rename `AuditLog.action` values.
- Do not alter `TenantMember` uniqueness/default semantics without a data migration.
- Preserve the `authorizeTenant` / `authorizePlatform` enforcement pattern in every
  new module; never reintroduce role-list checks or trust client-supplied roles.
- Do not grant tenant roles any `platform.*` permission or vice versa.

---

## 6. Immediate next action

Commit the baseline (**R2**), then proceed to **Phase 04 (Contacts)**.
Before production registration is enabled, wire an email transport and enable
`REQUIRE_EMAIL_VERIFICATION`; before production launch, implement RLS, a
least-privileged DB role, and distributed rate limiting (Section 4, Phase 08).
