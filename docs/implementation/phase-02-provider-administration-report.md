# Phase 2 — Provider Administration: completion report

- **Directive:** PHASE 2 — PROVIDER ADMINISTRATION (master engineering
  constitution, owner pack of 2026-10-14).
- **Executed:** 2026-10-14. **Tasks:** #41 (schema + catalog), #42 (server
  operations + suspension split), #43 (UI + i18n), #44 (tests), #45 (docs + gates).
- **State:** code-complete, all repository gates green, **uncommitted** (owner
  commit approval pending — task #30) and **not applied to the live Supabase
  project** (migration 11 is authored; deploying to the shared project needs the
  owner's explicit go-ahead).
- **Read with:** `../administration/provider-console.md` (administrator
  documentation + the verified transition list),
  `../architecture/security-model.md` §4.1 and §14,
  `../architecture/permission-matrix.md` §2/§4, `../RUNBOOK.md` §5–§7.

## 1. Owner decisions this phase implements

Recorded when the pack was reviewed; every one of them is now encoded in code, in
the database, or in both, and each has a test that would fail if it drifted.

| #   | Decision                                                                                            | Where it is enforced                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plans are an **informational catalogue**; assignment is a permission-gated, audited platform action | `Plan` table with no price/limit columns + `Plan_code_is_well_formed`/`Plan_sort_order_is_non_negative` CHECKs; `platform.tenants.plan.assign`; `SELECT`-only grant to the runtime role; `tenant_provider_columns_guard_update` refuses a tenant-side move of `planId` |
| 2   | Suspension = **deny writes + synchronization, allow reads/downloads**; rows and storage untouched   | `app_tenant_accepts_writes()` + `has_tenant_write_access` / `has_tenant_admin_write_access`; `assertWritableContext` in `authorization.ts`; `readonly` context in `resolveTenantContext`; the migration contains no cascade, delete or storage removal                 |
| 3   | Offline/synchronization = **server-side rejection + audit only**                                    | `answerSyncRequest()` / `recordSyncAttempt()` (`tenant-indicators.ts`), `Tenant.lastSyncAt`/`lastSyncErrorCode`, `sync.rejected` + `tenant.writeDenied` events, and the plain "an offline device keeps its cache" statements in the UI and docs                        |
| 4   | Previews are **branding preview shells now**, true per-document preview in Phase 05                 | `components/platform/document-preview.tsx` (labelled placeholder content, no tax, no issued number)                                                                                                                                                                    |

Plus the pack's verbatim rules, implemented as stated: manual provider-controlled
activation/suspension only ("do not automatically suspend tenants because a
payment is overdue"), status transitions through trusted server-side operations
with the acting administrator's permission checked on every request and the status
change + audit event recorded atomically, a dedicated platform route with its own
authorization guard, and branding designed so tenant self-service can be enabled
later through explicit permissions without changing document templates.

## 2. What was delivered

**Schema — migration 11**
`apps/web/prisma/migrations/20261019000000_phase02_provider_administration_plans_and_suspension_gates/migration.sql`

- `Plan` + `PlanStatus`, `Tenant.planId` converted from loose `TEXT` (which had no
  writer) to a UUID **foreign key** (`ON DELETE SET NULL`), with a pre-check that
  refuses the conversion rather than silently NULLing a legacy value; one seeded
  plan (`standard`), because no tier list has been published.
- Indicator columns `Tenant.lastActivityAt` / `lastSyncAt` / `lastSyncErrorCode`
  (plain TEXT + a ≤ 64-char CHECK, so new refusal codes never need a migration)
  and the two `SECURITY DEFINER` writers `touch_tenant_activity()` /
  `record_tenant_sync_attempt()`, revoked from `PUBLIC` and granted to
  `amisibiz_app` only.
- Permission catalog grows 38 → **42** (4 new platform permissions, 112 → 116
  `RolePermission` rows, `SUPER_ADMIN` = 9, `SUPPORT` = 0) with the totals asserted
  inside the migration so drift fails the deploy.
- The suspension gate plus the write-family policies (`Tenant`, `TenantSettings`,
  `TenantBranding`, `TenantDomain`, `TenantMember`, `Invitation`,
  `TenantStatusHistory`) and `allocate_document_number()` redefined to refuse a
  suspended workspace.
- `tenant_provider_columns_guard_update` (slug / plan / activation & suspension
  bookkeeping are provider-owned), a `DELETE` grant + policy for `TenantDomain`,
  and the partial unique index `TenantDomain_one_primary_per_tenant`.
- `plan_select` admits platform admins only; `anon`/`authenticated` revoked.

**Application**

- `server/services/tenant-lifecycle.ts` — `TENANT_STATUS_TRANSITIONS`,
  `transitionDescriptor()`, `availableTransitions()`: the single source for the UI
  buttons, the action refusals and the documented transition list.
- `server/actions/platform.ts` — `transitionTenantStatus()` authorizes **inside**
  the only function that writes a status, then commits
  `updateMany(WHERE status = expected)` + `TenantStatusHistory` + audit in one
  transaction. Ten further provider writes share `executeProviderWrite()`
  (profile, slug, domains ×3, plan, branding, numbering, owner assignment);
  provisioning uses `authorizePlatform`. All 15 exports are gated.
- `server/auth/authorization.ts` — `assertWritableContext()` is async, **awaits**
  the denial audit (`tenant.writeDenied`, or `support.accessDenied` for a grant)
  and only then throws; reads/downloads still resolve on a suspended workspace,
  and `authorizeTenant` stamps activity through `touchTenantActivity()`.
- `server/services/tenant-indicators.ts` — refusal codes
  (`tenant_suspended`, `no_membership`, `support_read_only`), the answer + record
  path, and the deliberate rule that a failed indicator write never refuses the
  business operation.
- `resolveTenantContext` / `getWorkspaceState` — a `SUSPENDED` workspace resolves
  with `readonly: true` instead of being blocked; `PENDING` stays closed.

**UI (en/ fr/ sw)** — `/admin` overview; `/admin/tenants` with search, status and
plan filters, page size, and pagination that preserves filters; `/admin/tenants/new`;
`/admin/tenants/[id]` with lifecycle actions, the suspension-reason card, profile,
plan, domains/slug, numbering, branding + document-preview shells, owner panel,
status history, audit trail and indicators. The audit panel renders a **stated
refusal** when `platform.audit.read` is absent rather than an empty list.

**Tests** — `apps/web/tests/phase02-provider-admin.test.ts` (46 cases): every
provider write denied for an ordinary user and for `SUPPORT` without a grant (12
cases, each asserting the missing permission is named in the `authz.denied` row
and that no provider delegate was touched); the three-row transition table with
its per-transition permission; atomicity (one `$transaction`, guarded `where`,
history row, audit row, zero deletes); "no automatic suspension" (nothing in the
surface changes a status outside an authorized action); the suspension split (7
write permissions refused with 7 `tenant.writeDenied` rows carrying
`{reason: "tenant_suspended", tenantStatus: "SUSPENDED"}`, 4 read/download
permissions resolving `readonly: true`, provider keeps write authority, `PENDING`
stays closed); the sync-answer matrix including `support_read_only`; address,
plan, branding, numbering, owner-assignment and console-read authorization cases.

## 3. Defects found while building this phase (all fixed)

1. **`transitionTenantStatus()` performed a privileged status write with no
   permission check** — the guard lived only in its three callers. Moved inside
   the function, against the descriptor's own permission, so activation cannot
   borrow a suspend-only operator and vice versa.
2. **The write-denial audit was fire-and-forget** — `assertWritableContext`
   threw before the `tenant.writeDenied` row landed, so a suspension refusal
   could happen with no evidence. Now awaited.
3. **`auditsFor()` in the shared harness could not see camelCase action names**
   (`tenant.writeDenied`), which made several denial assertions pass vacuously.
4. **The Prisma mock had no `plan` delegate**, so plan reads were silently
   undefined rather than asserted.
5. **Test-harness truths that were wrong, not the code:** `$transaction` **is**
   called by a denial (the audit append runs inside `runInScope`), so the
   provisioning-denial case now asserts the concrete writes it must not perform
   (`tenant.create`, `tenantStatusHistory.create`, `documentNumbering.createMany`);
   a one-character slug is valid, so the reserved/format case uses `admin`,
   `acme-`, `has spaces`, `-leading`; `plan.findUnique` runs before the
   equality check, so an "already assigned" test must mock the plan.
6. **A rejected `$executeRaw` mock leaked into the next test** — now restored in a
   `finally`, so the "stamp failure does not refuse the operation" case cannot make
   its neighbour fail for the wrong reason.
7. **Policy gap found while writing migration 11:** the pre-Phase 2 branding and
   settings policies had **no platform branch at all**, so a provider could not
   have edited a workspace's branding without being a member of it. Fixed in §5 of
   the migration.
8. **`TenantDomain` had no `DELETE` grant** (migration 10 granted per-table verbs),
   which would have made provider hostname removal fail at the grant layer rather
   than the policy layer. Grant added, then narrowed by the policy.
9. **Formatting drift:** 20 Phase 2 files were not prettier-clean; formatted and
   re-verified.

## 4. Verification (what actually ran, 2026-10-14)

**Repository gates**

| Gate                             | Result                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`              | Green (exit 0)                                                                                                                                    |
| `pnpm turbo run lint type-check` | 16/16 tasks successful; 0 errors; 1 **pre-existing** warning (`<img>` in `tenant-branding-panel.tsx`)                                             |
| `pnpm turbo run test:run`        | **256 passed, 13 skipped** (9 files passed, 1 skipped); the 13 skips are `integration-security.test.ts`, which requires `TEST_DATABASE_URL` (#37) |
| `pnpm build`                     | Green (exit 0; routes generated, `/admin/*` present)                                                                                              |
| New Phase 2 suite                | 46/46 passing                                                                                                                                     |

**Database verification — throwaway cluster (localhost:55499), never the live project**

Fresh clean-room chain, `sh .tmp/phase2_chain.sh p2_final`, re-run for this report:

- migrations 1 → 10 applied from empty, plus the foreign-table/sequence probe and
  the Phase 1 legacy fixture, then
- **abort probe:** with two legacy text `planId` rows present, migration 11 fails
  loudly (`Cannot convert Tenant.planId to a UUID: 2 row(s)…`) and the database is
  left untouched — `Plan` absent, `planId` still TEXT, catalog still 38. The file
  is one transaction, so nothing partial survives.
- after an operator resolves the label, migration 11 applies cleanly:
  `plans=1`, `permission catalog=42`, `role matrix=116`, `planId type=uuid`.
- **Phase 1 behaviour battery (regression on top of 11): 67 PASS, no FAIL.**
- **Phase 2 behaviour battery
  (`apps/web/prisma/scripts/phase02-migration-checks.sql`): 55 PASS, no FAIL.**
  It runs as `amisibiz_app` through `SET LOCAL ROLE` + `set_tenant_context()`, and
  covers: a suspended workspace keeps reads and the audit trail while every
  tenant-side write is refused and no business row disappears; provider authority
  unaffected by status; a tenant admin cannot activate/suspend/re-slug/re-plan its
  own workspace; `PENDING` provisioning and invitation acceptance still work; the
  plan catalogue is platform-readable and runtime-unwritable; the indicator
  functions refuse a caller outside the workspace; one primary hostname per
  workspace; and the domain `DELETE` gate.
- `prisma migrate diff --from-url <that db> --to-schema-datamodel` prints only
  `DROP TABLE "other_app_data"` — the probe fixture — i.e. schema == datamodel.

**What was NOT verified** (and therefore is not claimed):

- Nothing was applied to, or probed against, the live Supabase project. It remains
  at **10/10** migrations with zero business data, per the owner's _keep forward_
  decision.
- **RLS is still inert for the running application**: `amisibiz_app` has no
  password and `APP_DATABASE_URL` is unpublished (#38), so the new policies and
  triggers are proven against a throwaway cluster, not against production traffic.
- The 13 skipped DB-backed vitest tests (#37) have not been run with a
  `TEST_DATABASE_URL` in this phase; the scratch batteries above are the evidence
  for the suspension gate, and they are still scratch scripts rather than CI.
- No provider console screen has been exercised in a browser against a live
  tenant; the UI is verified by build + type-check + unit tests only.
- `answerSyncRequest()` has **no production caller** yet (the sync transport is
  Phase 06), so `Tenant.lastSyncAt` is `null` everywhere and the offline-refusal
  path is proven by tests and SQL, not by observed traffic.

## 5. Acceptance criteria — status

| Criterion (from the pack)                                                               | Status                | Evidence                                                                                                                                 |
| --------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant registration + provisioning + initial owner assignment                           | Done                  | `createTenantAction`, `tenant-provisioning.ts`, `assignTenantOwnerAction` (invitation-only), tests                                       |
| Search, filters, pagination                                                             | Done                  | `searchTenants` + `tenantSearchSchema` (q/status/planId/page/pageSize), filter-preserving `pageHref`, tests                              |
| Manual activation / suspension / reactivation with mandatory reason + confirmation      | Done                  | `TENANT_STATUS_TRANSITIONS`, `statusTransitionSchema` (reason 3–500), `TenantLifecycleActions`                                           |
| Status transitions server-side, permission checked per request, status + audit atomic   | Done                  | `transitionTenantStatus()` single `$transaction`; battery proves the guard trigger refuses a non-platform context                        |
| Suspension preserves records and does not delete storage objects                        | Done                  | migration contains no cascade/delete of tenant rows or storage; battery asserts rows survive suspension; §4.1 of the security model      |
| Suspended tenant denied online writes + sync writes; sessions/downloads/offline defined | Done                  | §4.1 + `provider-console.md` §10; `tenant.writeDenied` / `sync.rejected`; reads and downloads allowed                                    |
| No offline propagation claim                                                            | Done                  | indicator comments, `offlineNote` UI copy, and the docs state the limitation explicitly                                                  |
| Dedicated platform route + separate guard                                               | Done                  | `/admin/*` layout with `authorizePlatform`, `executeProviderWrite`, `tenant_provider_columns_guard_update`                               |
| Preview of quotations, invoices, delivery notes                                         | Partial (by decision) | branding preview shells; true per-document preview is Phase 05 (#13)                                                                     |
| Schema supports tenant self-service branding later without template changes             | Done                  | provider edits use the same `updateTenantBrandingSchema`/`toBrandingPatch` as the tenant path; `business.branding.update` already exists |
| Operational indicators                                                                  | Done                  | three columns + narrow writers + panel; honest `null` handling                                                                           |
| Status history + audit logs                                                             | Done                  | `TenantStatusHistory` (append-only), `platform.audit.read`-gated trail                                                                   |
| Tests, migrations, UI, administrator documentation, verified transition list            | Done                  | §2, §4; `../administration/provider-console.md` §4                                                                                       |

## 6. Limitations and follow-ups (carried, not hidden)

1. **Migration 11 is unapplied to the live project** — owner-gated deploy, then
   `prisma migrate status` must show 11/11 with no drift.
2. **#38** operator password + `APP_DATABASE_URL` → `pnpm db:assert-rls`; until
   then read every enforcement claim as "proven offline".
3. **#37** fold the Phase 1 + Phase 2 scratch batteries into a committed,
   CI-wired DB harness, add the code↔database catalog parity test (42 rows), and
   run the eight required proofs; the 13 skips are its placeholder.
4. **#36** Supabase Storage for logos (provider-side upload is still open; the
   branding panel deliberately does not accept a logo).
5. **Phase 05 (#11–#15)** remains gated by the directive until #37/#38 pass.
6. **No email transport:** owner invitations are recorded, not delivered, and the
   UI says so; production registration must stay disabled.
7. **No rate limiting behind the console** (distributed store is a Phase 08 item)
   and no bulk lifecycle operations by design.
8. **Uncommitted:** the whole Phase 2 surface plus the earlier foundation and
   Phase 1 work await the owner's commit decision (#30).

## 7. Next phase

Phase 2 is complete against its own criteria. Per the orchestrator's ordering and
the Phase 1 directive gate, the next work is **not** business features: #38 → #37
(then the Phase 05 gate can open), with #36 alongside. Phase 3 begins once the
owner authorizes the commit and the DB-backed proofs exist.
