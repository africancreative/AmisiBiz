# AmisiBiz — Implementation Status

- **Updated:** 2026-10-14 (Phase 2 provider administration, through task #45;
  committed locally as `f0dfe59` + `b6bbea1`, **not pushed**).
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
- **Phase 05 (document engine/PDF/UI): gated.** The directive forbids business
  feature work until the core authorization and RLS tests pass in a real
  database harness (#37) — which they have not, because no such harness runs yet.

## Feature status

| Area                               | Status                                                | Evidence / notes                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth & sessions (Supabase Auth)    | Implemented & deployed                                | Phase 04.5a; commit `ed030c7`; `sessionVersion` trust chain live                                                                                                                                                                                                         |
| Authorization / RBAC               | Implemented (unit-proven); DB-side proof pending #37  | 42-permission catalog (9 platform / 33 tenant) mirrored into `Permission`/`RolePermission`; deny-by-default `authorizeTenant`/`authorizePlatform`/`authorizePlatformTenant`; role-change guards also trigger-enforced                                                    |
| Provider support access            | Implemented (unit-proven)                             | `SupportAccessGrant`: one tenant, mandatory reason, default 24 h / max 30 d, revocable, read-only grant set, four audit actions; `has_tenant_write_access` has no support branch                                                                                         |
| Tenant lifecycle & platform admin  | Implemented (Phase 2); live DB unapplied              | Three verified transitions from `TENANT_STATUS_TRANSITIONS`; each permission-gated, reason-bearing, atomic (guarded `updateMany` + history + audit). Suspension = writes/sync denied, reads/downloads kept; no row or storage deletion; no automatic suspension anywhere |
| Provider console (`/admin/*`)      | Implemented (Phase 2); not exercised in a browser     | Provision, search/filter/paginate, lifecycle, plan, branding + preview shells, domains/slug, numbering, owner invitation, status history, audit trail, indicators. Administrator docs: `administration/provider-console.md`                                              |
| Plan catalogue                     | Implemented as **informational only** (Phase 2)       | `Plan` + `Tenant.planId` FK, no price/limit columns, `SELECT`-only for the runtime role, one seeded `standard` plan; assignment audited under `platform.tenants.plan.assign`; grants nothing                                                                             |
| Operational indicators             | Implemented; `lastSyncAt` legitimately `null`         | `lastActivityAt`/`lastSyncAt`/`lastSyncErrorCode` written only by `touch_tenant_activity()` / `record_tenant_sync_attempt()`; no sync transport until Phase 06                                                                                                           |
| Branding (tenant colours/logo)     | Implemented                                           | Phase 04; filesystem logo storage (owner carve-out; see risk S3)                                                                                                                                                                                                         |
| Contacts CRM                       | Implemented                                           | Phase 04; archive-not-delete; outstanding balances from issued docs                                                                                                                                                                                                      |
| Catalogue (items, customer prices) | Implemented                                           | Phase 04; decimal-string money, no floats on financial paths                                                                                                                                                                                                             |
| Documents (schema + numbering)     | Schema deployed; engine/PDF/UI pending                | Phase 05 gated; `allocate_document_number()` in migration 10                                                                                                                                                                                                             |
| RLS policies & grants              | Written and applied; **inert** for the running app    | Migrations 8–10; offline scratch verification only; activation = `RUNBOOK.md` §3 (task #38)                                                                                                                                                                              |
| Least-privileged runtime role      | Role + grants exist; `APP_DATABASE_URL` unpublished   | `amisibiz_app` (`NOINHERIT`, no `BYPASSRLS`); production boot refuses the owner-role fallback                                                                                                                                                                            |
| Scoped DB context                  | Implemented (task #35)                                | `scope.ts` writes the five transaction-local GUCs; fail-closed `ScopeNotSetError`; claims re-read from rows by `SECURITY DEFINER` helpers                                                                                                                                |
| Supabase Storage                   | Policies only; app still uses filesystem `/uploads`   | `tenant-branding` bucket + path-scoped object policies (migration 10 §7); adoption is task #36                                                                                                                                                                           |
| DB-backed integration harness      | Not running                                           | `integration-security.test.ts` exists but skips 13 tests without `TEST_DATABASE_URL`; no CI service — task #37                                                                                                                                                           |
| Monorepo & shared packages         | Committed (`f0dfe59`) — still no remote push          | Turborepo 2.11.8; 7 source-only packages; 11 workspace projects                                                                                                                                                                                                          |
| Client shells (Android / Windows)  | Scaffolded only — never compiled                      | Capacitor 8 / Tauri 2; feasibility + prerequisites in each README                                                                                                                                                                                                        |
| CI (GitHub Actions)                | Workflow added — not yet run on GitHub                | Sequence rehearsed green from a pristine copy (18/18 turbo tasks)                                                                                                                                                                                                        |
| Offline / SQLite                   | Not started (by design)                               | Contracts in `@amisibiz/sync`; 04.5d design first                                                                                                                                                                                                                        |
| PDF rendering / download           | Not started (contracts only)                          | `@amisibiz/documents/pdf.ts`; Phase 05; never a KRA/eTIMS invoice                                                                                                                                                                                                        |
| DPO payments / POS                 | Not started (design-only phase pending)               | 04.5e; no simulated live payments                                                                                                                                                                                                                                        |
| KRA/eTIMS                          | Out of scope (separate system; integration note only) | 04.5e note                                                                                                                                                                                                                                                               |
| Vercel deployment                  | Not configured (no `vercel.json`/`.vercel`)           | Phase 08; no deploy claimed                                                                                                                                                                                                                                              |

## Verification status (last run 2026-10-14, Phase 2 / task #45)

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

## Open risks (top items — full register: `implementation/phase-04.5b-monorepo-and-clients-audit.md` §5)

1. **S2 — RLS inert:** the runtime cannot yet connect as `amisibiz_app` (no
   password), so application-layer authorization is the only control in force
   for a deployed app. Closure: `RUNBOOK.md` §3 + `pnpm db:assert-rls`.
2. **No DB-backed proof of the eight required security properties.** Mock suites
   prove the application's decisions; the behavioral RLS battery that proved
   cross-tenant isolation lives in git-ignored `.tmp/` scratch files, so it is not
   reproducible from the repository. Task #37.
3. **S1 — Supabase project shared with AmisERP:** dedicated production project
   recommended before launch (owner decision).
4. **S6 — No email transport:** verification/password-reset emails are not
   delivered; `REQUIRE_EMAIL_VERIFICATION` stays off, so production registration
   must stay disabled.
5. **Committed locally only:** `f0dfe59` (foundation + Phase 1 directive) and
   `b6bbea1` (Phase 2) exist on `main` in this repository; there is **no remote
   push and no CI run**, so the work has no off-machine copy. The split is a
   file grouping — only the final tree was gate-verified, and shared files whose
   content spans both phases ride in `b6bbea1`.
6. **`docs/ENGINEERING_CONSTITUTION.md` missing:** the Phase 0 pack references it;
   the binding rules are recorded in docs/memory — commit the canonical text.
7. **Client shells uncompiled:** no Android/Tauri build has been run anywhere.

## Next actions (owner-gated)

1. **Decide the push** (task #30 closed 2026-10-14 by the owner's commit
   approval): the two commits are local; publishing to GitHub — which is what
   would make the CI workflow run for the first time — remains the owner's call.
   Nothing is ever pushed unilaterally.
2. **#38 operator step:** set a strong `amisibiz_app` password out of band and
   publish `APP_DATABASE_URL`, then run live probes **only with the owner's
   go-ahead**.
3. **#37** DB-backed integration harness + the eight required proofs + catalog
   parity + a CI Postgres service.
4. **#36** Supabase Storage adoption for logos (the policies already exist).
5. **04.5c** shadcn/ui for new UI → **04.5d** offline design → **04.5e**
   DPO/eTIMS design → **Phase 05 resumes** once the authz/RLS tests pass.

## Documentation map

| Document                                                   | Purpose                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `RUNBOOK.md`                                               | Operations: env vars, the two DB connections, RLS activation, verification, migration rules, incident response |
| `implementation/phase-checklist.md`                        | Phase plan, gates, env vars, next action                                                                       |
| `implementation/phase-00-repository-audit.md`              | Phase 0 audit                                                                                                  |
| `implementation/phase-01-foundation-report.md`             | Foundation execution record                                                                                    |
| `implementation/phase-01-security-design.md`               | Phase 1 authorization/RLS design                                                                               |
| `implementation/phase-04.5b-monorepo-and-clients-audit.md` | Monorepo/client audit + risk register                                                                          |
| `implementation/phase-04.5-constitution-alignment.md`      | 04.5a execution record                                                                                         |
| `architecture/security-model.md`                           | Trust boundaries, threat model, §13 Phase 1 status                                                             |
| `architecture/permission-matrix.md`                        | Roles, permission catalog, enforcement layers                                                                  |
| `architecture/system-design.md`                            | Architecture canon                                                                                             |
