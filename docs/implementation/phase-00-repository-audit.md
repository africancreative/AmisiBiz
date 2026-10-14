# AmisiBiz — Phase 0: Repository Audit

- **Status:** Complete (2026-10-14). Findings reported; **no Phase 1 work started**.
- **Directive:** the owner's "AMISIBIZ — PHASE 0: REPOSITORY AUDIT" pack (approved
  stack, product requirements, 8 inspection areas, 7 deliverables). Constraints
  honored: no destructive migrations, no dependency replacement, no production
  deploy, no automatic commits; existing work preserved.
- **Method:** direct inspection of the working tree on 2026-10-14 (git state,
  configs, middleware, migrations, source, tests, build artefacts) plus a
  **pristine-copy rehearsal** of the CI sequence (fresh copy without
  `node_modules`/`.env`). No database connection was opened for this audit.
  **No secrets appear in this document.**
- **Related canonical docs:** `phase-checklist.md` (phase plan/status),
  `../IMPLEMENTATION_STATUS.md` (status dashboard), `phase-01-foundation-report.md`
  (foundation execution record), `phase-04.5b-monorepo-and-clients-audit.md`
  (monorepo/client audit + risk register S1–S10), `../architecture/system-design.md`,
  `../architecture/security-model.md`, `../architecture/permission-matrix.md`.
  `../architecture/repository-audit.md` is the historical Phase 00 record (pre-Phase-02) — superseded.

---

## 1. Executive summary

The product is real at the application layer: authentication, tenant lifecycle,
branding, contacts CRM and catalogue are implemented, tested and deployed
against the live Supabase project; the documents schema layer is deployed
(engine/PDF/UI pending). On top of that, the owner-directed **application
foundation** (Turborepo monorepo, seven shared packages, Capacitor/Tauri
scaffolds, CI workflow) is **executed but uncommitted**.

Headline findings:

1. **`docs/ENGINEERING_CONSTITUTION.md` does not exist** in the repository.
   The constitution's binding rules were delivered as owner directives
   (2026-10-14) and are recorded in `phase-checklist.md`,
   `phase-04.5-constitution-alignment.md` and this audit's accompanying docs.
   _Owner action: commit the canonical constitution text._
2. **The monorepo restructure is staged but not committed** (161 files staged;
   95 further working-tree modifications; 38 untracked files). Revert path is
   the working tree itself — nothing is committed that cannot be reviewed.
3. **All gates are green** — verified twice: on the working tree and in a
   pristine-copy rehearsal (frozen-lockfile install → format → lint →
   type-check → tests → production build → secret scan). Details in §8.
4. **The CI workflow exists but has never run on GitHub** (no push has
   happened). Nothing in this audit claims a remote CI success.
5. **The tenant-isolation architectural risk is unchanged and still the top
   item:** RLS policies exist but are inert (no `set_config` GUC, table-owner
   connection); application-layer authorization is the only control in force
   until Phase 08. See §12.

---

## 2. Git status & repository structure (inspection area 1)

History: `73bbcd4` Initial → `282d742` (Supabase deployment, RLS hardening,
Phase 03.5 audit) → `ed030c7` (**HEAD**, Supabase Auth swap, Phase 04.5a).
Branch `main`; no remote push of the restructure; **no commits were created by
this work session**.

Working-tree state (restructure uncommitted):

| Bucket                 | Count | Content                                                                |
| ---------------------- | ----- | ---------------------------------------------------------------------- |
| Staged (index)         | 161   | `git mv` renames of the app into `apps/web`, new packages, …           |
| Unstaged modifications | 95    | import rewires, docs, formatting, further edits on top of moves        |
| Untracked              | 41    | `packages/*`, `apps/mobile`, `apps/desktop`, `.github/`, audit docs, … |
| Staged deletion        | 1     | `src/lib/db/prisma.ts` (moved into `packages/database/src/`)           |

(Counts are the audit-day snapshot; the tree evolves as review fixes land
until the owner-approved commit.)

Current layout (verified on disk):

```
apps/web        Next.js app — src/ prisma/ messages/ public/ tests/ (env files git-ignored, never staged)
apps/mobile     @amisibiz/mobile  — Capacitor 8 Android scaffold (web/ placeholder; README)
apps/desktop    @amisibiz/desktop — Tauri 2 Windows scaffold (src-tauri/ incl. generated icons; README)
packages/auth|config|database|domain|documents|sync|ui   — source-only shared packages
docs/ .github/ .kilo/ (tracked; never staged)  .scratch-p05-*.sql (tracked scratch)
turbo.json  pnpm-workspace.yaml  pnpm-lock.yaml  .prettierignore  .prettierrc.json
```

Standing repository rules already enforced: `.env*` (except the placeholder
`.env.example` template), `uploads/`, and `.kilo/` are never committed.

## 3. Next.js configuration & package manager (area 2)

All versions below were read from the installed tree, not from documentation.

| Item       | Verified value                                                                                |
| ---------- | --------------------------------------------------------------------------------------------- |
| Next.js    | **15.5.27** (App Router); middleware pinned to the **nodejs** runtime                         |
| React      | **19.3.0**                                                                                    |
| TypeScript | **5.9.3**, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` (shared config) |
| Tailwind   | **3.4.19** + semantic CSS-variable tokens                                                     |
| next-intl  | **3.26.5** (pinned — v4 is a breaking migration, do not bump casually)                        |
| Prisma     | **6.19.3**; zod **3.25.76**; Vitest **3.2.7**; ESLint **9.39.5** flat                         |
| pnpm       | **11.18.0** (pinned via `packageManager`); Node **24.18.1** local                             |
| Turborepo  | **2.11.8**                                                                                    |

`apps/web/next.config.mjs` (verified): next-intl plugin,
`transpilePackages` for the six runtime packages (source-only, no build step),
`images.remotePatterns` wildcard `*.supabase.co` (pre-existing R12 — tighten
when Storage lands), typedRoutes intentionally off.

Package-manager mechanics: pnpm workspaces (`apps/*`, `packages/*`); pnpm 11
build-script allow-list (`allowBuilds`) gates Prisma/esbuild scripts;
`apps/web` `postinstall: prisma generate` makes fresh installs (and CI/Vercel)
self-sufficient — verified working with **no env vars present**.

## 4. Supabase: project, migrations & RLS (area 3)

- **Project:** live; **shared with AmisERP** (separate `amisierp*` schemas; our
  tables in `public`) — risk **S1**, dedicated production project recommended
  before launch (owner decision).
- **Migrations:** seven frozen, applied entries under
  `apps/web/prisma/migrations/` (init → RLS policies → Phase 04 → Phase 05
  documents/numbering → bookkeeping narrowing → RLS hardening → Supabase Auth
  alignment). Applied files are immutable; corrections ship forward. P3005
  workaround documented (pre-created empty `_prisma_migrations`; never
  baseline). No `supabase/config.toml` — the chain is Prisma-only.
- **Connections:** runtime uses the pooled URL (6543, pgbouncer); migrations use
  the session-mode URL (5432). Both documented in `.env.example` (names only).
- **RLS: present but inert.** Policies and helpers exist (53 policy/ENABLE
  statements across four migrations; server-set fail-closed GUC model), but the
  app connects as the table owner and no code sets `app.current_tenant_id` —
  activation (least-privileged `amisibiz_app` role + per-request
  `set_config(..., true)`) is Phase 08. Application-layer authorization is the
  control actually in force; the RLS behavioural test exists but runs only
  against a disposable DB via `TEST_DATABASE_URL`.
- **Storage:** not adopted yet. Branding logos use the filesystem (owner
  carve-out; S3 — will not survive a stateless Vercel deploy; move scheduled
  with documents work). Document PDFs plan to use Supabase Storage (Phase 05).

## 5. Authentication & authorization (area 4)

- **Supabase Auth** live (Phase 04.5a): `@supabase/ssr` cookie sessions; GoTrue
  as IdP; login/register/logout/password-reset via server actions;
  `/auth/callback` handles code+OTP links with a same-app-only redirect
  sanitiser.
- **Session trust chain:** `User.sessionVersion` (DB) is compared against the
  access-token claim `app_metadata.amisibiz_session_version` on every request;
  revocation = DB bump → GoTrue session kill → claim sync. Middleware refreshes
  the session and gates protected routes fail-closed.
- **Authorization:** `authorizeTenant` / `authorizePlatform` — deny-by-default,
  permission-matrix driven (platform/tenant role domains are disjoint), audited
  denials, server-side only. No Auth.js remnants; no `AUTH_*` session logic.
- **Boundaries:** the Supabase **secret key is server-only** — admin client
  constructed behind `server-only` guards in `@amisibiz/database` /
  `apps/web/src/lib/supabase/server.ts`; the browser never holds a Supabase
  client. Environment access is zod-validated with **aggregated** error
  messages and `.env.example` pointers; production fails closed if
  `NEXT_PUBLIC_APP_URL` is unset.

## 6. UI, routes & business logic (area 5)

Routes (all locale-prefixed `/en|fr|sw`): auth surfaces (login, register,
forgot/reset password, verify email, callback), workspace `/app`
(dashboard, contacts, items, documents placeholder, settings/branding), team,
platform console `/admin` + `/admin/tenants*`, API routes (`/api/health`,
`/api/branding/logo`, `/uploads/tenants/[...path]` authorized serving).
Protected modules render controlled access states until implemented — no fake
functionality.

UI: 21 hand-rolled components in `@amisibiz/ui` (deep imports; no barrel —
deliberate, the kit has a `Select` name collision between two modules),
workspace/auth/admin shells + accessible mobile drawer (`<dialog>`-based).
i18n: next-intl with English/French/Swiss-edition Swahili message sets.

Business logic: server actions under `apps/web/src/server/actions` (auth,
tenant, platform, branding, contact, contact-item, item, document-read) with
services (`tenant-provisioning`, documents skeleton), shared validations,
audit writer, rate-limit utility, branding contrast/money/series in the shared
packages. Permission matrix documented centrally.

**Explicitly not implemented (by phase design):** document calculation engine,
status lifecycle, PDF rendering/download, `/app/documents` UI (Phase 05);
audit viewer/observability (07); shadcn/ui adoption (04.5c); offline/SQLite
(04.5d design first); DPO/eTIMS (04.5e design only; eTIMS stays separate).

## 7. Vercel configuration & environment variables (area 6)

- **No `vercel.json`, no `.vercel/`, no Dockerfile.** Deployment is not
  configured; Vercel target + monorepo wiring (root dir = repo root, install
  `pnpm install`, build via turbo filter, **migrations never run in the
  build**) is documented and scheduled for Phase 08. No deploy is claimed.
- Environment variables (names only; canonical list in `phase-checklist.md` §3
  and `apps/web/.env.example`): app URL/name (public); pooled + direct database
  URLs; three Supabase variables (two public, `SUPABASE_SECRET_KEY`
  **server-only**); hostname-routing vars (`APP_BASE_DOMAIN`, …, `TRUST_PROXY`
  — forwarded-host honored only when a trusted proxy is declared); seed
  bootstrap vars (no default credentials; production seeding double-gated);
  `REQUIRE_EMAIL_VERIFICATION` (stays off until email delivery is verified);
  email/SMTP + Redis/Upstash + `TEST_DATABASE_URL` (all Phase 08 / dev only).
- **Env-loading convention (verified):** `apps/web/.env` is the shared file
  (Next.js, the Prisma CLI and `prisma/seed.ts` — which calls
  `process.loadEnvFile(".env")` — all load it); `apps/web/.env.local` is a
  Next-only override. The template is `apps/web/.env.example` (placeholders
  only). Real credential files are git-ignored at any depth and were never
  printed, staged, or copied outside the working tree.
- Client-bundle secret discipline: verified by a build-output scan — see §8.

## 8. Tests, CI & build status (area 7)

**Test inventory:** 9 Vitest test files under `apps/web/tests/` (plus shared
mocks/stubs — 13 files total in that directory) — **201 passed / 13 skipped
(214)**. The skipped file/tests are the DB-backed integration/RLS suite, which
requires a disposable `TEST_DATABASE_URL` and must never target the shared
project. The Phase 04 security/logo suites were mutation-checked when written
(deliberate breaks produced failures).

**CI:** `.github/workflows/ci.yml` (new): frozen-lockfile install (with Prisma
generate via `postinstall`) → `format:check` → `turbo run lint type-check
test:run build` → guard that greps the Next.js build output for a
**value-shaped** secret key. The workflow **has not run on GitHub yet** (no
push). It was instead **rehearsed from a pristine copy** (no `node_modules`, no
`.env`, CI placeholder env — exactly what Actions would see):

| Rehearsal step                             | Result                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`           | OK — postinstall generated the Prisma client, no env needed                                                                                                    |
| `pnpm format:check`                        | **Found 15 unformatted files** → fixed (see below); now green                                                                                                  |
| `turbo run lint type-check test:run build` | **18/18 tasks successful, 0 cached** (full cold run), production build incl. full route tree                                                                   |
| Secret scan of build output                | Bare `sb_secret_` prefix is legitimate Supabase library code (key-format detection) — guard refined to a value-shaped pattern; clean on static + server output |

Fixes made during the rehearsal (preserving existing work, style-only): all
15 files formatted; `pnpm-lock.yaml` + `pnpm-workspace.yaml` added to
`.prettierignore` (pnpm rewrites them in its own style on every install, so
formatting them would churn permanently).

**Working-tree gates (same sequence, post-fix):** format:check green; turbo
`lint type-check test:run build` **18/18 successful** (4 cached) with
**201 passed / 13 skipped** tests and the production build completing the full
route tree; the `sb_secret_` value-pattern scan is clean on the live build. No
privileged credential appears in any client or server bundle.

## 9. Offline, mobile, desktop & PDF capabilities (area 8)

- **Mobile (`apps/mobile`)** — Capacitor **8.5.3** scaffold only. Feasibility
  verified on this machine: JDK 17 + Android SDK present; Node/pnpm present.
  **Never compiled** (`cap add android`/`cap sync` not run); the README says so
  explicitly and documents the commands and prerequisites.
- **Desktop (`apps/desktop`)** — Tauri **2** scaffold only. Rust toolchain
  **absent** on this machine → cannot compile here; MSVC Build Tools not
  verified. App icons **were generated** from the brand logo via the prebuilt
  CLI (all icon paths in `tauri.conf.json` exist and match). **No build
  success is claimed anywhere.**
- **Offline/SQLite: intentionally absent.** The constitution's offline rules
  (client-generated UUIDs, server idempotency, no device-timestamp-only
  conflict resolution, no fabricated sync/payment/activation success) are
  captured as contracts in `@amisibiz/sync` and the `idempotencyKey` column;
  the architecture decision (Capacitor can't bundle the SSR app — three client
  shapes analyzed) is deferred to the **04.5d design** before any client code.
- **PDF:** contracts only (`@amisibiz/documents/pdf.ts` — render from frozen
  snapshot; never presented as a KRA/eTIMS tax invoice). Renderer + download
  route are Phase 05; eTIMS remains a separate future system.

## 10. Data flow & trust boundaries (deliverable)

```
Browser ──cookies──▶ Middleware (nodejs runtime)
                     · next-intl locale routing
                     · Supabase session refresh
                     · host → tenant subdomain resolution (TRUST_PROXY-gated)
                     · fail-closed route gating
        ─────────────▶ Server Components / Server Actions (apps/web)
                     · re-derive identity from DB (never from the request body)
                     · authorizeTenant / authorizePlatform (deny-by-default, audited)
                     · validate every input with Zod; decimal money as strings
        ─────────────▶ Prisma (table-owner connection) ──▶ PostgreSQL (Supabase)
                     [RLS policies defined but inert until Phase 08]
Side channels: Supabase Auth (GoTrue) = identity source of truth;
Supabase admin client (secret key) = server-only, behind server-only guards;
uploads served by an authorized route (membership + path-shape + magic-byte checks)
```

Trust-boundary rules in force: client-supplied tenant IDs/roles/prices/totals/
statuses are never trusted — the tenant is re-derived server-side and pinned
into every query predicate (fail-closed on `count === 0`); forwarded-host
headers are ignored unless a trusted proxy is declared; commercial PDFs will
never be presented as KRA/eTIMS tax invoices; a local tenant-status value is
never authoritative proof of activity.

## 11. Dependency & platform compatibility (deliverable)

Current verified versions: see §3 table. Platform assessment (registry-checked
2026-10-14, full detail in `phase-04.5b-monorepo-and-clients-audit.md` §3):
Capacitor 8.5.3 requires static assets and a Node 20+ toolchain — an SSR
Next.js app **cannot** be bundled as-is, so the client shape (remote-URL shell /
static-export subset / dedicated Vite client) is an explicit 04.5d decision;
`@capacitor-community/sqlite` 8.x vs the Capawesome alternative are both
flagged for evaluation; Tauri 2.12.2 (Windows, WebView2) + first-party
`plugin-sql` 2.5.0 are the aligned choices; Rust + MSVC prerequisites
documented in the desktop README. CI pins Node 24 to match development.

## 12. Threat model & tenant-isolation risks (deliverable)

The operative risk register is **S1–S10** in
`phase-04.5b-monorepo-and-clients-audit.md` §5 (S1 shared Supabase project;
S2 RLS inert; S3 filesystem logos; S4 no CI; S5 in-memory rate limiting;
S6 no email transport; S7 no security headers/CSP; S8 `AUTH_*` remnants;
S9 wildcard Supabase image host; S10 cuid-vs-UUID for offline capture), with
these updates from this audit:

- **S4 (no CI): partially resolved** — the workflow now exists and the full
  sequence passes in a pristine rehearsal; the first remote run is pending the
  next push, and the migration-drift job stays Phase 08.
- **S8: resolved** — the README no longer references `AUTH_*`; template env
  vars were already clean after 04.5a.
- **New — restructure uncommitted:** the entire foundation is uncommitted;
  its revert path is the working tree. Owner commit approval pending.
- **New — line endings:** Git reports LF→CRLF normalization on Windows
  checkouts; cosmetic, but agree a `.gitattributes` policy alongside the
  commit (owner decision).

Tenant-isolation layered defense: (1) middleware gating; (2) application-layer
authorization (in force); (3) tenant-pinned queries with fail-closed counts
(in force, tested); (4) RLS (defined, **inactive** — Phase 08); (5)
audit logging of privileged actions. Isolation tests: mocked-suite coverage
now; live two-tenant RLS test exists but is DB-gated.

## 13. Phased plan & acceptance checklist (deliverable)

Phases and status (canonical detail: `phase-checklist.md`):

| Phase                                               | Status                                                      |
| --------------------------------------------------- | ----------------------------------------------------------- |
| 00 — Repository audit                               | **COMPLETE (this document)**                                |
| 01 — Application foundation (owner directive)       | **Executed, uncommitted** — `phase-01-foundation-report.md` |
| 04.5a — Supabase Auth swap                          | Complete, deployed (`ed030c7`)                              |
| 04.5b — Turborepo monorepo + packages + shells + CI | Executed, uncommitted (this restructure)                    |
| 04.5c — shadcn/ui for new UI                        | Not started                                                 |
| 04.5d — Offline architecture design                 | Not started (design doc only, before any client code)       |
| 04.5e — DPO / eTIMS interface design                | Not started (design doc only)                               |
| 05 — Document engine, lifecycle, PDF, UI            | Schema deployed; implementation paused                      |
| 07 — Audit viewer & observability                   | Not started                                                 |
| 08 — Hardening, deployment, CI drift job            | Not started                                                 |
| Post-08 — Client implementation                     | Owner-gated after 04.5d                                     |

Acceptance checklist (Phase 0 directive) — all met:

- [x] Repository inspected across all 8 areas (git, framework/package manager,
      Supabase/migrations/RLS, auth/authz, UI/routes/logic, Vercel/env, tests/CI/build, offline/mobile/PDF).
- [x] Architecture assessment (§1–§9).
- [x] Recommended repository structure adapted to the actual code (§2, realized
      layout; conventions: source-only packages, deep imports, no barrels).
- [x] Data-flow & trust-boundary documentation (§10).
- [x] Dependency & platform compatibility report (§11).
- [x] Threat model & tenant-isolation risks (§12).
- [x] Phased plan & acceptance checklist (§13).
- [x] Required environment variables & external accounts (§14).
- [x] `docs/IMPLEMENTATION_STATUS.md` updated (created).
- [x] No secrets revealed; no destructive migrations; no dependency
      replacements; no production deploys; existing work preserved.

## 14. Environment variables & external accounts (deliverable)

Variables: full table in `phase-checklist.md` §3 (names, scope, required-in
column). New in this phase: nothing — the restructure relocated the template to
`apps/web/.env.example` without adding variables.

External accounts / owner actions: **Vercel account + project** (not yet
created; Phase 08), **dedicated production Supabase project** (S1
recommendation — currently shared with AmisERP), **domain + wildcard DNS** for
tenant hostnames, **SMTP provider** (blocks production registration), Google
Play Console + Android signing (future), Windows code-signing certificate
(future), DPO Group merchant account (design-gated 04.5e), KRA/eTIMS
(separate system — note only), and **`docs/ENGINEERING_CONSTITUTION.md`
missing — commit the canonical text**.

## 15. Scope guards honored

No Phase 1 work started. No destructive migrations, dependency replacements or
production deploys. No commits created. The pristine rehearsal ran in a
throwaway copy outside the repository; the only repository changes made by this
audit were documentation, formatting fixes and the CI/rehearsal corrections
recorded in §8.
