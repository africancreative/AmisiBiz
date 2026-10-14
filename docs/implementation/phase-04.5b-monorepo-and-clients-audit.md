# Phase 04.5b–e — Monorepo, clients & offline: audit and implementation plan

- **Status:** Audit complete (2026-10-14); **04.5b executed on 2026-10-14** as
  the owner-directed “Phase 1 — application foundation” (execution record:
  `phase-01-foundation-report.md`). The delivered layout expands §2.1 per that
  directive: three apps (`web`, `mobile`, `desktop`) and seven shared packages
  (`auth`, `config`, `database`, `domain`, `documents`, `sync`, `ui`). This
  document remains the audit/plan record; §3 and §5–§8 dispositions stand.
- **Scope:** Turborepo monorepo + shared domain package (04.5b), shadcn/ui
  adoption (04.5c), Capacitor/Tauri/SQLite offline design (04.5d), DPO/eTIMS
  interface design (04.5e) — plus the client-platform dependency assessment the
  constitution requires.
- **Method:** direct source inspection of the working tree (2026-10-14),
  installed-package versions read from `node_modules`, registry versions via
  `pnpm view`, build artefacts and test inventory inspected. No database
  connection was opened for this audit. **No secrets appear in this document.**
- **Related:** `phase-checklist.md`, `phase-04.5-constitution-alignment.md`,
  `../architecture/repository-audit.md` (historical, superseded — see §1.7).

---

## 1. Architecture assessment (as it exists today)

### 1.1 Verified stack

| Item            | Verified value                                                                                       | Source                  |
| --------------- | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| App framework   | Next.js **15.5.27** (App Router), middleware on the **nodejs** runtime                               | `node_modules`          |
| UI runtime      | React **19.3.0**                                                                                     | `node_modules`          |
| Language        | TypeScript **5.9.3** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`            | `tsconfig.json`         |
| Styling         | Tailwind CSS **3.4.19** + semantic CSS-variable tokens; `clsx` + `tailwind-merge`                    | `tailwind.config.ts`    |
| i18n            | `next-intl` **3.26.5** (pinned; do not upgrade to v4 without coordinated migration)                  | `package.json`          |
| DB / ORM        | Prisma **6.19.3** + PostgreSQL (Supabase, pooled 6543 runtime / 5432 migrations)                     | `prisma/schema.prisma`  |
| Auth            | **Supabase Auth** via `@supabase/ssr` 0.12.7 + `@supabase/supabase-js` 2.117.3 (04.5a)               | `src/lib/supabase/*`    |
| Validation      | Zod **3.25.76**                                                                                      | `node_modules`          |
| Tests           | Vitest **3.2.7** — 13 files under `tests/`, mocks only; DB-backed suite gated by `TEST_DATABASE_URL` | `vitest.config.ts`      |
| Lint            | ESLint **9.39.5** flat config (`FlatCompat` + `next/core-web-vitals` + `next/typescript`)            | `eslint.config.mjs`     |
| Package manager | **pnpm 11.18.0** (lockfile present; Node **24.18.1**)                                                | `pnpm-lock.yaml`, local |

### 1.2 Workspace reality check (do not assume it is a monorepo)

`pnpm-workspace.yaml` **exists but defines no workspace members** — it currently
contains only an `allowBuilds:` block (pnpm 11 build-script allow-list:
`@prisma/client`, `@prisma/engines`, `esbuild`, `prisma`, `unrs-resolver`).
There is no `packages:` key, no `turbo` dependency (registry latest: **2.11.8**),
and every script runs the single root package (`"name": "amisibiz"`). The
constitution's "Turborepo monorepo" requirement is therefore **not yet met**;
this phase prepares it.

### 1.3 Entry points and module boundaries

- Middleware: `src/middleware.ts` (next-intl + Supabase session refresh + route gating, nodejs runtime).
- API: `src/app/auth/callback/route.ts` (code+OTP links), `src/app/api/health/route.ts`, `src/app/api/branding/logo/route.ts`, `src/app/uploads/tenants/[...path]/route.ts` (authorised logo serving).
- Server Actions: `src/server/actions/*` (auth, tenant, platform, branding, contact, contact-item, item, document).
- Services: `src/server/services/*` (tenant provisioning, documents skeleton).
- Shared lib: `src/lib/*` — permissions, branding contrast, money formatting, tenancy/host (env-reading), validations, audit, security rate-limit, db, supabase.
- UI kit: `src/components/ui/` — **21 hand-rolled components** (button, dialog, table…). No `components.json` → **shadcn/ui not formally adopted** (04.5c).

### 1.4 Database / Supabase

- Seven frozen, applied migrations (`20261013000000_init` …
  `20261017000000_supabase_auth_alignment`); applied files are immutable.
- RLS: policies and helper functions exist (53 `ENABLE ROW LEVEL SECURITY` /
  `CREATE POLICY` statements across 4 migrations) but are **inert** — the app
  connects as the table owner and no `app.current_tenant_id` GUC is set yet
  (activation is Phase 08, documented in the checklist §5/§6).
- The project is **shared with AmisERP** (separate `amisierp*` schemas; our
  tables in `public`). Migration bookkeeping required a P3005 workaround
  (pre-created empty `_prisma_migrations`; never baseline). See §5 risk S1.

### 1.5 Auth

Supabase Auth is live (04.5a): `getSessionUser()` trust chain with the
`sessionVersion` claim check, revocation = DB bump → GoTrue kill → claim sync.
No Auth.js remnants in `src/`; template env vars no longer reference `AUTH_*`.

### 1.6 Missing capability areas (verified absent, not assumed)

- **No CI**: no `.github/` directory at all.
- **No deployment config**: no `vercel.json`, no `.vercel/`, no Dockerfile.
- **No Supabase CLI project dir** (`supabase/config.toml` absent) — migrations are Prisma-only.
- **No mobile / desktop / PDF / offline code**: a case-insensitive grep for
  `capacitor|tauri|sqlite|offline` across source and config matches only
  documentation prose. No PDF or SQLite library is installed.
- **No `.prettierignore`** — empirically unnecessary today: with the installed
  Prettier 3.9.10, `prettier --file-info` reports `.next/**`,
  `*.tsbuildinfo` and `node_modules/**` as **ignored** (they are git-ignored)
  while tracked files are not. Keep `.gitignore` current instead (done for
  `.turbo/` in §9).

### 1.7 Documentation staleness (found, being corrected)

- `../architecture/repository-audit.md` (Phase 00) describes npm, Auth.js,
  "no commits yet" and open risk R1 — all long resolved. A "historical record"
  banner is added by this audit; read `phase-checklist.md` for current state.
- `README.md` instructed contributors to set `AUTH_SECRET` (dead since 04.5a),
  listed Auth.js, and used npm commands while the repo is pnpm. Corrected in §9.

### 1.8 Domain-logic extraction candidates (verified by grep)

| Module                                      | Consumers today        | Notes                                          |
| ------------------------------------------- | ---------------------- | ---------------------------------------------- |
| `src/lib/auth/permissions.ts` (225 lines)   | 28 files / ~32 imports | Pure; only `@prisma/client` **types** imported |
| `src/lib/format/money.ts`                   | 5 components/pages     | Pure decimal-string arithmetic                 |
| `src/lib/branding/contrast.ts`              | 3 files                | Pure WCAG luminance maths                      |
| `DEFAULT_DOCUMENT_SERIES` (in provisioning) | 1 file                 | Default prefixes QUO/INV/DN; numbering seed    |
| `src/lib/tenancy/host.ts`                   | 4 files                | **Stays in web** — reads `process.env`         |
| `src/lib/utils/index.ts`                    | many                   | Stays — `cn` depends on clsx/tailwind-merge    |
| Phase 05 engine (not yet written)           | —                      | Must be authored **in** the domain package     |

---

## 2. Proposed Turborepo workspace layout (adapted to this repository)

Principle: **smallest layout that satisfies the constitution** — one app, one
domain package, no speculative packages. Additional packages appear only when a
second consumer exists.

### 2.1 Target tree (04.5b)

```
amisibiz/                         # repo root (private, tooling only)
  apps/
    web/                          # @amisibiz/web — the existing Next.js app, moved intact
      src/  prisma/  messages/  public/  tests/
      next.config.mjs  postcss.config.mjs  tailwind.config.ts
      tsconfig.json  vitest.config.ts  eslint.config.mjs
      .env  .env.local  .env.example        (git-ignored ×2; template tracked)
      package.json
  packages/
    domain/                       # @amisibiz/domain — pure TS, zero runtime deps
      src/
        index.ts
        permissions.ts            # PERMISSIONS, role matrices, role unions (own declarations)
        format/money.ts
        branding/contrast.ts
        documents/series.ts       # DOCUMENT_TYPES, DocumentType, DEFAULT_DOCUMENT_SERIES
      tsconfig.json  package.json
  turbo.json                      # task graph
  pnpm-workspace.yaml             # += packages: ["apps/*", "packages/*"]
  package.json                    # delegating scripts + turbo/prettier devDeps
  .gitignore  .prettierrc.json  README.md  docs/  .kilo/  .scratch-p05-*.sql
```

Future (design-gated, **not** in 04.5b): `apps/mobile` (Capacitor shell),
`apps/desktop` (Tauri), and only if genuinely shared later, `packages/ui` /
`packages/validation`.

### 2.2 `packages/domain` contract

- **Source-only package**: `"exports": "./src/index.ts"`, `"types": "./src/index.ts"` — no build step; Next.js compiles it via `transpilePackages: ["@amisibiz/domain"]`, Vitest resolves it through the workspace link.
- **Zero runtime dependencies**; no `@prisma/client` import: `TenantRole` /
  `PlatformRole` are re-declared as string-literal unions. Prisma's generated
  enums are the same literal unions, so existing call sites remain
  type-compatible in both directions.
- **No Node/DOM APIs** — pure functions only, so Capacitor (WebView) and Tauri
  clients can import the identical module.
- Own `tsconfig.json` mirroring the strict flags; `type-check` script.

### 2.3 File moves (all via `git mv`; `.env*` by copy-verify-delete, never printed)

`src/`, `prisma/`, `messages/`, `public/`, `tests/`, `next.config.mjs`,
`postcss.config.mjs`, `tailwind.config.ts`, `tsconfig.json`,
`vitest.config.ts`, `eslint.config.mjs`, `.env.example` → `apps/web/`;
`.env` / `.env.local` → `apps/web/` (both git-ignored; staged never). Root
`next-env.d.ts` and `tsconfig.tsbuildinfo` deleted (regenerated);
stale root `.next/` removed.

### 2.4 Root scripts stay the same interface (delegation)

`pnpm dev|build|lint|type-check|test:run|format|db:*` keep working from the
repo root (turbo or `pnpm --filter`). `turbo.json` tasks: `build` (dependsOn
`^build`, outputs `.next/**`), `lint`, `type-check`, `test:run`, `dev`
(`cache:false`, persistent). pnpm `allowBuilds` stays at root and continues to
gate Prisma/esbuild build scripts.

### 2.5 Compatibility checks already reasoned through (no behaviour change)

- `next.config.mjs` i18n plugin path (`./src/lib/i18n/request.ts`) is project-relative → unchanged.
- `process.cwd()` (logo route, `prisma/*` scripts) resolves to `apps/web` → `uploads/` and Prisma `.env` resolution unchanged; `uploads/` stays git-ignored at any depth.
- Vitest aliases/`include` are config-relative → unchanged; the 184-passing suite is the acceptance evidence (identical counts expected).
- ESLint flat config moves to `apps/web` (its `next/*` presets must resolve from there).
- One root `tsconfig.json` → one per workspace (no solution-style root file until a third package exists).
- Turbo pinned `^2.11.8`; `packageManager: pnpm@11.18.0` pinned at root.

### 2.6 Blast radius & risks of the move

| Risk                                  | Mitigation                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Import churn (~28 files, ~32 imports) | Mechanical `@/lib/...` → `@amisibiz/domain`; no logic edits                 |
| Lockfile churn                        | `pnpm install` re-resolves; review diff; no dependency version changes      |
| Prisma client generation              | Still driven by `allowBuilds` at root; verify `db:generate` from `apps/web` |
| Stale build artefacts                 | Delete root `.next/`, `next-env.d.ts`, `tsconfig.tsbuildinfo` before gates  |
| Env file mishandling                  | Copy → checksum-verify → delete original; never staged, never printed       |

Acceptance for 04.5b: format/lint/type-check/tests/build all green with the
same counts as the 04.5a record (184 passed / 13 skipped), plus `pnpm db:seed`
dry-load check (no live writes) and a `next build` from the new layout.
Revert path: the move is one commit; `git revert` restores the single-package
layout.

---

## 3. Dependency & compatibility report — Capacitor, Tauri, SQLite

Registry versions verified 2026-10-14 via `pnpm view`; treat as targets to
re-verify at adoption.

| Layer             | Package / tool                | Current stable | Role                                                                | Compatibility notes                                                                                                                                                                  |
| ----------------- | ----------------------------- | -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Android app shell | `@capacitor/core` (+ CLI)     | **8.5.3**      | Wraps a web build in a native Android app                           | Requires **static assets** (`webDir`) — a Next.js **SSR** app cannot be bundled as-is. Needs Node 20+ (24 ✓), Android Studio/SDK + JDK. Target decision required (§ below).          |
| Android SQLite    | `@capacitor-community/sqlite` | **8.1.1**      | Native SQLite (SQLCipher option, JSON import/export, upgrade hooks) | v8 line tracks Capacitor 8. Maintenance status and the Capawesome SQLite SDK alternative were both flagged in 2026 community posts — **evaluate both in 04.5d**, do not lock in now. |
| Windows shell     | `@tauri-apps/cli`             | **2.12.2**     | Native Windows app (WebView2)                                       | Tauri 2 stable; Rust toolchain required to build; can load a hosted URL or bundled assets; Windows code-signing needed for distribution.                                             |
| Windows SQLite    | `@tauri-apps/plugin-sql`      | **2.5.0**      | SQLite via `sqlx` inside the Rust core                              | First-party plugin; supports embedded migrations from the JS side.                                                                                                                   |
| Client DB (both)  | SQLite (via the above)        | —              | Offline store on device                                             | Never the source of truth: Postgres remains authoritative; both shells render the same `@amisibiz/domain` — which is why 04.5b must land first.                                      |

**The one real compatibility decision (defer to 04.5d, decide before any client
code):** Capacitor cannot bundle the SSR Next.js app. The three viable shapes:

1. **Remote-URL shell** (`server.url` → Vercel): fastest, but online-only and weak on store review — fails the offline requirement on its own.
2. **Static-export client subset** (Next `output: "export"` of a client-only surface): reuses React code but loses server actions/SSR/middleware — effectively a second app.
3. **Dedicated client app** (Vite + React Router or similar) importing `@amisibiz/domain` and calling the hosted API: cleanest offline story, most honest separation; recommended to evaluate as the default in 04.5d.

**Shared constraints from the constitution's offline rules** (design inputs for
04.5d, foundations already present in the schema): client-generated UUIDs
(server currently uses cuid defaults — the cuid-vs-UUID decision was flagged in
the 03.5 audit), server-side idempotency (`Document.idempotencyKey` exists),
tombstones and a sync queue, no device-timestamp-only conflict resolution, no
fabricated payments/activations/sync successes, and a maximum-authorization-
freshness policy tied to `sessionVersion` revocation.

Sources: [Capacitor 8 update guide](https://capacitorjs.com/docs/updating/8-0), [Capacitor support policy](https://capacitorjs.com/docs/main/reference/support-policy), [@capacitor-community/sqlite](https://github.com/capacitor-community/sqlite), [Capawesome SQLite SDK](https://capawesome.io/docs/sdks/capacitor/sqlite/), [Capacitor SQLite alternatives (2026)](https://capgo.app/blog/capacitor-community-sqlite-alternative/), [Tauri plugin-sql](https://v2.tauri.app/plugin/sql/), [tauri-plugin-sql crate](https://crates.io/crates/tauri-plugin-sql/versions).

---

## 4. Phased implementation roadmap

| Phase                            | Deliverable                                                                                                                                                                                                                         | Exit gate                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **04.5b** ✅ executed 2026-10-14 | Restructure to `apps/web` + shared packages (expanded to 7 packages / 3 apps by the owner directive); import rewires; turbo + delegation scripts; env files relocated; CI workflow added.                                           | Same gates, identical counts (184/13 pre-extension, then 201/13 with the new foundation tests); build from new layout; no behaviour diff. |
| **04.5c**                        | shadcn/ui adoption for **new** UI (Phase 05 screens first): `components.json`, CLI pinned, Tailwind 3 compatibility mode; existing kit migrates only when touched — no mass rewrite.                                                | Gates green; first new screens built with shadcn primitives.                                                                              |
| **04.5d**                        | Offline architecture design doc **only**: Capacitor/Tauri shell choice (§3), sync queue, tombstones, client UUIDs, idempotency flow, conflict policy, revocation/authorization-freshness, at-rest encryption, secure token storage. | Owner review; explicit decision record on client shape.                                                                                   |
| **04.5e**                        | DPO Group / eTIMS interface design doc **only** (no simulated live payments, no undocumented DPO assumptions; eTIMS stays a separate system).                                                                                       | Owner review.                                                                                                                             |
| **05** (resume)                  | Calculation engine + lifecycle + numbering **authored in `packages/domain`**; services/actions/PDF (Supabase Storage)/UI/tests in `apps/web`; completion report.                                                                    | Phase 05 acceptance in checklist §4.                                                                                                      |
| **07**                           | Audit viewer + structured logging/observability.                                                                                                                                                                                    | Viewer permission-gated; redaction verified.                                                                                              |
| **08**                           | RLS activation (`amisibiz_app` + per-request `set_config`), distributed rate limiting, email transport, security headers/CSP, coverage thresholds, E2E breadth, `vercel.json`, CI on PRs, backups/DR.                               | Green CI; documented deployment actually executed.                                                                                        |
| **Post-08** (owner-gated)        | Actual Capacitor/Tauri/offline implementation per 04.5d; DPO integration per 04.5e; eTIMS remains separate.                                                                                                                         | Per-phase gates once scoped.                                                                                                              |

---

## 5. Security risks & missing foundations (current, evidence-based)

| ID  | Sev | Finding                                                                                                                                                                                                                                                                                    | Evidence / disposition                                                                                  |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| S1  | M   | Supabase project **shared with AmisERP** — one project compromise or key leak spans both applications; migration bookkeeping is operationally coupled.                                                                                                                                     | Recommend a dedicated production project before launch (owner decision; migration chain is replayable). |
| S2  | M   | RLS **defined but inert**: app connects as table owner; `app.current_tenant_id` never set. Application-layer authz is the only control in force.                                                                                                                                           | Documented; activation (least-privileged role + per-request GUC) is Phase 08.                           |
| S3  | M   | Logos on the **server filesystem** — will not survive a stateless/serverless deploy (Vercel).                                                                                                                                                                                              | Owner excluded branding from 04.5 alignment; move to Supabase Storage scheduled with Phase 05/08.       |
| S4  | M   | ~~**No CI**~~ **Partially resolved (2026-10-14):** `.github/workflows/ci.yml` added (format/lint/type/tests/build + secret guard); rehearsed green from a pristine copy. First remote run pending the next push; migration-drift job stays Phase 08.                                       | Pulled forward with the foundation; see `phase-00-repository-audit.md` §8.                              |
| S5  | M   | **Rate limiting** falls back to in-memory unless `REDIS_URL` or Upstash is configured (code supports both, env not set).                                                                                                                                                                   | Distributed limiter is Phase 08.                                                                        |
| S6  | M   | **Email transport absent** — verification and password-reset messages are not delivered; `REQUIRE_EMAIL_VERIFICATION` stays off (documented limitation).                                                                                                                                   | Supabase default SMTP has strict limits; provider decision + transport in Phase 08.                     |
| S7  | L   | No HTTP **security headers / CSP** (no `vercel.json`; no `headers()` in `next.config.mjs`).                                                                                                                                                                                                | Phase 08 with deployment config.                                                                        |
| S8  | L   | ~~`AUTH_*` remnants: README instructed setting `AUTH_SECRET`~~ **Resolved (2026-10-14):** README rewritten for the monorepo; template env vars clean since 04.5a. Remaining owner action: remove dead values from the local `.env` (tooling never touches it — secrets are never printed). | Closed in the foundation; see `phase-00-repository-audit.md` §12.                                       |
| S9  | L   | `next.config.mjs` still allows images from wildcard `*.supabase.co` (pre-existing R12).                                                                                                                                                                                                    | Tighten to the project host when Storage lands (Phase 05).                                              |
| S10 | L   | Offline client identity: server IDs are **cuid** defaults — conflicts with client-generated **UUID** capture.                                                                                                                                                                              | Decision required in 04.5d (flagged since the 03.5 audit).                                              |

Missing foundations (tracked, not reinvented here): shared domain package
(04.5b, this plan), offline design (04.5d), deployment + CI + observability
(07/08), integration-test database automation (08 + CI proposal §7).

---

## 6. Environment variables & external accounts required

Names only — no values appear anywhere in this document or the repo's tracked
files (`.env.example` holds placeholders).

| Variable (current set)                                             | Needed where                | Notes                                             |
| ------------------------------------------------------------------ | --------------------------- | ------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_NAME`                      | local / Vercel              | public metadata/links                             |
| `DATABASE_URL` (pooled 6543), `DIRECT_URL` (5432)                  | local / Vercel / migrations | Prisma runtime vs migrations                      |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | local / Vercel              | browser-safe                                      |
| `SUPABASE_SECRET_KEY`                                              | local / Vercel              | **server-only** — never client/logs/errors        |
| `APP_BASE_DOMAIN`, `NEXT_PUBLIC_APP_BASE_DOMAIN`, `TRUST_PROXY`    | Vercel (routing)            | tenant hostname routing                           |
| `SEED_PLATFORM_ADMIN_*`, `ALLOW_PROD_SEED`                         | bootstrap only              | seed no-ops unless set; min-12 password enforced  |
| `REQUIRE_EMAIL_VERIFICATION`                                       | Vercel (later)              | stays off until email delivery is verified        |
| `EMAIL_PROVIDER`, `SMTP_*`, `EMAIL_FROM`                           | Phase 08                    | transport not implemented yet                     |
| `REDIS_URL` **or** `UPSTASH_REDIS_REST_URL/TOKEN`                  | Phase 08                    | optional today; enables distributed rate limiting |
| `TEST_DATABASE_URL`                                                | dev machine / CI            | disposable DB only — **never** the shared project |

External accounts / owner actions: Supabase (live — dedicated production
project recommended, §5 S1), **Vercel account + project** (not yet created),
GitHub (repo live), **domain + wildcard DNS** for tenant hostnames
(`APP_BASE_DOMAIN` appears unset/commented in the template — owner choice),
SMTP provider (Phase 08), Google Play Console (future Android release),
Windows code-signing certificate (future Tauri release), DPO Group merchant
account (design-gated, 04.5e), KRA/eTIMS remains a separate system.

---

## 7. Testing & deployment strategy

**Testing.** 04.5b keeps one Vitest suite (moved with the app) as the
regression harness — identical 184/13 result is the acceptance criterion. From
Phase 05 the domain package gets its own Vitest config and pure-logic tests
(money/maths already exist; engine tests join them), aggregated by
`turbo run test:run`. DB-backed integration tests remain gated by
`TEST_DATABASE_URL` against the throwaway cluster — never the shared project.
Proposed CI (Phase 08, pull-forward optional): GitHub Actions with
`pnpm install --frozen-lockfile` → `turbo run lint type-check test:run build`
(cached via `.turbo/`), plus a migration-drift job on a Postgres service
container (`migrate deploy` then `prisma migrate diff` must print an empty
migration) — the procedure already documented in the 03.5 audit §5/§10.
Playwright E2E (overdue from the Phase 03 target) and coverage thresholds land
with 07/08.

**Deployment.** Target: Vercel. Recommended monorepo wiring once turbo lands:
project Root Directory = repo root, install `pnpm install`, build
`turbo run build --filter=@amisibiz/web` (Vercel also auto-detects pnpm
workspaces; verify at 04.5b and record). Migrations are **never** run in the
build: `pnpm db:migrate:deploy` from the root is a deliberate release step
against the session-mode URL. Env vars set per environment in Vercel
(secret key strictly server-side). Supabase dashboard Site URL / redirect
allow-list must be configured per origin (local, preview, production) before
email links are trusted. Staging: none today — recommend a second Supabase
project + Vercel preview policy before production registration is enabled
(Phase 08).

---

## 8. Constitution requirement → implementation phase

| #   | Constitution requirement                                                                               | Current state                                                                                                                                                   | Phase / disposition                                         |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Next.js App Router + strict TypeScript                                                                 | In place (15.5.27 / TS strict)                                                                                                                                  | — done                                                      |
| 2   | Supabase Auth                                                                                          | Live (04.5a)                                                                                                                                                    | — done                                                      |
| 3   | Supabase PostgreSQL                                                                                    | Live, 7 frozen migrations                                                                                                                                       | — done                                                      |
| 4   | Row-Level Security (restrictive)                                                                       | Policies present, **inert** (owner connection)                                                                                                                  | 08 (activation)                                             |
| 5   | Supabase Storage                                                                                       | Not adopted (logos filesystem — owner carve-out; documents planned)                                                                                             | 05 (documents; Supabase Storage), branding exception stands |
| 6   | Vercel deployment                                                                                      | Not configured                                                                                                                                                  | 08                                                          |
| 7   | Turborepo monorepo                                                                                     | Not yet (workspace file present, no members)                                                                                                                    | **04.5b (this plan)**                                       |
| 8   | Tailwind CSS                                                                                           | In place (semantic tokens)                                                                                                                                      | — done                                                      |
| 9   | shadcn/ui                                                                                              | Hand-rolled kit; not adopted                                                                                                                                    | 04.5c                                                       |
| 10  | Zod validation                                                                                         | In place                                                                                                                                                        | — done                                                      |
| 11  | Capacitor (Android)                                                                                    | Absent                                                                                                                                                          | 04.5d design → implementation post-08 (owner-gated)         |
| 12  | Tauri (Windows)                                                                                        | Absent                                                                                                                                                          | 04.5d design → implementation post-08 (owner-gated)         |
| 13  | SQLite offline                                                                                         | Absent                                                                                                                                                          | 04.5d design → implementation post-08                       |
| 14  | Shared TypeScript domain layer                                                                         | Logic embedded in `src/`                                                                                                                                        | **04.5b** + Phase 05 (engine authored in domain)            |
| 15  | Tenant administration only by provider admins                                                          | Delivered (Phase 03), permission-gated                                                                                                                          | — done                                                      |
| 16  | Per-tenant branding must not alter issued documents                                                    | Branding shipped (Phase 04); document snapshots/immutability enforced in Phase 05 schema                                                                        | 05 completion                                               |
| 17  | Server-side authorization; tenant-scoped; never trust client-supplied tenant/role/price/total/status   | In force (`authorizeTenant`/`authorizePlatform` pattern, tests)                                                                                                 | ongoing + RLS in 08                                         |
| 18  | Never expose service-role/secret credentials to browser/mobile bundles                                 | Verified pattern (server-only factories; no `NEXT_PUBLIC_` secret)                                                                                              | ongoing                                                     |
| 19  | Document integrity: unique tenant-scoped numbers, immutable snapshots, controlled voiding, audit trail | Schema + SQL functions in place; engine pending                                                                                                                 | 05                                                          |
| 20  | Commercial PDFs never presented as KRA/eTIMS tax invoices                                              | Not built yet                                                                                                                                                   | 05 acceptance                                               |
| 21  | Offline rules: client UUIDs, idempotency, no timestamp-only conflicts, no fabricated sync success      | `idempotencyKey` exists; policy unwritten                                                                                                                       | 04.5d (design) → implementation post-08                     |
| 22  | DPO Group — design only                                                                                | Absent                                                                                                                                                          | 04.5e                                                       |
| 23  | eTIMS — separate integration                                                                           | Absent                                                                                                                                                          | 04.5e (note only; separate system)                          |
| 24  | Delivery discipline (plan → implement → gates → env docs → checklist → report)                         | In force                                                                                                                                                        | ongoing                                                     |
| 25  | 16 required modules                                                                                    | Delivered: auth/RBAC (02), tenant lifecycle/admin (03), branding/contacts/catalogue (04), documents schema (05 in progress); remainder per `phase-checklist.md` | module-by-module, no module marked complete before its gate |

---

## 9. Low-risk preparation applied with this audit

Deliberately non-structural; **no commits created**:

1. `README.md` corrected (Supabase Auth stack, pnpm commands, current env vars — `AUTH_SECRET` removed).
2. `../architecture/repository-audit.md` — "historical record" banner (it describes the pre-Phase-02 state).
3. `.gitignore` — `.turbo/` added (prep for 04.5b caching).
4. `package.json` — `"packageManager": "pnpm@11.18.0"` pinned.
5. `phase-checklist.md` §6 updated to point at this audit and the approval gate.

Explicitly **not** done (awaiting approval): any file move, `pnpm-workspace.yaml`
`packages:` list, `turbo` dependency, `transpilePackages`, import updates,
dependency changes, commits, destructive operations.

---

## 10. Decision requested

1. ~~**Approve 04.5b execution** as specified in §2~~ — **approved and executed**
   2026-10-14 as the owner-directed Phase 1 application foundation (layout
   expanded to 7 packages / 3 apps; record in `phase-01-foundation-report.md`).
2. Note the §3 deferred decision (client shape for Capacitor) for 04.5d —
   **still open; the mobile/desktop scaffolds intentionally pin no client
   architecture** beyond the shells themselves.
3. CI pulled forward into the foundation phase: a format/lint/type-check/test/
   build workflow now exists at `.github/workflows/ci.yml` (first remote run
   pending the next push; the migration-drift job remains Phase 08).
