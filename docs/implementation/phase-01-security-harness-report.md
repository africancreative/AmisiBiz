# Phase 1 directive — DB-backed authorization harness (#37a/#37b): report

- **Date:** 2026-10-15
- **Tasks:** #37a (committed batteries + clean-room driver) and #37b (the rewrite
  of `apps/web/tests/integration-security.test.ts` into a real RLS harness).
  Remaining inside #37: #37c automated bundle scan (task #48) and #37d the CI
  Postgres service (task #49).
- **Governing directive:** _"Do not begin business feature development until the
  core authorization and RLS tests pass."_ and _"Never weaken RLS policies to
  bypass a failing test."_
- **Status:** the harness runs and passes — **25/25** against a disposable
  PostgreSQL, as the role the policies were written for. Nothing in this change set
  alters a policy, a grant or a migration. **The gate is still not satisfied**, for
  reasons that are operational rather than repository (§3).

---

## 1. What was replaced

Before this cycle the evidence for the eight required proofs was:

| Claim                 | Evidence before                                                        | Evidence now                                                                             |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Cross-tenant RLS      | a 67-assertion `psql` battery living in git-ignored `.tmp/` scratch    | `apps/web/prisma/scripts/rls-behavior-battery.sql` (tracked) + 25 harness cases          |
| Chain reproducibility | a hand-run sequence only the operator remembered                       | `scripts/db/cleanroom-chain.sh`, one command, tracked                                    |
| Legacy migration path | none committed                                                         | `prisma/scripts/fixtures/phase1-legacy-fixture.sql` + the migration-11 abort probe       |
| Integration suite     | `integration-security.test.ts` self-skipped; "integration" was a label | same file, real DB, 25 cases, still self-skipping only when `TEST_DATABASE_URL` is unset |

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

## 6. Why the gate still holds

The harness proves the **schema**. It does not prove the **deployed app**, because
`amisibiz_app` has no password and `APP_DATABASE_URL` is unpublished: the running
application would connect as the owner, which bypasses RLS entirely. That is task
#38, it is owner-gated, and no amount of local green changes it. On top of that,
proof 8 has no automated check (#37c), nothing runs any of this on a push (#37d),
the two §4 findings are unfixed, and the repository cannot pass `type-check` or
`build` while the untracked Phase 05 code is in the tree.

So the accurate statement is: _the core authorization and RLS tests now exist and
pass against a real database; the directive's gate is not yet met, because the
verification that reaches production is #38 and the business code that would pass
through the gate does not compile._ The decision on Phase 05 / Phase 3 work is the
owner's, recorded as task #52.

## 7. Next, in order

1. **#38 operator step** — set the `amisibiz_app` password out of band, publish
   `APP_DATABASE_URL`, run `pnpm db:assert-rls`, then the live probes **only with
   the owner's go-ahead**. Rotate the credential block pasted into chat earlier.
2. **Apply migration 11** to the live project once #38 is green; it then joins the
   frozen set.
3. **#37c** bundle scan (#48) and **#37d** CI Postgres service (#49).
4. **#50/#51** the two follow-up migrations this harness earned.
5. **#52** owner decision on the untracked Phase 05 code, then the Phase 3 gap
   table, then the remaining phases toward the MVP.
