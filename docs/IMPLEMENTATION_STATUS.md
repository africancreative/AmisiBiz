# AmisiBiz — Implementation Status

- **Updated:** 2026-10-15 (the Phase 4 directive — quotations, invoices and
  delivery notes — through verification; documentation committed, business code
  still in the working tree pending the owner's commit decision).
- **Read with:** `implementation/phase-checklist.md` (phase plan & gates),
  `architecture/security-model.md` §13–§14 (what enforcement exists and what does
  not), `architecture/permission-matrix.md`, `administration/provider-console.md`
  (administrator documentation + verified status transitions), `RUNBOOK.md`
  (operations).
- **Honesty rule honored here:** a feature is only listed as implemented when
  its gates actually ran; nothing in this file claims an unverified success.

## Current position

- **Phase 0 — Repository audit: COMPLETE.** Findings in
  `implementation/phase-00-repository-audit.md`.
- **Application foundation (owner's "Phase 1 — application foundation" of
  2026-10-14): executed and COMMITTED** (`f0dfe59`, 2026-10-14, after the owner
  approved a two-commit split). Monorepo, shared packages, client scaffolds and
  CI are now in history; nothing has been pushed to a remote. Record:
  `implementation/phase-01-foundation-report.md`.
- **Phase 1 — core authorization & RLS (constitution directive): code-complete
  through task #35, committed in `f0dfe59`, not yet verified live.** Migrations 8–10 are written,
  applied to the live project, checksum-clean and **frozen**; UUID identity, the
  seven tenant roles + two platform roles, the permission catalog (38 then, **42
  after Phase 2**),
  `SupportAccessGrant`, `TenantStatusHistory`, RLS policies + guard triggers,
  storage object policies and the least-privilege grants all exist. The scoped
  context (`packages/database/src/scope.ts`), the support-access service and the
  action refactor are in place; the test harness now asserts behaviour instead of
  id parsing, and a credential-leak defect in the audit writer was found and
  fixed. **RLS is still inert** — `amisibiz_app` has no password, so the runtime
  cannot connect as the role the policies were written for (`RUNBOOK.md` §3).
- **Owner decision of record:** _keep forward_ — no restore, no production
  writes; the live project stays at the Phase 1 schema (zero business data) and
  the remaining work is #35 (done) → operator password step (#38) → live probes
  **only with the owner's go-ahead**.
- **Phase 2 — provider administration (directive phase 2): code-complete through
  task #45, committed as `b6bbea1`, not applied to the live project.** Migration 11
  (`20261019000000_…plans_and_suspension_gates`) adds the informational `Plan`
  catalogue + `Tenant.planId` FK, the three indicator columns and their two
  `SECURITY DEFINER` writers, four new platform permissions (catalog 42, matrix
  116, `SUPER_ADMIN` 9, `SUPPORT` 0), the suspension write gate
  (`app_tenant_accepts_writes()`), `tenant_provider_columns_guard_update`, the
  `TenantDomain` delete grant and the one-primary-hostname index. The console
  (`/admin/*`) now provisions, searches/filters/paginates, transitions status with
  a mandatory reason in one atomic transaction, assigns plans, edits branding and
  numbering, manages slug + hostnames, assigns the initial owner by invitation,
  and reads status history, the audit trail (own `platform.audit.read` gate) and
  the indicators. Suspension now means **writes and synchronization denied,
  reads and downloads preserved** — the old "read and write are blocked" rule is
  superseded in `security-model.md` §4.1. Verified: 46 new unit cases, the
  clean-room chain on a throwaway cluster (abort probe + 55 PASS Phase 2 battery +
  67 PASS Phase 1 regression). **Not** verified: anything against the live
  database, and the browser walkthrough — the migration is unapplied there and
  `answerSyncRequest()` still has no transport caller (Phase 06). Record:
  `implementation/phase-02-provider-administration-report.md`.
- **Phase 4 directive — quotations, invoices and delivery notes (checklist slot
  "Phase 05"): implemented in the working tree, gate-verified, not committed, not
  audited.** The owner opened the business-feature gate by directive
  (2026-10-15: _"Directive opens the gate"_), so the gate note below is a direction,
  not a missing test: the repository half is met (`tests/integration-security.test.ts`
  — 26 cases as `amisibiz_app` — plus the committed batteries and
  `scripts/db/cleanroom-chain.sh`), while **#38 is still open and RLS remains inert
  in the deployed app**. The engine, actions, routes, UI and tests are recorded in
  `implementation/phase-05-documents-report.md`, which deliberately stops short of
  "complete": the clause-by-clause audit (task #55) was stopped mid-review, and
  §7 of that report lists the product gaps (no tax picker, no draft-editing screen,
  no portal UI, PDF bytes never rendered or inspected, mixed-language list/create
  screens).
- **The parked business tree was resurrected, repaired and put back in the working
  tree (owner decision, 2026-10-15, tasks #53/#54).** It had been parked on branch
  `wip/phase05-business-features` as `0a67b69` (task #52) because it did not
  compile — it imported a `document-detail-client` component that existed nowhere
  in the repository. That commit remains a parking record, not an approval. The
  code is now back, the 10 type errors are fixed, the missing detail client is
  written, and **18/18 turbo tasks pass on it** (see the Phase 4 run below);
  `main`'s HEAD still does not contain it until the owner approves the commit.

## Feature status

| Area                               | Status                                                      | Evidence / notes                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth & sessions (Supabase Auth)    | Implemented & deployed                                      | Phase 04.5a; commit `ed030c7`; `sessionVersion` trust chain live                                                                                                                                                                                                                                         |
| Authorization / RBAC               | Implemented; DB-side proofs green, CI wiring pending        | 42-permission catalog (9 platform / 33 tenant) mirrored into `Permission`/`RolePermission`; deny-by-default `authorizeTenant`/`authorizePlatform`/`authorizePlatformTenant`; role-change guards also trigger-enforced; catalog + matrix parity asserted in the DB-backed harness (#37d still open)       |
| Provider support access            | Implemented (unit-proven)                                   | `SupportAccessGrant`: one tenant, mandatory reason, default 24 h / max 30 d, revocable, read-only grant set, four audit actions; `has_tenant_write_access` has no support branch                                                                                                                         |
| Tenant lifecycle & platform admin  | Implemented (Phase 2); live DB unapplied                    | Three verified transitions from `TENANT_STATUS_TRANSITIONS`; each permission-gated, reason-bearing, atomic (guarded `updateMany` + history + audit). Suspension = writes/sync denied, reads/downloads kept; no row or storage deletion; no automatic suspension anywhere                                 |
| Provider console (`/admin/*`)      | Implemented (Phase 2); not exercised in a browser           | Provision, search/filter/paginate, lifecycle, plan, branding + preview shells, domains/slug, numbering, owner invitation, status history, audit trail, indicators. Administrator docs: `administration/provider-console.md`                                                                              |
| Plan catalogue                     | Implemented as **informational only** (Phase 2)             | `Plan` + `Tenant.planId` FK, no price/limit columns, `SELECT`-only for the runtime role, one seeded `standard` plan; assignment audited under `platform.tenants.plan.assign`; grants nothing                                                                                                             |
| Operational indicators             | Implemented; `lastSyncAt` legitimately `null`               | `lastActivityAt`/`lastSyncAt`/`lastSyncErrorCode` written only by `touch_tenant_activity()` / `record_tenant_sync_attempt()`; no sync transport until Phase 06                                                                                                                                           |
| Branding (tenant colours/logo)     | Implemented                                                 | Phase 04; filesystem logo storage (owner carve-out; see risk S3)                                                                                                                                                                                                                                         |
| Contacts CRM                       | Implemented                                                 | Phase 04; archive-not-delete; outstanding balances from issued docs                                                                                                                                                                                                                                      |
| Catalogue (items, customer prices) | Implemented                                                 | Phase 04; decimal-string money, no floats on financial paths                                                                                                                                                                                                                                             |
| Documents (schema + numbering)     | Schema deployed; engine/actions/UI in the **working tree**  | Phase 04 directive (checklist "Phase 05"): `@amisibiz/documents` engine, 12 server services, read+write actions, list/new/detail screens, en-fr-sw enum catalogue. `allocate_document_number()` ships in migration 10; nothing here is committed or live — `implementation/phase-05-documents-report.md` |
| Customer portal documents          | Download route only; **no portal UI**                       | `/api/portal/documents/[documentId]/pdf` requires `portal.documents.read`, resolves the caller's single linked `Contact` (`20261020000000`) and 404s another customer's document; unit-proven, never exercised in a browser                                                                              |
| RLS policies & grants              | Written and applied; **inert** for the running app          | Migrations 8–10; proven against a disposable PostgreSQL by the committed harness + batteries (`RUNBOOK.md` §4.1/§4.3) — **not** by the deployed app; activation = `RUNBOOK.md` §3 (task #38)                                                                                                             |
| Least-privileged runtime role      | Role + grants exist; `APP_DATABASE_URL` unpublished         | `amisibiz_app` (`NOINHERIT`, no `BYPASSRLS`); production boot refuses the owner-role fallback                                                                                                                                                                                                            |
| Scoped DB context                  | Implemented (task #35)                                      | `scope.ts` writes the five transaction-local GUCs; fail-closed `ScopeNotSetError`; claims re-read from rows by `SECURITY DEFINER` helpers                                                                                                                                                                |
| Supabase Storage                   | Policies only; app still uses filesystem `/uploads`         | `tenant-branding` bucket + path-scoped object policies (migration 10 §7); adoption is task #36                                                                                                                                                                                                           |
| DB-backed integration harness      | Runs, never in CI                                           | `integration-security.test.ts` — 26 cases as `amisibiz_app`, green against a disposable PostgreSQL; self-skips without `TEST_DATABASE_URL`. A `security` CI job exists (#37d) and has been rehearsed step by step locally, but no workflow run exists (no push) — task #37 closes only on one of those   |
| Monorepo & shared packages         | Committed (`f0dfe59`) — still no remote push                | Turborepo 2.11.8; 7 source-only packages; 11 workspace projects                                                                                                                                                                                                                                          |
| Client shells (Android / Windows)  | Scaffolded only — never compiled                            | Capacitor 8 / Tauri 2; feasibility + prerequisites in each README                                                                                                                                                                                                                                        |
| CI (GitHub Actions)                | Workflow added — not yet run on GitHub                      | Sequence rehearsed green from a pristine copy (18/18 turbo tasks)                                                                                                                                                                                                                                        |
| Offline / SQLite                   | Not started (by design)                                     | Contracts in `@amisibiz/sync`; 04.5d design first                                                                                                                                                                                                                                                        |
| PDF rendering / download           | Implemented in the working tree — **bytes never inspected** | Dependency-free A4 writer in `@amisibiz/documents` (pagination, repeated table header, page numbers, tenant colours/logo), rendered only from the frozen snapshot; tests assert `%PDF-1.4` … `%%EOF` and byte determinism, no multi-page or logo render was produced or opened                           |
| DPO payments / POS                 | Not started (design-only phase pending)                     | 04.5e; no simulated live payments                                                                                                                                                                                                                                                                        |
| KRA/eTIMS                          | Out of scope (separate system; integration note only)       | 04.5e note                                                                                                                                                                                                                                                                                               |
| Vercel deployment                  | Not configured (no `vercel.json`/`.vercel`)                 | Phase 08; no deploy claimed                                                                                                                                                                                                                                                                              |

## Verification status (last run 2026-10-14, Phase 2 / task #45 — superseded for the current tree by the follow-up run below)

| Gate                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                        | Green (exit 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm turbo run lint type-check`           | 16/16 tasks successful, 0 errors; 1 **pre-existing** warning (`<img>` in `components/platform/tenant-branding-panel.tsx`)                                                                                                                                                                                                                                                                                                                                        |
| `pnpm turbo run test:run`                  | **256 passed / 13 skipped** (9 files passed, 1 skipped). The 13 skips are `integration-security.test.ts`, which needs `TEST_DATABASE_URL` (#37)                                                                                                                                                                                                                                                                                                                  |
| `pnpm build`                               | Green (exit 0); `/admin/*` routes present                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secret scan (client bundles)               | Clean — 59 files under `.next/static` scanned for `sb_secret_*`, `postgres://user:pass@` and JWT-shaped values: no matches                                                                                                                                                                                                                                                                                                                                       |
| DB clean-room chain (throwaway cluster)    | Migrations 1→10 + legacy fixture, migration 11 **abort probe** (2 legacy text `planId` rows → refuses, nothing partial), then applies: `plans=1`, catalog **42**, matrix **116**, `planId type=uuid`. Phase 1 battery **67 PASS / 0 FAIL**; Phase 2 battery (`prisma/scripts/phase02-migration-checks.sql`) **55 PASS / 0 FAIL**; `prisma migrate diff --from-url <scratch> --to-schema-datamodel` prints only the probe fixture's `DROP TABLE "other_app_data"` |
| Post-commit re-run (`--force`, clean tree) | 17/17 lint + type-check + test tasks, **256 passed / 13 skipped**, build green, `format:check` green, `git status` clean afterwards — the committed tree is the verified tree                                                                                                                                                                                                                                                                                    |
| `pnpm db:assert-rls`                       | **Not executed** — live probe, owner go-ahead required                                                                                                                                                                                                                                                                                                                                                                                                           |
| Live Supabase project                      | Unchanged: **10 migrations applied, migration 11 pending**, zero business data. No live probe was run this phase                                                                                                                                                                                                                                                                                                                                                 |
| Provider console in a browser              | **Not exercised** — no live tenant exists and migration 11 is unapplied; the UI is verified by build, type-check and unit tests                                                                                                                                                                                                                                                                                                                                  |
| CI on GitHub                               | **Never executed** (no push) — workflow exists, rehearsal green                                                                                                                                                                                                                                                                                                                                                                                                  |

### Follow-up run — DB-backed harness, bundle scan, CI job and the two earned migrations (#37a–#37d, #50, #51; 2026-10-15)

`apps/web/tests/integration-security.test.ts` is now a real RLS harness: it builds
fixtures as the table owner, then asserts inside `SET LOCAL ROLE amisibiz_app`,
refuses any `TEST_DATABASE_URL` that looks like the shared Supabase project, and
migrates its own disposable database with both `DATABASE_URL` and `DIRECT_URL`
pinned. The behaviour battery, its legacy fixture and the clean-room driver moved
from git-ignored `.tmp/` into tracked files. Committed as `801e7c6`. Since that
commit the tree also carries the automated bundle scan (#37c), the CI `security`
job (#37d) and the two migrations the harness earned (#50, #51).

| Gate                                              | Result                                                                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| harness with `TEST_DATABASE_URL`                  | **26 passed / 0 failed** — on a rebuilt DB, a brand-new DB, on `main` with migrations 1–11 only, and again on a fresh database carrying `20261021000000`/`20261021000001` (`p37_gates`, 13:37) |
| teardown                                          | `tenants=0 / users=0 / grants=0 / foreign=0` (the last-owner guard is paused in `afterAll`, then re-enabled)                                                                                   |
| `scripts/db/cleanroom-chain.sh p37_final`         | 78 · 71 + 1 SKIP · 71 + 1 SKIP · 55 · **72** PASS, **0 FAIL**, exit 0; migration-11 abort probe fires; step 13 applies both new migrations and re-runs the battery                             |
| `pnpm turbo run lint type-check test:run --force` | 17/17 tasks, **256 passed / 26 skipped**, 0 errors; the only warning is the known `<img>`                                                                                                      |
| `pnpm build` / `pnpm format:check`                | green (build exit 0; `format:check` after the doc sweep)                                                                                                                                       |
| `pnpm check:bundles` (#37c)                       | clean — 178 files / 5.1 MB across `.next/static` + `.next/server`, after a fresh build                                                                                                         |
| repo-wide gates before the parking decision       | **red** with 10 type errors, all inside the untracked Phase 05 UI — see the parking bullet above                                                                                               |
| live Supabase project                             | **unchanged** — 10 applied, 11 pending, zero business data, no probe run                                                                                                                       |

Three findings came out of the harness and none was silenced by weakening a policy:
support access was fenced by the grant rather than the active context (**fixed** by
`20261021000000`), naive `timestamp(3)` window columns shift against a non-UTC
`now()` (**fixed** by `20261021000001`), and the battery's platform-admin case had to
become a comparison against the owner's unfiltered totals. Details:
`architecture/security-model.md` §13.6–§13.7 and
`implementation/phase-01-security-harness-report.md` §5.

### Phase 4 directive run — the document engine back in the tree (2026-10-15, task #57)

Run against the working tree that now carries the resurrected business code
(52 changed files, +11,295 / −386, plus the new
`app/[locale]/app/documents/[id]/document-detail-client.tsx`). Full detail,
acceptance mapping and the list of product gaps:
`implementation/phase-05-documents-report.md`.

| Gate                                                    | Result                                                                                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                     | green — `All matched files use Prettier code style!`                                                                                                                                                     |
| `pnpm turbo run lint type-check test:run build --force` | **18/18 tasks**, 0 errors; the only warning is the known `<img>`; build emits all five document routes into `app-path-routes-manifest.json`                                                              |
| `pnpm turbo run test:run`                               | **337 passed / 26 skipped** (363), Test Files 12 passed / 1 skipped — including `tests/phase05-documents.test.ts` (46 cases)                                                                             |
| `pnpm check:bundles`                                    | clean — **205 files / 5.5 MB** across `.next/static` + `.next/server`                                                                                                                                    |
| DB harness on fresh `p4_report_harness`                 | **26 passed / 26** as `amisibiz_app` (the `42501 permission denied` lines are the intended denial probes)                                                                                                |
| `scripts/db/cleanroom-chain.sh p4_report_chain`         | **78 · 71 + SKIP · 71 + SKIP · 55 · 72 PASS, 0 FAIL**; abort probe fires; step 13 applies `20261020000000` → `20261021000000` → `20261021000001`                                                         |
| live Supabase project                                   | **unchanged** — 10 applied, 11 and 12 pending, zero business data, no probe run; **RLS still inert (#38)**                                                                                               |
| **not** verified                                        | the clause-by-clause engine audit (#55, stopped mid-review), any PDF opened or printed, any browser walkthrough, numbering concurrency outside the SQL script, and everything that needs a live database |

## Open risks (top items — full register: `implementation/phase-04.5b-monorepo-and-clients-audit.md` §5)

1. **S2 — RLS inert:** the runtime cannot yet connect as `amisibiz_app` (no
   password), so application-layer authorization is the only control in force
   for a deployed app. Closure: `administration/rls-activation-operator-procedure.md`
   (`RUNBOOK.md` §3 is its summary) + `pnpm db:assert-rls`.
2. **The eight security proofs are reproducible and now automated, but no CI run
   exists.** They run from tracked files — `tests/integration-security.test.ts` (26
   cases as `amisibiz_app`), `prisma/scripts/rls-behavior-battery.sql`,
   `scripts/db/cleanroom-chain.sh` — against a real PostgreSQL, the `.tmp/` scratch
   dependency is gone, and proof 8 has its own automated check
   (`pnpm build && pnpm check:bundles`, #37c / task #48). `.github/workflows/ci.yml`
   carries a `security` job that runs the chain, both batteries, the harness and
   three role/catalog SQL assertions on a disposable Postgres 16 (#37d / task #49).
   **Neither has ever executed:** this repository has no remote push, so "CI green"
   is not a claim anyone can make yet. No live project has been probed (#38).
3. **S1 — Supabase project shared with AmisERP:** dedicated production project
   recommended before launch (owner decision).
4. **S6 — No email transport:** verification/password-reset emails are not
   delivered; `REQUIRE_EMAIL_VERIFICATION` stays off, so production registration
   must stay disabled.
5. **Committed locally only — and the document work is not even committed:**
   `main` carries `f0dfe59` (foundation + Phase 1 directive), `b6bbea1` (Phase 2),
   `3d72698` (docs), `801e7c6` (the DB-backed harness), `87c7938` + `22f035d`
   (bundle scan, CI job, the two earned migrations, and the aligned doc counts),
   plus this documentation commit; the parked business work still exists as
   `0a67b69` on `wip/phase05-business-features`. The **resurrected, repaired,
   gate-green Phase 4 tree exists only as uncommitted working-tree changes** until
   the owner approves a commit, so it has no history entry and no off-machine
   copy. There is **no remote push and no CI run** anywhere in this repository, so
   none of the above has a second copy. The phase split is a file grouping — only
   the final tree was gate-verified, and shared files whose content spans both
   phases ride in `b6bbea1`.
6. **`docs/ENGINEERING_CONSTITUTION.md` missing:** the Phase 0 pack references it;
   the binding rules are recorded in docs/memory — commit the canonical text.
7. **Client shells uncompiled:** no Android/Tauri build has been run anywhere.
8. **The two policy findings are fixed in the tree, not in the deployed database:**
   `20261021000000_phase1_support_read_access_scoped_to_context` scopes the
   `has_tenant_read_access` support branch to the active context (with an explicit
   no-context exception so the provider console can still list its granted
   workspaces), and `20261021000001_phase1_support_and_invitation_windows_are_instants`
   converts the support/invitation window columns to `timestamp(3) WITH TIME ZONE`
   (tasks #50, #51). Both are authored, applied to throwaway databases, and covered by
   harness cases that fail without them. They are **not** on the live project, which is
   still at migration 10 — so the unfixed behaviour is what any deployed instance still
   runs until #38 and the owner-gated migration sequence complete.

## Next actions (owner-gated)

1. **Decide the push** (task #30 closed 2026-10-14 by the owner's commit
   approval): four commits are local on `main` and the parked branch is local too;
   publishing to GitHub — which is what would make the CI workflow run for the
   first time — remains the owner's call. Nothing is ever pushed unilaterally.
2. **#38 operator step — execute `administration/rls-activation-operator-procedure.md`.**
   It is written as a runbook: preflight queries, credential rotation for the Supabase
   block that was pasted into chat, `ALTER ROLE amisibiz_app PASSWORD …`, publishing
   `APP_DATABASE_URL`, `pnpm db:assert-rls`, then the three pending migrations and the
   post-apply probes, each with the output to expect and the condition to stop on. It
   has **not** been executed; every live step needs the owner's go-ahead, and the
   procedure says so at each point.
3. **#37 remainder:** the harness, both batteries, the clean-room chain, the
   automated bundle scan (#37c) and the CI security job (#37d) are all in the tree.
   #37 closes only when a CI run exists — which needs the push in item 1 — or when
   the owner accepts the local equivalent (both batteries plus the 26 harness cases
   green on a disposable database, as recorded in §5 of the harness report).
4. **#50 / #51 — done in the repository, pending on the live project.** The two
   follow-up migrations the harness earned (`20261021000000`, `20261021000001`) are
   authored and verified offline; §8 of the operator procedure applies them.
5. **#36** Supabase Storage adoption for logos (the policies already exist).
6. **04.5c** shadcn/ui for new UI → **04.5d** offline design → **04.5e**
   DPO/eTIMS design. The Phase 05/Phase 4 document work is now in the tree under
   the owner's _"Directive opens the gate"_ decision; the gate note above is a
   direction about the deployed database, not about missing tests, and #38 still
   has to land before any of it is enforced by RLS. `phase-05-documents-report.md`
   §7 is the list of what the business layer still lacks (tax picker, draft
   editing, portal UI, PDF render proofs, list/create i18n), and the Phase 3 gap
   table in `implementation/phase-01-security-harness-report.md` §8 lists what is
   genuinely missing in authorization coverage.

## Documentation map

| Document                                                   | Purpose                                                                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNBOOK.md`                                               | Operations: env vars, the two DB connections, RLS activation, verification, migration rules, incident response                                                                                           |
| `implementation/phase-checklist.md`                        | Phase plan, gates, env vars, next action                                                                                                                                                                 |
| `implementation/phase-00-repository-audit.md`              | Phase 0 audit                                                                                                                                                                                            |
| `implementation/phase-01-foundation-report.md`             | Foundation execution record                                                                                                                                                                              |
| `implementation/phase-01-security-harness-report.md`       | DB-backed authorization proofs (#37a–#37d), the findings and the migrations they earned, and the Phase 3 gap table                                                                                       |
| `implementation/phase-05-documents-report.md`              | Phase 4 directive (quotations, invoices, delivery notes): what is in the tree, the money and issuance rules, the acceptance mapping, the gate numbers, and the product gaps — **not a completion claim** |
| `administration/rls-activation-operator-procedure.md`      | #38 step by step: credential rotation, the `amisibiz_app` password, `APP_DATABASE_URL`, enforcement proof, the three pending migrations, post-apply probes, stop conditions — **not executed**           |
| `administration/provider-console.md`                       | How to run the provider console (Phase 2)                                                                                                                                                                |
| `implementation/phase-01-security-design.md`               | Phase 1 authorization/RLS design                                                                                                                                                                         |
| `implementation/phase-04.5b-monorepo-and-clients-audit.md` | Monorepo/client audit + risk register                                                                                                                                                                    |
| `implementation/phase-04.5-constitution-alignment.md`      | 04.5a execution record                                                                                                                                                                                   |
| `architecture/security-model.md`                           | Trust boundaries, threat model, §13 Phase 1 status                                                                                                                                                       |
| `architecture/permission-matrix.md`                        | Roles, permission catalog, enforcement layers                                                                                                                                                            |
| `architecture/system-design.md`                            | Architecture canon                                                                                                                                                                                       |
