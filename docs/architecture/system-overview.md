# AmisiBiz — System Overview (as-built)

- **Status:** As-built record. Verified by direct inspection of `main` at
  `ddcdec9` ("feat(portal): implement Customer Portal product area"), 2026-10-17.
- **Audience:** Engineering, delivery, technical lead.
- **Supersedes:** `system-design.md` **for the as-built description only**.
  `system-design.md` remains the Phase 00 _target_ design and the record of the
  original module-boundary decisions; where the two disagree about _what exists
  today_, this document wins.
- **Companion docs:** `data-model.md`, `security-model.md`
  (§13–§15 = current enforcement), `permission-matrix.md`,
  `../implementation/agent-work-plan.md`, `../implementation/acceptance-matrix.md`,
  `../RUNBOOK.md`, `../IMPLEMENTATION_STATUS.md`.
- **Honesty rule:** a feature is listed **Implemented** only when its code is in
  the tree and the mocked unit/contract suite exercises it. Database-backed
  proofs (RLS harness) and deployment are labelled separately and are **not**
  claimed as verified unless the evidence says so.

> **Important correction to the older docs.** The Phase 00 design
> (`system-design.md`) and parts of `security-model.md` §1–§12 describe an
> **Auth.js + Supabase** stack. That is historical. Commit `2fff426`
> ("completely remove Supabase implementation and adopt native Neon
> PostgreSQL") replaced it: the application now uses **Neon PostgreSQL +
> Prisma** and **native HMAC-signed cookie sessions**. No `@supabase/*`
> package, `lib/supabase/*` module, or Supabase admin client remains in the
> source tree.

---

## 1. What AmisiBiz is

Multi-tenant business document and mini-CRM platform by **Amisi Genuine
Enterprises**. One codebase serves three product areas:

1. **Platform administration** — Amisi Genuine internal staff (provider) manage
   tenants, plans, lifecycle (activation/suspension), support access and audit.
2. **Tenant business workspace** — a customer business manages its own contacts,
   catalogue, documents (quotations / invoices / delivery notes), branding and
   team.
3. **Customer portal** — a tenant's own customer signs in and downloads the
   documents issued to them.

---

## 2. Technology stack (verified)

| Concern              | Choice                                                                                  | Evidence                                                       |
| -------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Language             | TypeScript 5.8, `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`    | `apps/web/tsconfig.json`, `packages/config/tsconfig/*`         |
| Framework            | Next.js `^15.3.3` — App Router, RSC + Server Actions                                    | `apps/web/package.json:39`, `apps/web/src/app/**`              |
| UI runtime           | React `^19.1.0`                                                                         | `apps/web/package.json:41-42`                                  |
| Styling / UI kit     | Tailwind CSS 3.4 + custom `@amisibiz/ui` kit (`apps/web/src/components/ui` also exists) | `packages/ui/src/*`, `apps/web/tailwind.config.ts`             |
| i18n                 | `next-intl` 3.26.5 — locales `en`, `fr`, `sw`, `localePrefix: "always"`                 | `apps/web/src/lib/i18n/routing.ts`, `messages/{en,fr,sw}`      |
| Database             | **PostgreSQL (Neon)** via **Prisma 6.19.3**; 20 migrations                              | `apps/web/prisma/schema.prisma`, `apps/web/prisma/migrations/` |
| Auth                 | **Native**: bcryptjs (cost 12) + HMAC-SHA256 signed HttpOnly cookie `amisibiz_session`  | `apps/web/src/lib/auth/{token,session,session-user}.ts`        |
| Validation           | Zod 3.24                                                                                | `apps/web/src/lib/validations/*`, `packages/domain`            |
| Rate limiting        | `ioredis` or Upstash REST, in-memory fallback in dev                                    | `apps/web/src/lib/security/rate-limit.ts`                      |
| Money / documents    | `@amisibiz/documents` (decimal-safe formatting, numbering, PDF writer)                  | `packages/documents/src/*`                                     |
| Tests                | Vitest 3 (18 suites; 420 passed / 26 skipped at last run)                               | `apps/web/tests/*`, run 2026-10-17                             |
| Monorepo             | pnpm `11.18.0` workspaces + Turborepo; Node `>=20` (CI uses 24)                         | root `package.json`, `pnpm-workspace.yaml`, `turbo.json`       |
| Email / integrations | **None live** — `lib/email` is a documented no-op; `@amisibiz/integrations` are mocks   | `apps/web/src/lib/email/index.ts`, `packages/integrations/src` |
| Deployment target    | Vercel (per README). No `vercel.json` in-tree.                                          | `README.md` §Deployment                                        |

**Absent (requested by the FINAL MVP spec):** Drizzle ORM, Playwright / E2E
tests, a live email transport, a real file/storage model.

---

## 3. Repository layout

```
apps/
  web/       @amisibiz/web      Next.js 15 App Router app — the product
  mobile/    @amisibiz/mobile   Capacitor Android shell (configured scaffold)
  desktop/   @amisibiz/desktop  Tauri 2 Windows shell (configured scaffold)
packages/
  auth/         roles, permission catalogue + role matrices, session contract
  database/     scope-aware Prisma client, RLS probes, DB env validation
  documents/    money/decimals, numbering, lifecycle, PDF contracts
  domain/       pure validation + branding-contrast + repository ports (ports unused)
  integrations/ eTIMS/DPO/POS/verification contracts + explicitly-labelled mocks
  offline/      SQLite storage/outbox/sync client (tested; not wired into web)
  sync/         transport/queue/conflict contracts (types only in web)
  ui/           the component kit
  config/       shared tsconfig bases + ESLint flat config
docs/           architecture / implementation / administration / RUNBOOK
scripts/        db (clean-room chain), security (bundle scan)
```

---

## 4. Runtime architecture (as-built)

```
Browser (locale-prefixed routes; tenant host <slug>.<APP_BASE_DOMAIN>)
  │
  ▼
Next middleware — Node runtime (src/middleware.ts)
  • next-intl locale routing
  • reserved-subdomain 404 · host resolution (trusts X-Forwarded-Host only if TRUST_PROXY=true)
  • HMAC cookie verify (coarse UI gate; NOT the authorization decision)
  │
  ▼
App Router (RSC pages + Server Actions + Route Handlers)
  │  reads  → lib/* queries and server/auth guards
  │  writes → server/actions/* ("use server") and api/* route handlers
  ▼
server/auth/authorization.ts — the ONLY place that opens tenant/user scope
  • deny-by-default permission matrix (packages/auth)
  • membership / lifecycle / support-grant resolution from the DB
  ▼
server/services/** — business rules + multi-step transactions
  ▼
@amisibiz/database — scope-aware Prisma proxy → transaction-local set_config('app.*')
  ▼
Neon PostgreSQL — RLS (amisibiz_app role) + guard triggers + append-only audit
                              + DB functions (set_tenant_context, allocate_document_number, …)
```

Two independent enforcement layers, by design: the **application matrix**
answers "may this role do this thing"; **RLS** answers "which rows exist for
you". The scope-aware Prisma proxy is fail-closed: a scoped query with no open
scope raises `ScopeNotSetError` rather than reading across tenants.

---

## 5. Layering & module boundaries (as-built)

```
app/ (routing, UI)            → may import components, server/actions, lib
server/actions/ (transport)   → Zod validate → authorize → call a service → map to ActionResult
server/services/ (domain)     → business rules + multi-step transactions
lib/ (infrastructure)         → auth, tenancy, i18n, audit, security, validations, email(stub)
server/auth/ (guard)          → identity + tenant context + permission + write gate
prisma/ (schema, migrations, seed)
```

Cross-cutting rules in force:

- Server Actions/Route Handlers are thin transport; no business rules inline.
- Services never read cookies/headers; identity + tenant are passed in.
- One place constructs a `PrismaClient` and one place opens request scope.
- All user-facing strings are externalised (`messages/{en,fr,sw}`).

---

## 6. The three product areas (as-built route map)

All routes are locale-prefixed by `next-intl`.

### 6.1 Platform administration

| Route                                   | Purpose                                                                                    | Guard                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------- |
| `/[locale]/platform`                    | Provider console — tenant list + lifecycle actions                                         | `authorizePlatform(TENANTS_READ)` |
| `/[locale]/platform/audit`              | Cross-tenant audit viewer                                                                  | `PLATFORM_AUDIT_READ`             |
| `/[locale]/admin`                       | Admin shell + overview counts / recent changes                                             | `PLATFORM_TENANTS_READ`           |
| `/[locale]/admin/tenants`               | Searchable/paginated tenant list                                                           | `PLATFORM_TENANTS_READ`           |
| `/[locale]/admin/tenants/new`           | Provision a tenant                                                                         | `tenants.create`                  |
| `/[locale]/admin/tenants/[id]`          | Tenant detail: lifecycle, owner, plan, domains, numbering, branding, status history, audit | platform perms                    |
| `/api/platform/tenants/[tenantId]/logo` | Provider logo upload/read                                                                  | platform perms                    |

> **Note (drift):** two parallel platform trees exist — `platform/*`
> (standalone `main` shell) and `admin/*` (`AdminShell`). They overlap in
> purpose; consolidation is a backlog item (see `agent-work-plan.md` §4).

### 6.2 Tenant business workspace

| Route                              | Purpose                                                                     | Guard                                  |
| ---------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| `/[locale]/app`                    | Workspace dashboard / overview                                              | `getWorkspaceState` + `DOCUMENTS_READ` |
| `/[locale]/app/contacts`           | CRM contacts list                                                           | workspace + permission                 |
| `/[locale]/app/contacts/[id]`      | Contact detail                                                              | workspace + permission                 |
| `/[locale]/app/items`              | Catalogue items                                                             | workspace + permission                 |
| `/[locale]/app/documents`          | Documents list                                                              | workspace + permission                 |
| `/[locale]/app/documents/new`      | New document                                                                | workspace + permission                 |
| `/[locale]/app/documents/[id]`     | Document detail / actions                                                   | workspace + permission                 |
| `/[locale]/app/settings/branding`  | Tenant branding                                                             | workspace + permission                 |
| `/[locale]/app/settings/audit`     | Tenant audit trail                                                          | `audit.read`                           |
| `/[locale]/team`                   | Members + invitations                                                       | workspace + delegation guards          |
| `/[locale]/dashboard`              | Legacy/simple dashboard (redirects admins→`/admin`, portal users→`/portal`) | session                                |
| `/api/sync/push`, `/api/sync/pull` | Offline sync transport (closed registry)                                    | bearer/cookie session                  |

> **Note (drift):** `/[locale]/dashboard` and `/[locale]/app` are overlapping
> dashboards; `/team` uses a standalone shell rather than the workspace shell.

### 6.3 Customer portal

| Route                                    | Purpose                                | Guard                     |
| ---------------------------------------- | -------------------------------------- | ------------------------- |
| `/[locale]/portal`                       | Issued-document list (drafts excluded) | `getPortalState`          |
| `/api/portal/documents/[documentId]/pdf` | Portal PDF download                    | portal contact resolution |

Portal access is `Contact.portalUserId` + `TenantMember.role =
CUSTOMER_PORTAL_USER`; the download route refuses any document whose
`contactId` is not the resolved contact.

### 6.4 Authentication & system

`/[locale]/login`, `/register`, `/forgot-password`, `/reset-password`;
`/auth/callback`; `/api/health`; `/uploads/tenants/[...path]` (private asset
serving); `/api/documents/[documentId]/pdf`, `/api/branding/logo`.

> `/[locale]/verify-email` is listed in `README.md` but **does not exist** in the
> tree — a documentation drift item.

---

## 7. Authentication & authorization (summary)

Full detail lives in `security-model.md` §13 (Phase 1) and §15 (as-built). In
brief:

- **Session:** HMAC-SHA256 token in an HttpOnly `amisibiz_session` cookie
  carrying `{ userId, sessionVersion, platformRole?, exp }`; verified per request
  via WebCrypto. A DB re-check requires `status = ACTIVE` and a matching
  `sessionVersion`; bumping the version is a global logout.
- **A bearer variant** (`Authorization: Bearer`) resolves the same session for
  non-browser clients (sync), through an `AsyncLocalStorage` request-session
  override.
- **Authorization:** `server/auth/authorization.ts` resolves actor/tenant/role
  from the database (never from the browser), checks the `packages/auth`
  permission matrix (deny-by-default), distinguishes membership from a
  time-boxed **support grant** (read-only), audits denials, and gates writes
  (blocked for suspended tenants and support contexts).
- **Tenancy:** server-side membership; hostname is a routing input, not an
  authorization input; `X-Forwarded-Host` is ignored unless `TRUST_PROXY=true`.
- **Rate limiting:** login (per IP + per email), register, forgot/reset — Redis
  or Upstash when configured, otherwise in-memory (dev bypass unless
  `ENABLE_DEV_RATE_LIMIT=true`).

---

## 8. Multi-tenancy & row-level security

- Single database, shared schema, row scoping by `tenantId`.
- The runtime connection is the least-privileged `amisibiz_app` role via
  `APP_DATABASE_URL` (no `BYPASSRLS`); `DATABASE_URL`/`DIRECT_URL` are the
  owner/CLI connections used by Prisma Migrate. Outside production the scoped
  client may fall back to the owner URL with a loud warning; production refuses
  the fallback when `STRICT_APP_ROLE=true`.
- Each unit of work runs in a transaction that calls
  `public.set_tenant_context(...)`, writing transaction-local `app.*` GUCs that
  the RLS policy families read.
- **RLS effectiveness is an operator step, not yet performed** — see
  `security-model.md` §13.1 and
  `../administration/rls-activation-operator-procedure.md`.

---

## 9. Data & storage

The data model is documented in `data-model.md` (29 models, 15 enums). Storage
notes:

- There is **no dedicated file/document-storage model**. Branding/logo assets
  are referenced by URL fields (`TenantBranding.logoUrl`, `Tenant.logoUrl`),
  served through the private `/uploads/tenants/[...path]` handler, and governed
  by `storage.objects` policies introduced in migration
  `20261018000002_rls_enforcement_storage_and_grants` plus the per-tenant
  `logo-storage` service.
- Document binaries are produced on demand (PDF route) from the frozen
  `Document.snapshot`; issued documents are immutable at the database level.

---

## 10. Internationalisation & UI

- `next-intl` middleware + plugin; locales `en/fr/sw`; single message file per
  locale at `apps/web/messages/<locale>/index.json`.
- UI is the workspace kit `@amisibiz/ui`, plus app-level components under
  `apps/web/src/components/{layout,auth,branding,contacts,dashboard,items,platform,team,tenant,audit,ui}`.
  There is **no shadcn/ui dependency** despite early plans.
- Tenant branding (colours/logo) is applied per tenant and validated for WCAG
  contrast.

---

## 11. Testing & CI

- **Suites:** 18 Vitest files under `apps/web/tests/`. Last verified run
  (2026-10-17): **17 passed / 1 skipped (18 files); 420 passed / 26 skipped
  (446 tests)**, ~5s.
- The DB-backed `integration-security.test.ts` (26 cases) **self-skips** unless
  `TEST_DATABASE_URL` is set; it runs in CI's `security` job as the
  `amisibiz_app` role.
- **No E2E/Playwright present** (the phase plan anticipates Playwright from
  Phase 03; it was never added).
- **CI** (`.github/workflows/ci.yml`): `verify` (format, lint, type-check,
  `test:run`, build, bundle scan, a `sb_secret_` grep guard) and `security`
  (runner-local PostgreSQL 16, clean-room chain, behavioural batteries, the
  26-case harness, three "proofs were real" assertions).

---

## 12. Deployment

- Intended target **Vercel** (`README.md`); no `vercel.json` exists in the tree.
- The two database URLs are configured via Neon (pooled `DATABASE_URL`, direct
  `DIRECT_URL`, optional `APP_DATABASE_URL`).
- RLS enforcement in the deployed app additionally requires the operator
  procedure (`../administration/rls-activation-operator-procedure.md`,
  `RUNBOOK.md`).

---

## 13. Implemented vs. not implemented (summary)

| Area                                              | State                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Native auth (register/login/reset)                | **Implemented** (unit-tested)                                                          |
| Session trust chain + revocation                  | **Implemented**                                                                        |
| Permission catalogue + role matrices              | **Implemented** (code ⇄ DB parity test)                                                |
| Tenant provisioning + lifecycle                   | **Implemented**                                                                        |
| Support access grants                             | **Implemented**                                                                        |
| Contacts / addresses                              | **Implemented**                                                                        |
| Catalogue items + customer pricing                | **Implemented**                                                                        |
| Tax categories / rates                            | **Implemented**                                                                        |
| Documents (quote/invoice/DN), numbering, payments | **Implemented**                                                                        |
| Documents PDF render                              | **Implemented**                                                                        |
| Branding + WCAG contrast                          | **Implemented**                                                                        |
| Audit log + viewer (tenant & platform)            | **Implemented**                                                                        |
| Customer portal                                   | **Implemented**                                                                        |
| Offline sync server (push/pull)                   | **Implemented** (closed op registry)                                                   |
| RLS policies + guard triggers                     | **Implemented in schema/DB**; **not yet effective** at runtime (operator step pending) |
| Email delivery (verify/reset/invite)              | **Not implemented** (documented no-op)                                                 |
| Email verification route                          | **Not implemented** (no route; message strings exist)                                  |
| Invitation delivery                               | **Not implemented** (no transport)                                                     |
| Playwright / E2E                                  | **Not implemented**                                                                    |
| Live eTIMS / payments / POS                       | **Not implemented** (labelled mocks only)                                              |
| Offline/mobile/desktop clients                    | Storage layer tested; shells not built; not wired into web                             |
| File/storage metadata model                       | **Not implemented** (URL fields + policies only)                                       |

---

## 14. Documentation map & known drift

| Doc                                    | Role                                       | Drift to fix                                                                                                                   |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `system-design.md`                     | Phase 00 target design + module boundaries | Stack (Auth.js/Supabase), paths (`lib/db/prisma.ts`), §4 route map                                                             |
| `system-overview.md` (this)            | As-built overview                          | —                                                                                                                              |
| `data-model.md`                        | As-built schema reference                  | —                                                                                                                              |
| `security-model.md`                    | Threat model + enforcement status          | §1–§12 pre-Phase-1 text; §11 mentions retired `AccountToken`/roles                                                             |
| `repository-audit.md`                  | Historical Phase 00 audit                  | Already banner-marked historical                                                                                               |
| `../implementation/phase-checklist.md` | Phase plan (Phases 00–06)                  | Head says HEAD `22f035d`; tree is now at `ddcdec9` (phases 7–11)                                                               |
| `../IMPLEMENTATION_STATUS.md`          | Status dashboard                           | Updated 2026-10-15; behind phases 7–11                                                                                         |
| `README.md`                            | Onboarding                                 | Lists non-existent `/verify-email`; suspension described as blocking reads (now read-preserving); "no remote push" is outdated |
| `schema.prisma:7,930–935`              | Identity comments                          | Say "Supabase Auth (GoTrue)" — now native auth                                                                                 |
| `.github/workflows/ci.yml:36–38,79–88` | CI env/guards                              | Supabase placeholder env + `sb_secret_` guard are legacy                                                                       |
| `apps/web/tests/prisma-mock.ts:251`    | Test mock                                  | Dead `createAdminSupabase` export                                                                                              |

See `../implementation/agent-work-plan.md` for the prioritised remediation of
this drift and the MVP gaps.
