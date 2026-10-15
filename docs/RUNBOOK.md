# AmisiBiz — Operations Runbook

- **Status:** Current as of Phase 1 (authorization + RLS), 2026-10-14.
- **Audience:** whoever deploys, migrates, or operates an AmisiBiz environment —
  including the person who has never seen this codebase.
- **Companion docs:** `architecture/security-model.md` (what is enforced and
  where), `architecture/permission-matrix.md` (who may do what),
  `implementation/phase-01-security-design.md` (why the schema looks like this).

This runbook describes **operations**: the environment variables a real
deployment needs, how to turn row-level security on, how to prove it is on, and
what to do when something looks off. It deliberately separates _what the code
guarantees_ from _what an operator must still do_ — several protections in this
repository are inert until a human performs a step, and section 3 is that step.

> **Honesty rule that governs this whole document:** nothing here was verified
> against a production deployment. Section 4 lists exactly which checks have
> been run and which have not. Do not report a step as done because the file
> for it exists.

---

## 1. Environment variables

The authoritative, annotated list is `apps/web/.env.example`. Copy it to
`apps/web/.env` (git-ignored) and fill in real values. Load order, verified
rather than assumed:

| File                  | Read by                                                                                      | Precedence |
| --------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| `apps/web/.env`       | Next.js, the Prisma CLI, and the seed (`prisma/seed.ts` calls `process.loadEnvFile(".env")`) | base       |
| `apps/web/.env.local` | Next.js only                                                                                 | overrides  |
| Real process env      | everything                                                                                   | overrides  |

That matters operationally: **a variable set only in `.env.local` is invisible
to `prisma migrate`, `prisma db seed` and `pnpm db:assert-rls`.** Database and
role variables belong in `apps/web/.env`.

Grouped by purpose:

| Variable                                         | Purpose                                                                                       | Must be secret | Set for local dev |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------- | ----------------- |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_NAME`    | Absolute URLs and branding shown to users                                                     | no             | yes               |
| `APP_BASE_DOMAIN`, `NEXT_PUBLIC_APP_BASE_DOMAIN` | Tenant hostname routing (`<slug>.<base>`); leave unset to disable routing                     | no             | usually unset     |
| `TRUST_PROXY`                                    | Whether `X-Forwarded-Host` may be trusted at all                                              | no             | `false`           |
| `DATABASE_URL`                                   | **Owner/administrator** connection — Prisma CLI only                                          | **yes**        | yes               |
| `DIRECT_URL`                                     | Session-mode owner connection — `prisma migrate` uses this one                                | **yes**        | yes               |
| `APP_DATABASE_URL`                               | **Runtime** connection as `amisibiz_app` — the only one RLS applies to                        | **yes**        | optional (§3)     |
| `NEXT_PUBLIC_SUPABASE_URL`                       | Supabase project URL (browser-safe half)                                                      | no             | yes               |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`           | `sb_publishable_*` — browser-safe                                                             | no             | yes               |
| `SUPABASE_SECRET_KEY`                            | `sb_secret_*` — server-only admin/API key                                                     | **yes**        | yes               |
| `EMAIL_PROVIDER`, `SMTP_*`, `EMAIL_FROM`         | Email transport; **no transport is implemented**, so verification/reset mail is not delivered | **yes**        | unset             |
| `REQUIRE_EMAIL_VERIFICATION`                     | Enforce verified emails at sign-in; requires a working transport                              | no             | `false`           |
| `SEED_PLATFORM_ADMIN_*`, `ALLOW_PROD_SEED`       | Platform-admin bootstrap; the seed does nothing unless these are set                          | **yes**        | optional          |

Two rules that come from the constitution and are enforced in code, not
convention:

- `sb_secret_*` never appears in a client bundle, a log line, or an error
  message. Only `NEXT_PUBLIC_*` values may reach the browser, and the browser
  never constructs a Supabase client that could hold a secret.
- Never seed production with default credentials. `ALLOW_PROD_SEED` exists so
  that a production seed is an explicit, reviewed act.

---

## 2. Two database connections, deliberately not interchangeable

The same PostgreSQL project is reachable through two identities, and choosing
the wrong one silently disables the security model:

- **Owner role** (`DATABASE_URL` / `DIRECT_URL`, Supabase `postgres`): holds
  every privilege and **bypasses row-level security**. Valid uses: `prisma
migrate*`, `prisma db seed`, `prisma studio`. Nothing else.
- **Application role** (`APP_DATABASE_URL`, `amisibiz_app`): `NOINHERIT`, no
  `BYPASSRLS`, privileges granted table-by-table by migration
  `20261018000002`. Because it is subject to the policies, the policies decide
  what any statement can see.

`packages/database/src/client.ts` resolves this and its behaviour is the
contract:

1. `APP_DATABASE_URL` set → use it.
2. Unset, **not** production → fall back to `DATABASE_URL` and print one loud
   warning. This is a development convenience, not a security posture.
3. Unset, production → **refuse to boot**. Running as the owner role would
   make every RLS policy decorative; an unavailable service beats an unprotected
   one.

Practical consequence: an RLS-related bug can never be reproduced through the
owner connection. If you are testing authorization, you must be connected as
`amisibiz_app`, and section 3 has to be finished first.

---

## 3. Turning RLS on (operator step — required, not yet performed)

The schema, the policies, the grants and the code path all exist. What does not
exist yet is a password for `amisibiz_app`: migration `20261013000001` creates
the role **password-less on purpose**, so that no placeholder secret can ever be
committed. Until an operator sets a strong password out of band and publishes
`APP_DATABASE_URL`, production either runs as the owner role (dev fallback) or
refuses to boot.

Perform this as a sequence, in a SQL console authenticated as the project owner
(Supabase → SQL Editor) — never through the application. The full walkthrough, with
the read-only preflight queries, the credential-rotation step, exact connection
strings, the expected output of every probe and the abort conditions, is
`administration/rls-activation-operator-procedure.md`; the summary below and that
document must stay in step with each other:

1. **Generate** a password locally, out of band: `openssl rand -base64 32`.
   Store it in the deployment secret manager. Do not paste it into the
   repository, an issue, a chat log, or a commit message.
2. **Set it** — §1 of `apps/web/prisma/scripts/setup-app-role.sql`:
   `ALTER ROLE amisibiz_app PASSWORD '<the-generated-secret>';`
3. **Publish** `APP_DATABASE_URL` with that role and password (see the
   connection-string template in §11 of the same script), then deploy.
4. **Verify the least-privilege end state** by running §2–§9 of
   `setup-app-role.sql`. Those blocks are checks, not grants: the script
   intentionally grants nothing, because re-granting by hand would re-open the
   default-privilege path that migration `20261018000002` closed. Any warning
   printed there is drift to investigate before continuing.
5. **Prove enforcement** with `pnpm db:assert-rls` (section 4.2). Exit `0` is
   the only acceptable result after step 3.
6. **Then, and only then, apply the pending migrations** (section 5) with both
   `DATABASE_URL` and `DIRECT_URL` pinned, and re-run `pnpm db:assert-rls`.
   Enforcement first, schema second: if the app cannot be proven to connect as the
   role the policies were written for, a new migration just widens the unproven area.

The runtime uses the transaction-mode pooler (port 6543). The tenant context is
five **transaction-local** GUCs (`set_config(..., true)` inside a Prisma
`$transaction`), which is the pooling-safe form: the setting cannot leak onto a
connection that another request later reuses. `packages/database/src/scope.ts`
is the only writer, and it is fail-closed — a query that needs a tenant context
without one raises `ScopeNotSetError` instead of silently seeing everything.

---

## 4. Verification: what proves what

### 4.1 Repository gates (safe anywhere; the database is mocked)

```
pnpm format          # prettier --write
pnpm lint            # eslint across the workspace
pnpm type-check      # tsc --noEmit across the workspace
pnpm test:run        # vitest: unit + security suites, Prisma mocked
pnpm build           # next build
```

These are the standing end-of-phase gate. They prove types, lint cleanliness,
and that the authorization helpers behave correctly **against a mock**. They do
not prove that PostgreSQL policies work: the mock never enforces anything. The
required cross-tenant proofs (Phase 1 directive) live in the DB-backed harness,
`apps/web/tests/integration-security.test.ts`, which the ordinary gate runs
**skip** rather than fail when no database is configured — so a green
`pnpm test:run` alone still does not mean "RLS verified". Run it explicitly
against a disposable database (see §4.3 and §5):

```sh
# from the repository root — note `exec`: `pnpm --filter @amisibiz/web vitest run …`
# fails with ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT because there is no `vitest` script
# to forward to. `127.0.0.1`, not `localhost`: see the dual-listener trap in §4.3.
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55499/<freshdb> \
  pnpm --filter @amisibiz/web exec vitest run tests/integration-security.test.ts
```

The harness refuses any URL that looks like the shared Supabase project, migrates
the disposable database itself (pinning both `DATABASE_URL` and `DIRECT_URL`, §4.3
trap), builds fixtures as the table owner and then runs every assertion inside
`SET LOCAL ROLE amisibiz_app`. 26 cases currently pass; without
`TEST_DATABASE_URL` the suite reports 26 skipped.

### 4.2 Live probes (touch a real project — get explicit go-ahead first)

| Command                                                                        | What it checks                                                                                                                                                                     | Result meaning                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:assert-rls`                                                           | Which URL the runtime resolved (prints only the _source name_, never the string), whether the role is superuser/`BYPASSRLS`, and whether an empty context reads zero `Tenant` rows | `0` enforced · `1` not enforced · `2` misconfigured or unreachable                                                  |
| `pnpm --filter @amisibiz/web exec tsx prisma/scripts/verify-supabase-auth.mts` | Supabase Auth semantics the auth swap relies on: sign-in → `app_metadata` claim → refresh rotation → ban-based session kill → unban, on a disposable user that is deleted again    | creates and removes an `auth.users` row — never run against a project holding real customer accounts without review |

Both scripts log only `error.name`: Prisma connection errors can echo host,
port and sometimes the whole connection string.

### 4.3 Offline migration verification (scratch cluster — the mandatory path)

New or edited migrations are verified on a throwaway local PostgreSQL cluster
before any shared database is touched. The whole chain is scripted and committed:

```sh
# throwaway cluster on a non-default port, trust auth (e.g. 55499)
PGHOST=localhost PGPORT=55499 PGUSER=postgres sh scripts/db/cleanroom-chain.sh <db>
```

`scripts/db/cleanroom-chain.sh` drops and recreates `<db>`, applies migrations
1–7, proves the PRE-remediation leak with a foreign table, loads
`apps/web/prisma/scripts/fixtures/phase1-legacy-fixture.sql`, applies 8–10, runs
the POST probes, then `phase01-migration-checks.sql` (78 PASS),
`rls-behavior-battery.sql` as `amisibiz_app` (71 PASS + 1 labelled SKIP), the
migration-11 **abort** probe, migration 11 after an operator NULLs the legacy
`planId`, the Phase 1 battery again as the regression check on top of 11 (71 PASS +
1 labelled SKIP), `phase02-migration-checks.sql` (55 PASS), and finally any
migration newer than 11 that exists in the tree — today `20261021000000` and
`20261021000001` — with the battery re-run once more (**72 PASS**, the SKIP now a
real assertion). Logs land in `.tmp/cleanroom_*`. It speaks raw `psql` rather than
`prisma migrate deploy` precisely because of the `DIRECT_URL` trap below.

The battery is told which schema it is measuring through a session GUC: steps 8 and
11 run with `PGOPTIONS='-c app.support_context_fenced=false'` (the frozen 1–11 chain
still has the unfenced support branch, so case `T9j` prints SKIP while still
bounding the count), step 13 with `=true`. Do not "fix" those SKIPs by loosening a
policy — they are the honest record of a schema that the later migrations tighten.

The manual steps, if you need to do one in isolation:

1. Fresh database → apply migrations 1–7 → add "pre-leak" evidence (a foreign
   table plus its sequence) → apply the legacy-shaped fixture → apply the Phase 1
   migrations 8–10 → run post-conditions.
2. `psql -h localhost -p <port> -U postgres -d <db> -q -f apps/web/prisma/scripts/phase01-migration-checks.sql`
   — every line must report PASS (one SKIP is expected: it covers data shapes the
   fixture does not create).
3. `prisma migrate diff --from-url <scratch> --to-schema-datamodel prisma/schema.prisma --script`
   must print exactly `-- This is an empty migration.`
4. Re-running a checks script against the same database produces spurious diffs
   (some scripts shim `DEFAULT now()` onto `updatedAt`); run each one once per
   freshly migrated database. `rls-behavior-battery.sql` is the exception — it is
   written to be re-runnable (its purge block) and its platform-admin case
   compares against the owner's unfiltered totals rather than a hard-coded count,
   so it stays truthful on a database that also carries the Phase 2 fixtures.

**The trap that makes step 4 and the URL pinning non-optional:**
`prisma/schema.prisma` declares `directUrl = env("DIRECT_URL")`, and
`prisma migrate deploy` migrates through **`DIRECT_URL`**. `npx`/`pnpm` load
`apps/web/.env`, whose `DIRECT_URL` points at the live pooler. Pointing only
`DATABASE_URL` at a scratch database therefore still migrates **production**.
For every local Prisma CLI call, pin **both** URLs:

```
DATABASE_URL=postgresql://postgres@localhost:<port>/<db> \
DIRECT_URL=postgresql://postgres@localhost:<port>/<db> \
  npx prisma migrate deploy
```

**A second trap on the same machine: `localhost` and `127.0.0.1` are not the same
cluster.** On the Windows laptop that runs these batteries, port 55499 has had two
listeners — one bound to IPv6 `localhost`, one to IPv4 `127.0.0.1` — each holding a
different set of databases. `cleanroom-chain.sh` defaults to `PGHOST=localhost`
while the harness examples use `127.0.0.1`, so a "clean" result can describe a
completely different database than the one you then inspected. Confirm which
cluster you are actually talking to before drawing any conclusion from a query:

```sh
psql -h localhost  -p 55499 -U postgres -Atc "SELECT inet_server_addr(), inet_server_port();"
psql -h 127.0.0.1  -p 55499 -U postgres -Atc "SELECT inet_server_addr(), inet_server_port();"
```

### 4.4 Proof 8 — privileged credentials must not reach the client bundle

```sh
pnpm build && pnpm check:bundles   # node scripts/security/scan-client-bundles.mjs
```

Scans `apps/web/.next/static` and `apps/web/.next/server` for a `sb_secret_*`
value, a decodable service-role JWT, a `service_role` literal, a Postgres URL with
an embedded password, and inlined `SUPABASE_JWT_SECRET` material. Structural
patterns only — the script contains no real credential, because a committed copy
would be the leak it hunts. `postgresql://amisibiz_app:<password>@<host>` inside
our own operator-facing error message is deliberately not a finding (placeholder
markers are excluded); planting a real-shaped value into a scanned file is, which
is how this check was validated. CI runs it after the build.

### 4.5 The CI `security` job, and the one rule its batteries must keep

`.github/workflows/ci.yml` has a second job, `security`, that runs after `verify`:

1. a `postgres:16-alpine` service container on `localhost:5432`, superuser
   `postgres` / `ci-only-superuser` — never the application role, and never a
   credential that could reach the shared project;
2. `sh scripts/db/cleanroom-chain.sh ci_chain` — the whole §4.3 chain on the runner;
3. a verdict gate over the logs it produced: any `FAIL` line fails the job, and each
   battery must reach its recorded PASS floor (78 / 71 + 1 SKIP / 71 + 1 SKIP /
   55 / 72 — the last floor rises when `20261021000000` lands, because the SKIP
   becomes a real assertion);
4. the 26-case harness against `TEST_DATABASE_URL` (a fresh `amisibiz_rls` database
   that Prisma's `migrate deploy` creates itself — verified, not assumed);
5. three anti-vacuousness assertions: `amisibiz_app` exists with `NOINHERIT` and no
   `BYPASSRLS`, `Permission` = 42, `Tenant` = 0 after the harness tears down.

**The rule the batteries have to respect:** a `\echo` trailer in
`apps/web/prisma/scripts/*.sql` must not contain the literal word `FAIL`, because step
3 greps the captured output for exactly that marker. `phase02-migration-checks.sql`
used to end by telling the reader to grep the output above for that word, and would
have failed every CI run while the battery itself was green. A verdict line is fine —
`… : FAIL (%)` is what a real failure prints — a reminder about the word is not.

Local status: every step above has been run against the throwaway cluster and each
produced the result documented in
`implementation/phase-01-security-harness-report.md` §5.2 (the job) and §5.3 (the
floors after migrations `20261021000000`/`20261021000001`), including the two failure
modes of the verdict gate (planted `FAIL` line, emptied log). The job has **not** run
on GitHub — there is no push — and the runner is PostgreSQL 16 while the local cluster
is 18.4, so treat "CI green" as unproven until an actual run exists.

Supabase connection facts: reach the project through the Supavisor pooler

(`aws-1-eu-west-2.pooler.supabase.com`) — 6543 with `?pgbouncer=true` for the
app, 5432 session mode for the CLI. The direct `db.<ref>.supabase.co` host is
IPv6-only and unreachable from an IPv4-only machine. `prisma migrate deploy`
onto a non-empty schema that lacks `_prisma_migrations` fails with P3005; the
fix is to pre-create the standard empty `_prisma_migrations` table — **never**
`migrate resolve --applied` / baselining against a shared project.

---

## 5. Migrations: current chain and freeze rule

`apps/web/prisma/migrations/`, applied in order. **Migrations 1–10 are present on
the live project** as of 2026-10-14; migration 11 exists in the repository and is
**not applied there**:

| #   | Migration                                                                   | Delivers                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `20261013000000_init`                                                       | Base multi-tenant schema                                                                                                                                                                                                            |
| 2   | `20261013000001_rls_policies_and_constraints`                               | First RLS policies, partial unique index, invitation-token hashing, `amisibiz_app` role creation                                                                                                                                    |
| 3   | `20261014000000_phase04_branding_contacts_and_catalogue`                    | Branding fields, contact CRM, tax configuration, catalogue, document header                                                                                                                                                         |
| 4   | `20261015000000_phase05_documents_and_numbering`                            | Document engine: headers, lines, payments, status events, per-tenant numbering + counters, issued-document immutability                                                                                                             |
| 5   | `20261015000001_narrow_app_role_on_prisma_bookkeeping`                      | Stops migration 2's blanket default grant from making `_prisma_migrations` writable by the app role                                                                                                                                 |
| 6   | `20261016000000_rls_hardening_auth_tables_and_function_privileges`          | Forward-fix for the RLS defects the Phase 03.5 audit found in migration 2: auth-table policies, function `EXECUTE` grants                                                                                                           |
| 7   | `20261017000000_supabase_auth_alignment`                                    | Identity authority moves to Supabase Auth; the tables backing the retired Auth.js credentials stack are dropped                                                                                                                     |
| 8   | `20261018000000_uuid_identity_and_role_alignment`                           | UUID identities, 9-role remap                                                                                                                                                                                                       |
| 9   | `20261018000001_rbac_catalog_support_access_and_status_history`             | `Permission` / `RolePermission` catalog, `SupportAccessGrant`, `TenantStatusHistory`                                                                                                                                                |
| 10  | `20261018000002_rls_enforcement_storage_and_grants`                         | Policy families, trigger guards, `tenant-branding` storage policies, least-privilege grants                                                                                                                                         |
| 11  | `20261019000000_phase02_provider_administration_plans_and_suspension_gates` | `Plan` + `Tenant.planId` FK, indicator columns + their two definer writers, the 4 new platform permissions (catalog 42 / matrix 116), the suspension write gate, `tenant_provider_columns_guard_update`, one-primary-hostname index |

**Freeze rule:** migrations 1–10 are applied to a shared project, so their files
are immutable — checksum drift turns `migrate deploy` into a hard failure. Any
further schema change is a **new** migration, never an edit. Verify with
`prisma migrate status` that the live database still reports no drift before
and after any operation.

Migration 11 is still editable **only because it has never been applied
anywhere shared**. Once it is deployed it joins the frozen set, and any later
change becomes migration 12.

Before it goes anywhere near the live project, carry a **throwaway** database
through the whole chain with the committed driver (never the shared Supabase
project — see §4.3 and the `DIRECT_URL` trap):

```sh
PGHOST=localhost PGPORT=55499 PGUSER=postgres sh scripts/db/cleanroom-chain.sh <scratch>
```

The driver applies 1–10, loads the legacy fixture, then runs migration 11 **twice
by design**: once with a legacy text `Tenant.planId` present (it must abort), once
after the script NULLs those values (it must apply), and re-runs the Phase 1
battery on top of it. The one-off equivalent, if you only need the abort probe:

```sh
MIG=apps/web/prisma/migrations
psql -h localhost -p 55499 -U postgres -d <scratch> -v ON_ERROR_STOP=1 -1 \
     -f "$MIG/20261019000000_phase02_provider_administration_plans_and_suspension_gates/migration.sql"
```

Expected: the abort probe refuses to convert a legacy text `planId` and leaves the
database untouched (the file is one transaction); after an operator resolves the
label it applies with `plans=1`, `permission catalog=42`, `role matrix=116`,
`planId type=uuid`; the Phase 2 battery prints **55 PASS and no FAIL**; the Phase 1
battery prints **71 PASS plus one labelled SKIP** before and immediately after 11 —
the SKIP is `T9j`, which cannot assert the fenced support branch until
`20261021000000` is applied — and **72 PASS and no FAIL** once step 13 has applied
it; and `prisma migrate diff --from-url <scratch>
--to-schema-datamodel prisma/schema.prisma` prints nothing but the probe fixture's
`DROP TABLE "other_app_data"`.

Evidence caveat retired, one honest gap left: the chain driver
(`scripts/db/cleanroom-chain.sh`), the Phase 1 behaviour battery, and the legacy
fixture are **tracked files**, so the procedure above reproduces from the
repository alone, and the CI job that runs them automatically (#37d) now exists in
`.github/workflows/ci.yml` and has been rehearsed step by step locally — what is
still missing is an actual GitHub Actions run, because nothing has been pushed.

**Migration 12 is in the working tree, not on `main`'s HEAD, and not applied
anywhere shared.** `20261020000000_phase05_portal_linkage` (`Contact.portalUserId`,
an FK to `User` with `ON DELETE SET NULL`, a unique index on `(tenantId,
portalUserId)`) was found untracked, parked by the owner on
`wip/phase05-business-features` (`0a67b69`, task #52), and then **brought back with
the rest of the document work under the Phase 4 directive** (2026-10-15, tasks
#53/#54). It is clean-room verified but **uncommitted**, so treat it as pending
until it lands in history, and it is still **not applied to the live project** —
the shared database stays at 10 migrations until #38 and the owner-gated sequence
(#38 → 11 → #37) run. `main`'s HEAD carries the Phase 1–2 chain plus the two Phase
1 gate migrations `20261021000000`/`20261021000001`.

Because migration 12 is now in the tree, step 13 has real work again: the chain on
the current tree prints **78 · 71 + SKIP · 71 + SKIP · 55 · 72 PASS, 0 FAIL**,
applying `20261020000000` → `20261021000000` → `20261021000001` in deploy order.
Each number is the battery's PASS-line count; the two SKIPs are `T9j`, which keeps
its label until the fencing migration (`20261021000000`) has been applied.

Two things to keep straight about that branch. First, its contents are a parking
record, not an approval — and the code came back from it by the owner's direction
on 2026-10-15, not by anyone deciding the gate had opened itself. Second, when a
migration directory newer than 11 _is_ in the tree, the driver's
step 13 applies it and re-runs the Phase 1 battery; that is how two apparent
battery FAILs (`T2L-a`/`T2L-b`) were traced to fixture ordering left behind by
step 12 rather than to any policy change. A future run that reaches migration 12
should read `phase-01-security-harness-report.md` §4 before believing either
number.

Read migration 11's own header before deploying it: it stops with a message if a
workspace already carries a non-UUID plan reference, and that refusal is the
intended behaviour — resolve the data, never edit the migration.

The Phase 1 migrations also close a real hole rather than only adding tables:
`ALTER DEFAULT PRIVILEGES` had been handing new tables to `amisibiz_app`
automatically. Migration 10 revokes that river and grants per table instead, so
an unreviewed future table is invisible to the runtime role until a migration
says otherwise — which is why no operator script should re-grant it. Migration 11
follows the same rule for `Plan`: `SELECT` only, and a `plan_select` policy that
admits platform admins, so the catalogue changes by migration or reviewed operator
SQL and never by an application request.

---

## 6. Tenant status, support access, and audit

**Tenant lifecycle** (`PENDING → ACTIVE ⇄ SUSPENDED`) has exactly three
implemented transitions — activate (`PENDING→ACTIVE`), suspend (`ACTIVE→SUSPENDED`)
and reactivate (`SUSPENDED→ACTIVE`) — all requiring `reason`, all defined once in
`TENANT_STATUS_TRANSITIONS`
(`apps/web/src/server/services/tenant-lifecycle.ts`), and documented with their
permissions in `administration/provider-console.md` §4. Each is one transaction:
a status-guarded `updateMany`, its `TenantStatusHistory` row and its audit event.
The `tenant_status_guard` trigger refuses a status change outside an active
platform-admin context, so a workspace role cannot move its own status even if
application code forgot to check.

**What suspension means** (Phase 2 decision, restated in
`architecture/security-model.md` §4.1): new **writes and synchronization are
denied**; **reads and downloads of what the business already has keep working**;
no tenant row and no storage object is deleted or archived by suspending. The
split is implemented in two places that must agree:

- application: `resolveTenantContext` marks a member of a suspended workspace
  `readonly: true`, and `assertWritableContext` refuses a write permission with an
  awaited `tenant.writeDenied` audit row before it throws;
- database: `app_tenant_accepts_writes(tenant)` (`status <> 'SUSPENDED'`) gates
  `has_tenant_write_access` and `has_tenant_admin_write_access`. **Read policies
  are untouched**, which is exactly why the admin family has a write-specific
  twin — the audit trail's read gate must stay open for a suspended business.

Every `is_platform_admin()` branch is left unconditional: the operator who
suspended a workspace must be able to re-brand, re-address, re-plan and reactivate
it. A suspended workspace also cannot move its own `slug`, `planId` or the
activation/suspension bookkeeping columns at all
(`tenant_provider_columns_guard_update`), and `allocate_document_number()` refuses
to consume a sequence value for it.

`PENDING` is enforced one layer up, in authorization
(`READABLE_TENANT_STATUSES = ["ACTIVE","SUSPENDED"]`), **not** in
`app_tenant_accepts_writes()` — deliberately: provisioning a workspace writes its
settings, branding, hostname, owner seat and invitation acceptance while the tenant
is still `PENDING`, and gating that would break registration rather than tighten
it. Reads of a `PENDING` tenant are refused by authorization, not merely hidden.

**Operational indicators** (`Tenant.lastActivityAt`, `lastSyncAt`,
`lastSyncErrorCode`) are written only through `touch_tenant_activity()` and
`record_tenant_sync_attempt()`, both `SECURITY DEFINER`, both revoked from `PUBLIC`
and granted to `amisibiz_app` only, and both refusing a caller that is not acting
inside that workspace (or is not a platform admin). `lastActivityAt` is stamped
when a **write** permission is granted — not on a page view — and a suspended
workspace keeps the timestamp it had when it went offline. A refusal requires a
machine code of ≤ 64 characters, so a new refusal reason never needs a migration.
There is **no synchronization transport yet** (Phase 06): `answerSyncRequest()` is
implemented, tested and wired, and `lastSyncAt` is legitimately `null` for every
workspace — the console must render "no synchronization recorded", never "up to
date". An offline device keeps its cache until it next connects, and nothing here
can claim a revocation travelled any faster.

**Provider support access** is the only path from a platform role into tenant
business data, and it is bounded by design (`apps/web/src/server/services/support-access.ts`):

- a grant names one tenant and one platform user, records a mandatory `reason`,
  and expires — default 24 h, clamped to at most 30 days
  (`MAX_SUPPORT_GRANT_HOURS`);
- `SUPPORT` holds **no** tenant permissions of its own; an active grant confers
  only the read-only `SUPPORT_TENANT_PERMISSIONS` set, and write policies
  (`has_tenant_write_access`) contain no support branch at all;
- granting, revoking, using and being denied are audited
  (`support.accessGranted`, `support.accessRevoked`, `support.accessUsed`,
  `support.accessDenied`);
- a grant the operator needs to stop early is revoked through
  `revokeSupportGrant`, which sets `revokedAt` and keeps the row for the audit
  trail.

**Audit rows are append-only at two levels.** The application exposes no
`AuditLog` update or delete path, and migration `20261018000002` grants the
runtime role `SELECT, INSERT` only on `AuditLog`, `TenantStatusHistory` and
`DocumentStatusEvent` — an `UPDATE`/`DELETE` issued by the app is refused by the
grant, not merely unimplemented. `Permission` and `RolePermission` are
`SELECT`-only (the catalog is changed by migrations, never at runtime). The
writer (`src/lib/audit`) sanitises credential-shaped keys from `metadata` and
serialises **the sanitised value**; that ordering is the point, and a test
locks it. Because Prisma's `create()` emits a `RETURNING` read that the SELECT
policy filters, appends go through a raw parameterised INSERT
(`appendAuditLog`) — intentional, and the reason the test harness inspects
`$executeRaw` bindings rather than an `auditLog.create` mock.

---

## 7. Known inert states (read before claiming a deployment is secure)

| State                                                                                                                         | Consequence                                                                                                                                                                                                                                                                                                                 | Closure                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `amisibiz_app` has no password and `APP_DATABASE_URL` is unpublished                                                          | RLS does not govern the running app; in production the app refuses to boot rather than fall back                                                                                                                                                                                                                            | §3, then `pnpm db:assert-rls`                                                            |
| The 8 required cross-tenant proofs have no DB-backed harness                                                                  | Policy behaviour is asserted only against a mock                                                                                                                                                                                                                                                                            | integration harness task (#37)                                                           |
| Storage policies for `tenant-branding` exist in migration 10, but logo upload/serve still uses the filesystem `/uploads` path | DB-side policies are untested end-to-end and the filesystem remains the effective store                                                                                                                                                                                                                                     | Supabase Storage adoption task (#36)                                                     |
| No email transport                                                                                                            | Verification and password-reset mail is not delivered; production registration must stay disabled                                                                                                                                                                                                                           | wire a provider, then set `REQUIRE_EMAIL_VERIFICATION`                                   |
| `user_select` / `user_update` policies are deliberately coarse (self OR platform admin OR shared-tenant)                      | Row _selection_ is wide, so reading another member's row is possible for a coworker; the `users_guard_update` trigger narrows every _transition_ (platform role, email and status are not self-serviceable; another user's row accepts only a one-step `sessionVersion` bump, and only from a shared-workspace owner/admin) | documented in `security-model.md`; tighten only with the member-listing flows re-checked |
| `apps/mobile` and `apps/desktop` are scaffolds                                                                                | Neither has been compiled anywhere; no client build claim is true                                                                                                                                                                                                                                                           | open items in 04.5b follow-ups                                                           |
| Migration 11 (Phase 2 plans, indicators, suspension gate) is **not applied to the live project**                              | On the live database there is no `Plan` table, no indicator columns, and no `platform.tenants.update` / `plan.assign` / `domain.manage` / `audit.read` rows — the provider console's Phase 2 panels cannot work there, and `prisma migrate status` reports the project as behind by one migration (10 applied,              |
| 11 present in the repository). Every Phase 2 claim in §6 is proven against a throwaway cluster only                           | owner-gated `migrate deploy`, then re-run §5's checks and `prisma migrate status`                                                                                                                                                                                                                                           |
| `answerSyncRequest()` has no production caller                                                                                | `Tenant.lastSyncAt` is `null` for every workspace and no `sync.rejected` row can exist; the offline-refusal path is tested, not observed                                                                                                                                                                                    | the Phase 06 synchronization transport                                                   |
| The provider console has not been exercised in a browser against a live tenant                                                | UI is verified by build, type-check and unit tests; no click-through evidence exists for the panels in `administration/provider-console.md`                                                                                                                                                                                 | manual walkthrough with the owner, after migration 11 is deployed                        |

---

## 8. If something is wrong

- **`pnpm db:assert-rls` exits 1 with "bypasses row-level security"** —
  `APP_DATABASE_URL` points at an owner/superuser role. Repoint it at
  `amisibiz_app`; do not "fix" it by granting `BYPASSRLS`.
- **Exits 1 with "an empty context still reads N rows"** — policies are present
  but not effective for this role (missing `RLS` enable, or table owned by the
  connecting role). Re-run §2–§9 of `setup-app-role.sql` and check
  `pg_roles` attributes before touching data.
- **Production boot fails with "APP_DATABASE_URL is required in production"** —
  expected and correct. Publish the variable; do not unset `NODE_ENV` or add a
  fallback.
- **`migrate deploy` reports checksum drift** — an applied migration file was
  edited. Restore the file from the commit that produced the applied checksum
  and express the intended change as a new migration. Never `resolve --applied`
  on a shared project to make the error disappear.
- **A cross-tenant read succeeded** — treat it as an active incident: capture
  the request path and the connection identity (`current_user`, not the
  connection string), check whether the code path bypassed
  `packages/database/src/scope.ts`, and read the `authz.denied` /
  `support.accessDenied` audit rows for the same window.
- **A suspended workspace accepted a write** — the split is enforced twice, so a
  failure names which layer is lying. Check for the `tenant.writeDenied` audit row
  first: no row means `assertWritableContext` was bypassed (application bug); a row
  plus a successful write means the database gate is not governing this
  connection — i.e. the runtime is not connected as `amisibiz_app` (§3), which is
  the documented inert state rather than a new defect. Also confirm migration 11 is
  applied: without `app_tenant_accepts_writes()` there is no DB-side gate at all.
- **A Phase 2 console panel fails with "Unknown plan." / an unknown-column error on
  the live project** — migration 11 has not been applied there (§7). Do not
  "fix" it by editing the migration; deploy it or hide the panel.
- **`migrate deploy` aborts on "Cannot convert Tenant.planId to a UUID"** — a
  workspace carries a legacy text plan reference. Read the rows, decide each plan
  assignment, then re-run; the whole file is one transaction, so nothing partial
  was written.
- **A secret appears in a bundle, log, or error** — rotate it at the provider,
  then find the reference: only `NEXT_PUBLIC_*` may reach the client, and
  `SUPABASE_SECRET_KEY` must never be interpolated into a client component, a
  response body, or a log statement.
