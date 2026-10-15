# Phase 1 directive — DB-backed authorization harness, bundle scan and CI security job (#37a–#37d, #50/#51): report

- **Date:** 2026-10-15
- **Tasks:** #37a (committed batteries + clean-room driver) and #37b (the rewrite
  of `apps/web/tests/integration-security.test.ts` into a real RLS harness).
  #37c (the automated bundle scan) and #37d (the CI `security` job) closed in the
  same cycle; their evidence is §5.2. The two migrations this harness earned,
  #50 and #51, are §5.3.
- **Governing directive:** _"Do not begin business feature development until the
  core authorization and RLS tests pass."_ and _"Never weaken RLS policies to
  bypass a failing test."_
- **Status:** the harness runs and passes — **26/26** against a disposable
  PostgreSQL, as the role the policies were written for. Twenty-five cases came out of
  #37b; the twenty-sixth, "a support window is the same instant in every session
  timezone", is the regression that earned migration #51, and migration #50's fence is
  proven inside "a support grant reads the granted workspace only, and never writes".
  Nothing in the
  #37a/#37b change set altered a policy, a grant or a migration — the two later
  migrations (§5.3) are additive tightenings, each proven by a case that fails without
  it. **The gate is still not satisfied**, for
  reasons that are operational rather than repository (§3).

---

## 1. What was replaced

Before this cycle the evidence for the eight required proofs was:

| Claim                 | Evidence before                                                        | Evidence now                                                                                                    |
| --------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Cross-tenant RLS      | a 67-assertion `psql` battery living in git-ignored `.tmp/` scratch    | `apps/web/prisma/scripts/rls-behavior-battery.sql` (tracked, 72 assertions on the full tree) + 26 harness cases |
| Chain reproducibility | a hand-run sequence only the operator remembered                       | `scripts/db/cleanroom-chain.sh`, one command, tracked                                                           |
| Legacy migration path | none committed                                                         | `prisma/scripts/fixtures/phase1-legacy-fixture.sql` + the migration-11 abort probe                              |
| Integration suite     | `integration-security.test.ts` self-skipped; "integration" was a label | same file, real DB, 26 cases, still self-skipping only when `TEST_DATABASE_URL` is unset                        |

## 2. What the harness actually does

It connects as the **table owner** only to build fixtures (two active tenants, one
suspended, one spare; eight users spanning every relevant role; memberships, an
active `SupportAccessGrant`, contacts, an item), then every assertion runs inside
`owner.$transaction` after `SET LOCAL ROLE amisibiz_app` and
`public.set_tenant_context(...)`. Both are transaction-local, so no role or context
leaks between cases, and a policy violation aborts only its own transaction.

Safety properties, verified rather than asserted in prose:

- `FORBIDDEN_HOSTS` refuses any `TEST_DATABASE_URL` matching `*.supabase.co`, the
  Supavisor pooler host, or the live project ref. The suite will not run against
  the shared project even if told to.
- It migrates the disposable database itself, pinning **both** `DATABASE_URL` and
  `DIRECT_URL` to `TEST_DATABASE_URL` — `prisma migrate deploy` otherwise resolves
  `DIRECT_URL` from `apps/web/.env`, which is the production pooler
  (`RUNBOOK.md` §4.3). A migration failure throws; the suite never runs against a
  partial schema.
- It pins the disposable database timezone to UTC so it measures the production
  posture instead of a +03 laptop (`§13.7` finding 2).
- `afterAll` pauses `tenant_members_guard_delete` inside `try/finally`, deletes the
  fixture rows, and re-enables it. Measured afterwards: `tenants=0 users=0
grants=0 foreign=0`.

## 3. The eight required proofs, and where each one is now discharged

| #   | Proof                                                 | Harness case(s)                                                                                                                                          |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Anonymous caller cannot reach private tenant data     | `roles that are not the runtime role hold no privileges` (+ role attributes: no superuser, no `BYPASSRLS`, `NOINHERIT`)                                  |
| 2   | Tenant A cannot read Tenant B                         | `a tenant sees its own rows and none of another tenant's`, `with no tenant context at all, nothing is visible and nothing is writable`                   |
| 3   | Tenant A cannot mutate Tenant B                       | `another tenant's rows cannot be mutated or deleted`, `INSERT into another tenant is refused by the WITH CHECK`, `a member's own writes do land`         |
| 4   | A viewer cannot issue documents                       | `a VIEWER can read its workspace and cannot write business records` — the issuance flow itself is still Phase 05 work                                    |
| 5   | A portal user cannot access internal business records | `a customer-portal seat cannot write and cannot read internal records` — document/PDF scoping is still Phase 05 work                                     |
| 6   | Users cannot elevate their own role                   | `a member cannot grant themselves a platform role`, `cannot escalate their own tenant role`, `a tenant cannot move its own lifecycle status`             |
| 7   | Tenant ids cannot be manipulated to bypass RLS        | `forging the tenant GUC … gains nothing`, `a claimed platform-admin flag is re-derived, not trusted`, `set_tenant_context refuses a malformed tenant id` |
| 8   | Privileged credentials absent from client bundles     | **not here** — this is a database harness; the automated scan is #37c (task #48)                                                                         |

Plus cases that are not among the eight but close the same gaps: the Phase 2
suspension split (reads preserved / writes denied / the provider branch still
allowed), the support-grant read path (reads the granted workspace, never an
ungranted one's rows, and never writes), `AuditLog` append-only enforced by grant,
least privilege over a table created _after_ the migrations by a foreign
application, catalog parity (42) and role→matrix parity (116, `SUPPORT` = 0, no
`platform.*` in any tenant role), and `Plan` holding no entitlement columns.

## 4. Findings — recorded, not silenced

No policy, grant or migration was changed anywhere in this work. Three behaviours
surfaced and each was diagnosed to its real cause:

1. **Support access is fenced by the grant, not by the active context.**
   `has_tenant_read_access()` ORs in `is_platform_support() AND
has_support_grant(p_tenant_id)` without also requiring
   `p_tenant_id = current_tenant_id()`, so a SUPPORT session's tenant label is
   advisory at row level. Not a cross-tenant leak; still a honesty problem for
   audit context. Fix belongs in a **new** migration (task #50), deliberately
   deferred: migrations 1–11 are frozen and the owner's sequence runs #38 → apply
   11 → #37 before further SQL ships.
2. **`timestamp(3) WITHOUT TIME ZONE` window columns are session-timezone
   sensitive.** This — not a GUC problem — was why the support-grant case first
   read zero rows on a `Africa/Nairobi` cluster: every Prisma-written window looked
   three hours shorter. The harness pins UTC; the column type change is task #51.
3. **Two battery FAILs when the clean-room driver was extended to migration 12**
   (`T2L-a platform tenant visibility: 5 (expect 2)`, `T2L-b … 4 (expect 2)`).
   Cause established by querying the database rather than assumed: step 12's Phase 2
   fixtures (`p2-active`, `p2-pending`, `p2-suspended`) and their contacts are still
   present when step 13 re-runs the Phase 1 battery. Migration 12 touches no policy
   — it adds `Contact.portalUserId`, a `SET NULL` FK and a unique index. The
   assertion was corrected to the invariant it was always trying to state: snapshot
   the owner's unfiltered totals (an owner bypasses RLS) and require the platform
   role to match them exactly, with a `>= 2` floor so an empty database cannot pass
   vacuously. One hidden row or one over-reachable row still fails.

## 5. Verification actually performed

Every count in §5.1–§5.2 is the run as it happened at that moment — the 25-case
harness and the 67-assertion battery predate §5.3's two migrations, and the 337/12-file
run predates the parking decision that took the business tests off `main`. The numbers
for the current tree are the final table in §5.3.

| Command                                                                                         | Result                                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `TEST_DATABASE_URL=… pnpm --filter @amisibiz/web vitest run tests/integration-security.test.ts` | 25 passed / 0 failed — twice on the same rebuilt DB, once on a brand-new one  |
| teardown probe on `p37_harness2`                                                                | `tenants=0 users=0 grants=0 foreign=0`                                        |
| `PGHOST=localhost PGPORT=55499 PGUSER=postgres sh scripts/db/cleanroom-chain.sh p37_chain3`     | 78 · 67 · 67 · 55 · 67 PASS, **0 FAIL**; migration-11 abort probe fires       |
| `pnpm turbo run test:run` (no database)                                                         | 337 passed / 25 skipped, 12 files passed, 1 skipped                           |
| `pnpm turbo run lint --filter='@amisibiz/web' --force`                                          | 0 errors; 6 warnings, all in untracked business files + the known `<img>`     |
| `pnpm turbo run type-check`                                                                     | **red** — 10 errors, all inside the untracked Phase 05 document UI (task #52) |
| live Supabase project                                                                           | **untouched** — 10 applied, 11 pending, zero business data, no probe run      |
| CI on GitHub                                                                                    | **never executed** (nothing pushed)                                           |

Those two rows describe the **working tree as it stood during the work**, which
included a body of untracked Phase 03/05 business code. After the owner's decision
on that code (§5.1) the same commands were re-run on `main` and the numbers moved,
because the business test suites and their type errors left the tree with it:

| Command on `main` after parking                                                    | Result                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm turbo run lint type-check test:run --force`                                  | 17/17 tasks successful, **256 passed / 25 skipped** (10 files passed, 1 skipped), 0 errors |
| `pnpm build`                                                                       | green (exit 0)                                                                             |
| `pnpm format:check`                                                                | green                                                                                      |
| `TEST_DATABASE_URL=… vitest run tests/integration-security.test.ts` on `p37_main1` | **25 passed** — re-verified against `main`'s schema, i.e. migrations 1–11 without 12       |
| `sh scripts/db/cleanroom-chain.sh p37_main2`                                       | 78 · 67 · 67 · 55 · 67 PASS, **0 FAIL**; step 13 finds no later migration and steps down   |

`apps/web/.next` was deleted once in that sequence: `tsc` was reporting nine
errors from stale route-type files for API routes that only exist on the parked
branch, not from any tracked source.

### 5.1 The business-feature tree was parked, not merged

The owner chose _move it off main_ for the untracked Phase 03/05 body (task #52).
It now lives on branch `wip/phase05-business-features` as commit `0a67b69`, a
56-file parking record covering the document services, PDF writer, calculations,
numbering and snapshot builder, the document/dashboard UI, the portal and platform
logo routes, three business test suites, `schema.prisma`'s portal-linkage change
and migration `20261020000000_phase05_portal_linkage`.

That commit is explicitly labelled a parking record, not an approval: the code does
not compile (`document-detail-client` is imported by `documents/[id]/page.tsx` and
exists nowhere in the repository), it has never passed a gate, and the live project
has never seen migration 12. Landing it on `main` requires an owner waiver of the
Phase 1 directive **and** a full green gate run over corrected code. `main` is now
the verified tree — which is what makes the table above trustworthy.

### 5.2 #37c and #37d — the automation half, and its local dress rehearsal

Two more pieces of #37 landed on the same tree, both repository-side:

- **#37c — `scripts/security/scan-client-bundles.mjs`** (`pnpm check:bundles`, wired
  into `ci.yml` after the build). Proof 8 stops being a review claim: the script walks
  `apps/web/.next/static` and `apps/web/.next/server` and fails on a `sb_secret_*`
  value, a decodable service-role JWT, a `"service_role"` literal, a Postgres URL with
  an embedded password, or inlined `SUPABASE_JWT_SECRET` material. It carries no real
  credential (structural patterns only) and prints redacted excerpts.
- **#37d — the `security` job in `.github/workflows/ci.yml`.** A runner-local
  PostgreSQL 16 service, then the committed chain, a log-verdict gate, the 26-case
  harness, and three SQL assertions that the environment the proofs depend on was
  actually present (`amisibiz_app` exists with `NOINHERIT` and no `BYPASSRLS`,
  `Permission` = 42, `Tenant` = 0 after teardown).

Because the workflow cannot run until something is pushed, every line of that job was
executed locally as a dress rehearsal instead — against the same disposable cluster
`docs/RUNBOOK.md` §5 describes:

| CI step, as written                                                                                                  | Local result                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sh scripts/db/cleanroom-chain.sh <db>` (fresh database)                                                             | exit 0 — 78 · 67 · 67 · 55 · 67 PASS, 0 FAIL, migration-11 abort probe fires, step 13 a no-op on `main`                 |
| the battery verdict gate (`grep FAIL` + PASS floors)                                                                 | green on those logs; **exit 1** with a planted `(FAIL)` verdict line; **exit 1** naming the file when a log is empty    |
| `pnpm --filter @amisibiz/web exec vitest run tests/integration-security.test.ts` against a **non-existent** database | **25 passed / 0 failed** (4.8s) — which also proves Prisma's `migrate deploy` creates the database the URL names        |
| the three SQL assertions                                                                                             | all three return their `OK:` branch: role is `NOINHERIT` without `BYPASSRLS`, catalog = 42, `Tenant` = 0 after teardown |
| `pnpm check:bundles` on the real build                                                                               | 178 files / 5.1 MB scanned, clean                                                                                       |
| `check:bundles` against four planted credential-shaped fixtures                                                      | exactly those four findings; the `postgresql://<user>:<password>@` placeholders stay unflagged                          |

The rehearsal caught two things the written workflow would have got wrong, both fixed
here rather than left for a red CI run:

1. `phase02-migration-checks.sql` ended with an echo line whose text contained the
   literal word the gate greps for. Every CI run would have failed on a green battery.
   The trailer is now wording-free, and the file carries a comment saying why.
2. `grep -c` exits non-zero when it finds nothing, so under `set -e` a truncated or
   empty battery log aborted the step silently instead of reporting which log came up
   short. The count is now taken with `|| true` and the floor comparison produces the
   `::error::` line.

What the rehearsal **cannot** substitute for: the runner image is Ubuntu with
PostgreSQL 16, the local cluster is PostgreSQL 18.4 on Windows, and no Docker is
available here to try 16. No statement in the migrations or the batteries uses a
construct newer than the features Supabase itself runs on (checked for `MERGE`,
`json_table`, `NULLS NOT DISTINCT`, relation access methods), so the expectation is
that 16 behaves the same — but that is reasoning, not a run, and it is stated as such.

### 5.3 #50 and #51 — the two findings became migrations

Both §4 findings are now closed in the schema, each with a test that would fail
without it. Two migrations land **after** the frozen 1–11 set, dated deliberately
past the parked branch's `20261020000000` so no ordering collision appears if that
branch ever lands:

- **`20261021000000_phase1_support_read_access_scoped_to_context`** (#50) adds
  `AND (current_tenant_id() IS NULL OR p_tenant_id = current_tenant_id())` to the
  SUPPORT disjunct of `has_tenant_read_access()`. The no-context case stays open
  because the provider console lists the workspaces a support user may enter before
  entering any of them; per-workspace reads go through
  `authorizePlatformTenant(...)`, which sets that tenant's context, so they are now
  fenced at row level too. This is a tightening — no policy was dropped and no
  grant widened.
- **`20261021000001_phase1_support_and_invitation_windows_are_instants`** (#51)
  converts `SupportAccessGrant.expiresAt/revokedAt/createdAt` and
  `Invitation.expiresAt/acceptedAt` to `timestamp(3) WITH TIME ZONE`
  (`USING <col> AT TIME ZONE 'UTC'`, which reads the stored naive UTC wall time as
  the instant it always meant). `SupportAccessGrant`'s two CHECKs are dropped and
  re-added unchanged, because a mixed-type comparison would reintroduce the same
  session-dependence. `Invitation.createdAt/updatedAt` stay as they are — nothing
  in SQL compares them to an instant, and a security fix should not widen itself.

Evidence, all on the disposable cluster:

| Check                                                                         | Result                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm migrate deploy` to a fresh database, migrations 1 → #51                 | all applied; `prisma migrate diff` to `schema.prisma` prints exactly `-- This is an empty migration.`                                                                                                    |
| `sh scripts/db/cleanroom-chain.sh p37_final`                                  | 78 · **71 + 1 SKIP** · **71 + 1 SKIP** · 55 · **72**, 0 FAIL; step 13 applies both new migrations then re-runs the battery                                                                               |
| the chain's T9j at steps 8/11                                                 | `grant on A, context B: 1 (SKIP — pre-fence schema; grant still bounds it to 1) OK` — the frozen chain really is still loose at that stage                                                               |
| the same battery after step 13                                                | `T9j … : 0 (expect 0) PASS`, plus T9i–T9m: the fence, the grant-only listing and the cleanup                                                                                                             |
| harness on a database carrying #50 + #51                                      | **26 passed / 0 failed**                                                                                                                                                                                 |
| final re-run on this tree (`p37_gates`, fresh database)                       | **26 passed / 0 failed**; `lint` + `type-check` + `test:run --force` 17/17 tasks, **256 passed / 26 skipped**; `pnpm build` green; `pnpm check:bundles` clean (178 files / 5.1 MB); `format:check` green |
| the new timezone case with `20261021000001` temporarily removed from the tree | **fails** — `expected [] to deeply equal [Array(1)]`: a +03 session reads a live 60-minute grant as expired                                                                                              |
| the same case with the migration restored                                     | passes                                                                                                                                                                                                   |

The last three rows are the point. The finding that support windows shifted by the
session offset was observed first as an unexplained zero-row read; it is now a
committed case that measures the same fixture in `UTC` and in `Africa/Nairobi` and
requires them to agree, and it demonstrably distinguishes the two schemas. The
harness still pins its disposable database to UTC (the production posture), so this
case is what stops that pin from hiding the class of bug again.

Two consequences are worth naming rather than burying: the battery's PASS count
moved 67 → 72, so `ci.yml`'s floors and `RUNBOOK.md` §4.3 moved with it; and the
battery now needs to be told which schema it is measuring (`PGOPTIONS
-c app.support_context_fenced=…` in the driver, defaulting to "the current tree" for
a hand-run) — otherwise a historical probe of the frozen chain would report the
loose branch as a fresh failure.

## 6. Why the gate still holds

The harness proves the **schema**. It does not prove the **deployed app**, because
`amisibiz_app` has no password and `APP_DATABASE_URL` is unpublished: the running
application would connect as the owner, which bypasses RLS entirely. That is task
#38, it is owner-gated, and no amount of local green changes it. Proof 8 now has its
automated check and the CI job that would run everything on a push exists (#37c/#37d,
§5.2) — but that job has never executed, because nothing has been pushed, and the two
§4 findings, while **fixed by migrations in the repository** (§5.3), are not applied to
the live project, which still runs the pre-`20261021000000` behaviour.

So the accurate statement is: _the core authorization and RLS tests now exist, they
pass against a real database on the same tree the gates are green on, and the
directive's gate is still not met, because the verification that reaches production
is #38._ The owner's direction for this cycle is to hold the gate: finish the
repository-side work (#37c, #37d, the two owed migrations #50/#51) and hand over
the #38 operator procedure, rather than open Phase 3–8 business work.

## 7. Next, in order

1. **#38 — execute `../administration/rls-activation-operator-procedure.md`.** The
   runbook is now written out step by step (§5 of this report is the repository half;
   that file is the operational half): preflight queries, rotation of the credential
   block pasted into chat earlier, the out-of-band `amisibiz_app` password,
   `APP_DATABASE_URL`, `pnpm db:assert-rls`, the three pending migrations in
   dependency order, the post-apply probes, and the conditions to stop on. **None of it
   has been executed** — every live step needs the owner's go-ahead.
2. **Apply migration 11** to the live project once #38 is green; it then joins the
   frozen set, followed by `20261021000000` and `20261021000001` in the same
   `migrate deploy`.
3. **#37c** bundle scan (#48) and **#37d** CI Postgres service (#49) — **both landed
   and locally rehearsed (§5.2)**. #37 itself closes when the push happens and the
   `security` job runs green, not before.
4. **#50/#51** — **landed** (§5.3): authored, applied to throwaway databases end-to-end,
   and each covered by a harness case that fails without it. Applying that SQL to the
   live project is item 1's step 8, owner-gated.
5. **#52 is closed** (2026-10-15): the business-feature tree is parked on
   `wip/phase05-business-features`. Reopening Phase 3–8 work — the gap table in
   §8 — is a gate decision, not a coding decision.

## 8. Phase 3 gap table, as verified against the parked tree

Recorded so the eventual gate decision is informed rather than guessed. Phase 3
("business workspace, CRM and items") is largely already delivered; the gaps are
small and mostly schema. All of it is gated while the directive stands.

| Requirement                                                        | State                | Gap                                                                                                                        |
| ------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Dashboard overview, recent documents, outstanding, counts, account | Implemented (branch) | `server/actions/dashboard.ts` + `components/dashboard/`; outstanding does not yet net payments applied                     |
| Quick document creation                                            | Partial              | dashboard links to lists only; the `/documents/new` target does not compile                                                |
| Empty states and validation errors                                 | Partial              | present everywhere except the broken document UI                                                                           |
| CRM fields, archive, search, pagination, create/view/edit          | Implemented          | —                                                                                                                          |
| KRA PIN **or business registration information**                   | Partial              | `taxPin` exists; there is **no business-registration-number field anywhere** — schema + validation + UI                    |
| Internal notes invisible to portal users                           | Implemented          | portal seat holds 2 permissions; `Contact.notes` never selected on a portal path; DB-backed proof in the harness           |
| Items catalogue with exact decimals and dual validation            | Implemented          | —                                                                                                                          |
| `contact_items` customer code/description/price/discount           | Partial              | **no unit-of-measure column and no validity dates** (`validFrom`/`validTo`) — a migration, not UI work                     |
| Cross-tenant relationship prevention                               | Implemented          | FKs + `@@unique([tenantId, contactId, itemId])` + single-tenant trigger + server-side re-check of both sides               |
| Catalogue → line snapshot (copy, never recalculate)                | Implemented          | `catalogue-line.ts` → `documents/lines.ts`; issued columns frozen                                                          |
| SQLite-ready repository ports                                      | Partial              | ports exist, **no adapter implements them**; `apps/web` calls Prisma directly                                              |
| Tests for the above                                                | Partial              | search/pagination/relationship-integrity/permissions are mocked-Prisma only; no DB-backed test for `ContactItem` integrity |
