# AmisiBiz — Repository Audit (Phase 00)

> **Historical record (Phase 00, 2026-10-12).** This audit describes the
> repository _before_ Phases 01–04.5a landed; its stack entries (npm, Auth.js),
> git status ("no commits yet") and risk table are superseded. For current
> state read `../implementation/phase-checklist.md`, the phase reports, and
> `../implementation/phase-04.5b-monorepo-and-clients-audit.md`.

- **Status:** Audit complete
- **Branch:** `main` — **no commits yet**; the entire tree is untracked (working tree only).
- **Auditor role:** Principal Engineer
- **Method:** Direct source inspection, `package.json`/lockfile inspection, `git status`, build/test/type-check execution.
- **Scope:** Describe the repository _as it exists now_, identify material risks, and propose module boundaries, migration/testing strategy and a phased plan. No product features are implemented in this phase.

> Note on ordering: a foundation (auth/tenant/RBAC) scaffold already exists in the working tree and was brought to a green build in the preceding session. This audit describes that state honestly and does not claim database or deployment verification that did not occur.

---

## 1. Inventory

### 1.1 Framework & language

| Item                 | Value                                                                                      | Evidence                                           |
| -------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Framework            | Next.js **15.5.27** (App Router)                                                           | `package.json`, build output                       |
| UI runtime           | React **19.x**                                                                             | `package.json`                                     |
| Language             | TypeScript **5.8.x**, `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` | `tsconfig.json`                                    |
| Styling              | Tailwind CSS 3.4 + `tailwind-merge`/`clsx`                                                 | `tailwind.config.ts`, `src/lib/utils/index.ts`     |
| Internationalisation | `next-intl` **3.26.5** (en/fr/sw)                                                          | `src/lib/i18n/*`, `messages/**`, `next.config.mjs` |
| Auth                 | Auth.js / **next-auth v5 beta** (Credentials + JWT)                                        | `src/lib/auth/config.ts`                           |
| ORM/DB               | Prisma **6.19.3** → PostgreSQL (Supabase-oriented)                                         | `prisma/schema.prisma`, `.env.example`             |
| Validation           | Zod 3.24                                                                                   | `src/lib/validations/*`                            |

### 1.2 Package manager

- **npm** (npm 11.16, Node 24.18 observed).
- `package-lock.json` present (created by `npm install` in the prior session); no pnpm/yarn.
- Install scripts (Prisma postinstall/esbuild) are gated by the local npm "allow-scripts" policy; Prisma Client was generated explicitly via `prisma generate`.

### 1.3 Directory structure

```
src/
  app/                       # App Router
    layout.tsx               # root <html>/<body>, metadata, fonts
    page.tsx                 # "/" → redirect "/en"
    api/auth/[...nextauth]/  # Auth.js route handler
    api/health/              # DB-ping health endpoint
    [locale]/                # locale-scoped segment (en|fr|sw)
      layout.tsx             # NextIntlClientProvider + message loading
      page.tsx               # locale root → dashboard|login
      login|register|dashboard|team/page.tsx
  components/                # auth/*, team/*
  lib/
    auth/ (config.ts, helpers.ts)
    db/ (prisma.ts)
    i18n/ (request.ts, routing.ts)
    utils/ (cn, slugify, formatDate, maskEmail, getInitials, safeJsonParse)
    validations/ (auth.ts, tenant.ts)
  server/actions/ (auth.ts, tenant.ts)   # "use server" functions
  styles/globals.css
  types/next-auth.d.ts
  middleware.ts              # next-intl + Auth.js route guard
prisma/
  schema.prisma
  migrations/20261013000000_init/migration.sql + migration_lock.toml
  seed.ts
tests/ (setup.ts, security.test.ts)
messages/{en,fr,sw}/index.json
```

### 1.4 Application entry points

- **HTTP middleware:** `src/middleware.ts` — composes `next-intl` middleware with the Auth.js `auth()` wrapper; performs route-level auth gating; `runtime: "nodejs"`.
- **Root layout:** `src/app/layout.tsx`.
- **Locale layout:** `src/app/[locale]/layout.tsx`.
- **Auth API:** `src/app/api/auth/[...nextauth]/route.ts` → `handlers`.
- **Health API:** `src/app/api/health/route.ts` → `SELECT 1` ping.
- **Server Actions:** `src/server/actions/auth.ts`, `src/server/actions/tenant.ts`.
- **DB client singleton:** `src/lib/db/prisma.ts`.

### 1.5 Database setup

- Prisma schema with models: `Tenant`, `User`, `Account`, `Session`, `VerificationToken`, `TenantMember`, `Invitation`, `AuditLog`; enums `TenantStatus`, `UserStatus`, `SystemRole`, `TenantRole`, `InvitationStatus`.
- Datasource uses pooled `DATABASE_URL` + `directUrl = DIRECT_URL` (Supabase pattern).
- **One migration authored offline** (`prisma migrate diff`) — **not applied** to any database. No live DB connection has been tested.
- `prisma/seed.ts` — env-gated; creates a `SUPER_ADMIN` only from `SEED_SUPERADMIN_*`; refuses production unless `ALLOW_PROD_SEED=true`.

### 1.6 Authentication implementation

- Auth.js v5 Credentials provider; bcryptjs cost 12; account-status check before password compare.
- Session strategy **JWT**; Prisma adapter configured for OAuth/account persistence.
- `jwt` callback stamps `userId`, `systemRole`, `status`; `session` callback **re-reads the DB on every session read** to invalidate suspended/deleted users and refresh roles.
- `signIn`/`signOut` events write `AuditLog` rows.
- Typed via `src/types/next-auth.d.ts`.
- **OAuth providers are documented in `.env.example` only — not wired into the provider array.**

### 1.7 UI components

- Reusable: `LoginForm`, `RegisterForm`, `SignOutButton`, `InviteMemberForm`, `MemberRowActions`; CSS component classes in `src/styles/globals.css` (`.btn`, `.input`, `.card`, etc.).
- Pages: login, register, dashboard, team; locale root redirect.

### 1.8 Testing framework

- **Vitest 3.x** with `node` environment and `@` alias; `tests/setup.ts` injects placeholder env; `tests/security.test.ts` (20 tests) mocks Prisma + Auth.js.
- No integration, contract, or E2E tests. No coverage thresholds enforced.

### 1.9 Deployment configuration

- **None present.** No `vercel.json`, Dockerfile, CI workflow, or IaC. `.gitignore` covers `.env*`, `.next/`, `node_modules/`.
- Intended target (per env template) is **Vercel + Supabase**, but this is an assumption, not a verified deployment.

---

## 2. Reusable components & partially implemented features

| Area                                                                 | State                                         | Evidence                                               |
| -------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Credentials auth                                                     | Implemented                                   | `src/lib/auth/config.ts`                               |
| Registration (user+tenant+owner)                                     | Implemented                                   | `registerAction`                                       |
| RBAC helper (`requireTenantAccess`, `hasMinimumRole`)                | Implemented                                   | `src/lib/auth/helpers.ts`                              |
| Team management (invite/role/remove/accept)                          | Server actions implemented                    | `src/server/actions/tenant.ts`                         |
| Forgot password                                                      | **No-op stub**                                | `forgotPasswordAction` (returns success, TODO Phase 2) |
| Password reset                                                       | Schema exists; no token flow                  | `resetPasswordSchema` unused                           |
| Invitation acceptance                                                | Action exists; **no route/UI**                | `acceptInvitationAction`                               |
| Tenant settings update                                               | Action exists; **no UI**                      | `updateTenantAction`                                   |
| Active-tenant switching                                              | **Not implemented**                           | heuristic `getPrimaryMembership`                       |
| Platform admin (SUPER_ADMIN/SUPPORT)                                 | Schema only                                   | `SystemRole`                                           |
| Business settings / contacts / catalogue / documents / PDF / reports | **Not started**                               | only i18n nav strings + middleware patterns            |
| Audit log                                                            | Written by auth/tenant actions; **no viewer** | `AuditLog`                                             |
| OAuth                                                                | Env placeholders only                         | `.env.example`                                         |

---

## 3. Risks (evidence-based)

Severity: **H**igh / **M**edium / **L**ow.

| ID  | Sev | Risk                                                                                                                                               | Evidence                                           | Mitigation                                                              |
| --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| R1  | H   | Middleware auth bypass via dotted paths — any path containing `.` returns `NextResponse.next()` **before** protection (e.g. `/en/dashboard.json`). | `src/middleware.ts` `pathname.includes(".")` guard | Replace with an allow-list of static extensions; keep protection first. |
| R2  | H   | No version control history (zero commits); all work is untracked/unreviewable and unrecoverable.                                                   | `git status` / `git log`                           | Commit the baseline; protect `main`.                                    |
| R3  | M   | No rate limiting on login/register/forgot-password → credential stuffing / enumeration-latency attacks.                                            | `src/server/actions/auth.ts`, Auth config          | Add per-IP/email throttling (Phase 01/07).                              |
| R4  | M   | No email verification; `emailVerified` unused → anyone can register an address they don't own.                                                     | `registerAction`, schema                           | Verification flow (Phase 01/02).                                        |
| R5  | M   | `isDefault` on `TenantMember` not enforced unique → multiple/absent defaults; no true tenant context.                                              | `prisma/schema.prisma`, `getPrimaryMembership`     | Explicit active-tenant selection + partial unique index.                |
| R6  | M   | Session callback hits the DB on **every** request (incl. middleware) → availability coupling; middleware forced to Node runtime.                   | `src/lib/auth/config.ts`                           | Cache with short TTL / version stamp; document runtime requirement.     |
| R7  | M   | No integration tests for tenant isolation against a real database; isolation proven only against mocked Prisma.                                    | `tests/security.test.ts`                           | DB-backed isolation tests (see testing strategy).                       |
| R8  | M   | Invitation tokens stored in plaintext; audit `metadata` stores invitee email (PII).                                                                | `inviteMemberAction`, `AuditLog.metadata`          | Hash tokens at rest; minimize/partition audit PII.                      |
| R9  | L   | `console.error(err)` may log DB/driver details; server-side only but unbounded.                                                                    | server actions                                     | Structured logger with redaction.                                       |
| R10 | L   | Hardcoded business assumptions: 14-day trial, 7-day invitation expiry, USD/UTC/en defaults, fixed role hierarchy.                                  | `registerAction`, `inviteMemberAction`, schema     | Move to tenant/platform configuration.                                  |
| R11 | L   | Members of any role can list pending invitation emails.                                                                                            | `src/app/[locale]/team/page.tsx`                   | Confirm intended visibility; restrict to ADMIN+.                        |
| R12 | L   | `*.supabase.co` wildcard remote image pattern.                                                                                                     | `next.config.mjs`                                  | Tighten to the project ref when known.                                  |

### 3.1 Positive controls already present

- Every tenant server action calls `requireTenantAccess` with explicit roles; tenant id from the client is re-verified server-side.
- Privilege-escalation guard (cannot invite/assign a role ≥ your own), peer/superior management guard, last-OWNER protection, self-modification blocked.
- Zod validation on all action inputs; emails trimmed/normalised before validation.
- Passwords bcrypt-hashed (cost 12); status checked before compare.
- No secrets in client bundles; service-role/SMTP keys are server-only (no `NEXT_PUBLIC_` prefix).
- Protected routes confirmed **not** prerendered (`prerender-manifest.json` contains only `/` and `/_not-found`).

### 3.2 Hardcoded business assumptions

Trial length, invitation TTL, default currency/timezone/locale, role ordering, and the `next.config` image host. These are acceptable for a foundation but must become configuration before multi-country rollout.

---

## 4. Compatibility-sensitive changes (do not break)

| Change                                                                      | Compatibility impact                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `next-intl` pinned to `3.26.5` (3.27.0 unavailable on registry)             | Upgrading to v4 is a **breaking** API change; coordinate.                           |
| `experimental.typedRoutes` disabled                                         | Re-enabling breaks locale-prefixed dynamic hrefs without casts.                     |
| Middleware `runtime: "nodejs"`                                              | Requires Next ≥ 15.5 (installed). Downgrading Next breaks Prisma-in-middleware.     |
| `exactOptionalPropertyTypes: true`                                          | Prisma calls must not pass `undefined` optionals; new code must strip undefined.    |
| `TenantMember.isDefault` semantics / `@@unique([tenantId,userId])`          | Changing uniqueness or default semantics requires a data migration.                 |
| `AuditLog.action` string values (`auth.signIn`, `tenant.updated`, `team.*`) | Treat as a stable contract; renaming breaks historical queries.                     |
| Prisma migration history                                                    | `20261013000000_init` must be the applied baseline; never `db push` to a shared DB. |
| `registerSchema`/login email normalisation order                            | Changing order can re-open the padded-email bug fixed in Phase 01.                  |

---

## 5. Assumptions & unknowns

- Deployment target is assumed **Vercel + Supabase** (from env templates); **not verified**.
- No live database, so migrations, seeding and DB-backed behaviour are **unverified**.
- OAuth, email, storage and PDF providers are **unselected**.
- The `SUPPORT` system role has no defined capabilities yet.

---

## 6. Phase 00 conclusion

The repository is a coherent but **uncommitted, unverified** foundation: strong auth/RBAC primitives and a green local build/test/type-check, but no VCS history, no deployment config, no live-DB verification, no integration/E2E tests, and one real middleware auth-bypass hazard (R1). Module boundaries and a phased plan are defined in `system-design.md` and `phase-checklist.md`. **Proceed to Phase 01 only after committing the baseline and fixing R1.**
