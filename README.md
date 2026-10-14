# AmisiBiz

Multi-tenant business document and mini-CRM platform by **Amisi Genuine Enterprises**.

Product branding: Amisi blue + gold. Each business can apply its own branding
(colours/logo) to the documents it issues — see
[`docs/architecture/design-system.md`](docs/architecture/design-system.md).

## Repository layout (Turborepo + pnpm workspaces)

```
apps/
  web/        @amisibiz/web      Next.js 15 App Router app (Vercel) — the product
  mobile/     @amisibiz/mobile   Capacitor Android shell (scaffold — see its README)
  desktop/    @amisibiz/desktop  Tauri 2 Windows shell (scaffold — see its README)
packages/
  auth/       @amisibiz/auth      roles, permission matrix, session contracts
  config/     @amisibiz/config    shared tsconfig bases + ESLint flat config
  database/   @amisibiz/database  Prisma singleton, Supabase admin client, env guards
  domain/     @amisibiz/domain    pure validation/contrast logic (client-safe)
  documents/  @amisibiz/documents money formatting, series, PDF contracts
  sync/       @amisibiz/sync      offline operation/conflict contracts (design-only)
  ui/         @amisibiz/ui        shared UI kit components
```

Shared packages are **source-only** (no build step): they export TypeScript
directly and `apps/web` compiles them via `transpilePackages`. All packages are
runtime-neutral (no Node/DOM/server-only APIs) unless documented otherwise, so
the future Capacitor/Tauri clients can import the same code.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript** (strict, shared config in `@amisibiz/config`)
- **Tailwind CSS** with a semantic design-token layer
- **Supabase Auth** (`@supabase/ssr`) — GoTrue sessions with a server-side
  freshness check (`User.sessionVersion` vs. the access-token claim)
- **Prisma 6** + PostgreSQL (Supabase)
- **Zod** validation, **Vitest** tests
- **next-intl** — English (`/en`), French (`/fr`), Swahili (`/sw`)
- **Turborepo** task graph; **pnpm** workspaces

## Prerequisites

- Node.js 20+ (developed on Node 24; CI uses Node 24)
- pnpm 11+ (pinned via `packageManager` in the root `package.json`; `corepack enable` or a standalone install)
- A PostgreSQL database (Supabase or local)
- Optional, for the client shells: JDK 17 + Android SDK (mobile — see [`apps/mobile/README.md`](apps/mobile/README.md)); Rust toolchain + MSVC Build Tools (desktop — see [`apps/desktop/README.md`](apps/desktop/README.md))

## Setup

1. **Install dependencies**

   ```bash
   pnpm install
   ```

   `@prisma/client` is generated automatically by the `apps/web` `postinstall`.

2. **Configure environment**

   Copy `apps/web/.env.example` to `apps/web/.env` and fill in the values
   (Next.js, the Prisma CLI and the seed all load `apps/web/.env`;
   `apps/web/.env.local` is an optional Next.js-only override):

   ```bash
   cp apps/web/.env.example apps/web/.env
   ```

   At minimum set `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`
   (Supabase → Project Settings → API; the secret key is server-only and must
   never reach the client bundle, logs or error messages). Never commit
   `.env.local`.

   Tenant workspaces are served from `<slug>.<APP_BASE_DOMAIN>`; set
   `APP_BASE_DOMAIN` (and `NEXT_PUBLIC_APP_BASE_DOMAIN`) for hostname routing.
   Only set `TRUST_PROXY=true` behind a known reverse proxy — `X-Forwarded-Host`
   is otherwise ignored.

3. **Apply migrations** (the database is the source of truth; migrations are
   frozen once applied)

   ```bash
   pnpm db:migrate        # local authoring (prisma migrate dev)
   pnpm db:migrate:deploy # apply to a deployed database
   ```

4. **Seed a platform administrator (optional)**

   Set `SEED_PLATFORM_ADMIN_EMAIL` / `SEED_PLATFORM_ADMIN_PASSWORD` in
   `apps/web/.env`, then:

   ```bash
   pnpm db:seed
   ```

5. **Run the app**

   ```bash
   pnpm dev
   ```

   Open http://localhost:3000 — you are redirected to your locale (default `/en`).

## Workspace commands (run from the repository root)

| Script                   | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `pnpm dev`               | Start the web dev server                   |
| `pnpm build`             | Build all workspaces (Turborepo)           |
| `pnpm lint`              | ESLint across all workspaces               |
| `pnpm type-check`        | `tsc --noEmit` across all workspaces       |
| `pnpm test`              | Vitest watch mode (web)                    |
| `pnpm test:run`          | Vitest once, for CI                        |
| `pnpm format`            | Prettier write                             |
| `pnpm format:check`      | Prettier check (used by CI)                |
| `pnpm db:generate`       | Regenerate the Prisma client               |
| `pnpm db:migrate`        | Prisma migrate (dev)                       |
| `pnpm db:migrate:deploy` | Prisma migrate deploy (staging/production) |
| `pnpm db:seed`           | Seed platform admin                        |

Per-workspace scripts, e.g. `pnpm --filter @amisibiz/web dev`, `--filter @amisibiz/mobile lint`.
`pnpm turbo run lint type-check test:run build` runs every gate in dependency order.

## Automated checks

CI (`.github/workflows/ci.yml`) runs on every push to `main` and on pull
requests: `pnpm install --frozen-lockfile` → `pnpm format:check` →
`pnpm turbo run lint type-check test:run build` → a guard that greps the build
output for the `sb_secret_` pattern. CI uses placeholder environment values
only; database-backed integration tests are skipped unless `TEST_DATABASE_URL`
points at a disposable database (**never** the shared Supabase project).

## Routes

All routes are locale-prefixed (`/en/...`, `/fr/...`, `/sw/...`) by the
`next-intl` middleware.

| Route                    | Area                    | Access                            |
| ------------------------ | ----------------------- | --------------------------------- |
| `/login`, `/register`    | Authentication          | Public (redirects if signed in)   |
| `/forgot-password`       | Authentication          | Public                            |
| `/reset-password`        | Authentication          | Public (requires token)           |
| `/verify-email`          | Authentication          | Public (requires token)           |
| `/app`                   | Business workspace      | Authenticated + tenant membership |
| `/app/contacts`          | CRM (foundation)        | Authenticated + tenant membership |
| `/app/items`             | Catalogue (foundation)  | Authenticated + tenant membership |
| `/app/documents`         | Documents (foundation)  | Authenticated + tenant membership |
| `/app/settings/branding` | Tenant branding         | Authenticated + tenant membership |
| `/admin`                 | Platform administration | Platform admin permission         |
| `/admin/tenants`         | Platform administration | Platform admin permission         |
| `/admin/tenants/new`     | Provision a tenant      | Platform admin (`tenants.create`) |
| `/admin/tenants/[id]`    | Tenant lifecycle        | Platform admin permission         |
| `/api/health`            | Health check            | Public (no secrets exposed)       |

Protected routes render controlled access states until their module is
implemented in a later phase. Authentication and platform authorization are
real (server-side) — there is no fake auth.

## Tenant lifecycle

New tenants are provisioned **`PENDING`** and become usable only after a platform
administrator **activates** them. Suspension (`ACTIVE → SUSPENDED`) requires a
reason, **blocks all workspace access (read and write)**, and **preserves all
data**; reactivation restores access. Every transition is atomic (status-guarded)
and append-only audited. See
[`docs/architecture/security-model.md`](docs/architecture/security-model.md) §4.1.

## Client shells (Android / Windows)

`apps/mobile` (Capacitor) and `apps/desktop` (Tauri 2) are **configured
scaffolds**, not built apps: neither has been compiled in this environment, and
no build success is claimed. Each README documents its technical feasibility
check, build prerequisites and roadmap. The offline client architecture
(SQLite, sync queue, conflict rules) is designed in the 04.5d phase before any
of it is implemented.

## Security rules (apply to all work)

- `SUPABASE_SECRET_KEY` (`sb_secret_*`) and other privileged credentials must
  **never** appear in browser/mobile/desktop bundles, logs or error messages.
- All authorization is server-side; never trust client-supplied tenant IDs,
  roles, prices, totals or statuses.
- Commercial documents are never presented as KRA/eTIMS tax invoices (eTIMS
  remains a separate system).
- Never seed production databases with default credentials.

## Web app structure (`apps/web/src`)

```
app/[locale]/        routes (locale-aware)
components/ui/       reusable UI kit (button, form fields, table, dialog…)
components/layout/   shared shells: auth, workspace, admin
components/branding/ tenant theming wrapper
lib/auth/            session trust chain, redirects
lib/tenancy/         hostname / slug utilities
lib/validation/      shared Zod utilities
lib/errors.ts        typed ActionResult / error conventions
server/auth/         server-side authorization service
server/services/     provisioning and other domain services
server/actions/      Server Actions
```

## Documentation

- [`docs/implementation/phase-checklist.md`](docs/implementation/phase-checklist.md) — current phase plan and status
- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) — status dashboard (what is implemented, what is proven)
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operations: environment variables, the two database connections, RLS activation, verification probes, migration rules, incident response
- [`docs/implementation/phase-01-foundation-report.md`](docs/implementation/phase-01-foundation-report.md) — application-foundation completion report (monorepo, packages, shells, CI)
- [`docs/implementation/phase-01-authorization-report.md`](docs/implementation/phase-01-authorization-report.md) — Phase 1 directive report (RBAC catalog, RLS, scoped context) and what is still unproven
- [`docs/implementation/phase-04.5b-monorepo-and-clients-audit.md`](docs/implementation/phase-04.5b-monorepo-and-clients-audit.md) — monorepo/client-platform audit and plan
- [`docs/architecture/`](docs/architecture/) — system design, security model, permission matrix
