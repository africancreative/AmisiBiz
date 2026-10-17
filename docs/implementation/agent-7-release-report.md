# AGENT 7 — Release readiness report

Date: 2026-10-18 · Audited tree: **`8cd1d4b` ("stage4")**, working tree clean
except two uncommitted gap-analysis documents from the previous inventories.
Method: independent verification — every claim below was executed or read
directly from source in this audit; prior agents' completion reports were NOT
trusted and are contradicted in at least one place (§3 C1).

## 1. Commands actually executed

| Command                                                        | Result                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm type-check`                                              | **PASS** — 10/10 workspaces                                                                                                                 |
| `pnpm lint`                                                    | **PASS** — 0 errors, 2 warnings (unused vars: `portal/layout.tsx:4`, `login-form.tsx:11`)                                                   |
| `pnpm test:run`                                                | **PASS 538 / 0 failed / 33 skipped** — the 33 skipped are `tests/integration-security.test.ts`, which requires `TEST_DATABASE_URL` (see §3) |
| `pnpm format:check`                                            | **FAIL** — `apps/web/src/lib/admin/tenant-queries.ts`, `apps/web/src/server/actions/auth.ts` (both committed in `8cd1d4b` unformatted)      |
| `pnpm build`                                                   | **PASS** — compiled, 70 static pages generated                                                                                              |
| `pnpm check:bundles`                                           | **PASS** — 246 files / 5.4 MB scanned, no secret material in any client/server bundle                                                       |
| `pnpm audit --prod`                                            | **7 findings: 3 high, 4 moderate** — all transitive; see §3 M3/L1                                                                           |
| `prisma migrate deploy` (fresh DB, throwaway cluster)          | **Reports success — 21/21 applied** — but the built schema is wrong; see §3 C1                                                              |
| `prisma migrate diff` (migrations-built DB vs `schema.prisma`) | **Drift confirmed**, 86-line delta; evidence attached as `agent-7-schema-drift.sql`                                                         |
| `vitest run tests/integration-security.test.ts` (real DB)      | **3 failed / 30 passed** on a drift-patched throwaway DB; **cannot run at all on a migrations-built DB**                                    |

## 2. Database verification (throwaway cluster, never a shared DB)

Scratch PostgreSQL 18 on `localhost:55499` (local data dir repaired after an
unclean Windows shutdown: recreated `pg_notify`, `pg_twophase` and six other
runtime directories). Fresh database, **both `DATABASE_URL` and `DIRECT_URL`
pinned to the scratch DB** (the known trap: Prisma CLI migrates through
`DIRECT_URL`, which `.env` points at a live database).

1. `prisma migrate deploy` applied all 21 migrations and reported success.
2. `migrate diff --from-url … --to-schema-datamodel` proved the migrated
   schema does NOT match the application schema.
3. The drift was patched onto the scratch DB only, and the RLS integration
   suite was run against the patched DB: **30 of 33 proofs pass**; the 3
   failures are themselves findings (§3).

## 3. Findings

### C1 (CRITICAL) — Five migration files are empty shells; a fresh deploy cannot authenticate anyone

`20261024000000_phase07_admin_auth`, `20261025000000_phase08_subscription_management`,
`20261026000000_phase09_branding_document_settings`,
`20261027000000_phase10_audit_integrity`, `20261028000000_phase11_branding_provider_config`
contain **zero executable SQL** — each is a comment reading "Applied via schema
sync". Some out-of-band `db push` made a development database match the schema;
the migration chain never did. A database built by the repo's own deploy path
is missing, verbatim from the drift diff:

- `User.passwordHash` — **the native credential column.** Registration and
  login fail on first use. No environment built from migrations can
  authenticate a user.
- Tables `Subscription` and `SubscriptionStatusHistory` (+6 indexes, +FKs) —
  the whole subscription model.
- 17 `TenantBranding` columns — document templates, customizations, numbering
  overrides, provider config.
- `AuditLog.correlationId/outcome/outcomeDetails/resourceType` — the audit
  integrity phase.

`prisma migrate deploy` reports success on the shell files, so no pipeline
error surfaces. Nothing in this audit probed any live database (owner go-ahead
required); if a live DB currently works, it works only because it was
hand-pushed, which must be confirmed and then fixed with real migrations.

**Every database that is not the hand-pushed one is broken. CI, a new
staging environment, and disaster recovery all fail.** This alone is NO-GO.

### H1 (HIGH) — Permission catalog and role matrix: database seeds 15+ permissions behind the code

On any migrated database, the seeded catalog holds 42 permissions; the code
catalog (`@amisibiz/auth`) has 57. Missing include `audit_logs.read`,
`branding.manage`, `branding.read` and the portal permissions. The
role→permission matrix likewise differs (e.g. `SUPER_ADMIN` keys). App-layer
authorization uses the code catalog; RLS helper functions use the DB seeds —
the two enforcement layers disagree until the catalog is re-seeded by a real
migration. Proof: integration test "the permission catalog in code is the
catalog in the database" FAILS, as does the matrix test.

### H2 (HIGH) — `Subscription` tables have no RLS policies anywhere

`db push` never writes row-level-security policies, and no migration contains
them. The integration proof "every public application table is row-level
security protected" FAILS, naming exactly `Subscription` and
`SubscriptionStatusHistory`. If the runtime role enforcement (#38) is ever
switched on, these tables are unprotected; today they rely solely on
app-layer checks.

### M1 (MEDIUM) — The repo's own security gate cannot run from repo artifacts

`tests/integration-security.test.ts` (the 33-proof RLS harness) fails during
fixture setup on a migrations-built database (`User.passwordHash` missing). It
only ran here after I patched the drift by hand. The suite is the project's
primary tenant-isolation evidence and it is red by construction.

### M2 (MEDIUM) — `format:check` is red at HEAD

Two committed source files are unformatted (`tenant-queries.ts`,
`server/actions/auth.ts`). Trivial fix; it still fails the gate as shipped.

### M3 (MEDIUM) — `next-intl@3.26.5`: two runtime-relevant moderates

Open-redirect (GHSA-r28c-9q8g-f849 family) and prototype-pollution advisories;
patched only in `next-intl >= 4.9.2`, a **major** upgrade with migration work
across every localized page. Runtime exposure is real (locale middleware runs
on every request) but moderate; no auth bypass. Plan the upgrade; do not ship
a rushed major bump as part of this release.

### L1 (LOW) — Build-chain advisories, lint warnings, env template

- `postcss@8.4.31` in one dependency chain (3 advisories) and
  `deepmerge-ts@7.1.5` via the Prisma CLI — build-time only, not runtime.
- 2 eslint warnings (unused variables).
- `.env.example` documents 5 keys; the code reads 18
  (`APP_BASE_DOMAIN`, `EMAIL_PROVIDER`, `REDIS_URL`/`UPSTASH_*`,
  `STORAGE_PROVIDER`, `TRUST_PROXY`, `REQUIRE_EMAIL_VERIFICATION`,
  `ENABLE_DEV_RATE_LIMIT` undocumented). New-environment setup is
  guesswork today.

## 4. Security surface — reviewed and tested

Positive results from execution and source review:

- **Tenant isolation (30/33 proofs on a patched DB):** cross-tenant reads,
  writes, deletes, INSERTs refused by WITH CHECK; forged tenant GUC gains
  nothing; platform-admin claims are re-derived, not trusted; no-context
  sessions see nothing; cross-tenant document/customer/item/tax references
  refused; portal seat bound to one customer per tenant.
- **SQL injection:** no `queryRawUnsafe`/`executeRawUnsafe` anywhere; all raw
  SQL is parameterized tagged templates; Prisma parameterizes the rest.
- **Downloads/uploads:** both PDF routes and the uploads route authenticate on
  every request, resolve tenant/customer server-side, put ownership inside the
  query, serve `no-store` with sandboxed CSP; path shapes are fixed and
  traversal-proof; logo uploads verify magic bytes and dimensions; SVG refused.
- **Sessions:** 7-day cookie, `sessionVersion` revocation chain, bcrypt
  credentials, login rate limiting on IP and email buckets (Redis/Upstash with
  a documented in-memory dev fallback).
- **CSRF:** mutations run as Next.js Server Actions (framework origin checks);
  API routes are GET-only downloads plus the sync pair.
- **Hostname tenancy:** subdomains are parsed only against a configured base
  domain suffix; unknown hosts resolve no tenant.
- **Errors/logs:** routes return generic messages; no stack traces or SQL to
  clients; audit rows carry ids and counts, not PII; bundle scan finds no
  secret material.
- **No eTIMS/KRA compliance claims** anywhere in UI or PDFs (grep-verified).

## 5. Not executed, and why

| Area                                                                   | Reason                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| End-to-end functional flows (registration → portal, directive §A)      | Requires a working database; migrations cannot produce one (C1). Reproducing the hand-`db push` workaround to demo flows would normalize the anti-pattern the audit exists to catch.     |
| Live-database state (what is actually deployed)                        | Standing rule: no live probes without the owner's explicit go-ahead.                                                                                                                     |
| Email delivery, private storage integration                            | No email transport and no storage provider exist (AGENT 6 §3.1/3.2).                                                                                                                     |
| Performance/load, concurrency proof of numbering under real contention | No load environment; the numbering guarantee is enforced in-DB (`SELECT … FOR UPDATE` + unique index) and unit-tested for composition, but concurrent allocation was not exercised here. |
| E2E suites                                                             | None exist in the repo.                                                                                                                                                                  |

## 6. Recommendation: **NO-GO**

Not because of the directives' specific red lines — no cross-tenant defect was
found (30/33 isolation proofs pass), no broken issuance transaction, no exposed
documents — but because the release artifact itself is unsound: **a deploy
built from this repository produces a database on which the application cannot
register or authenticate a user, and the project's own security test suite
cannot run.** That is a configuration blocker of the first order, and the
success reporting of `prisma migrate deploy` means it would reach production
silently.

Unblock list, in order:

1. Write the five missing migrations (phase07–11) as real SQL, including the
   permission-catalog seeds, the role-matrix grants, and RLS policies for
   `Subscription`/`SubscriptionStatusHistory`. Verify with
   `prisma migrate diff` on a throwaway DB until the diff is empty.
2. Re-run the 33-proof integration suite against a migrations-built database —
   it must pass unpatched.
3. Confirm (owner, read-only probe on approval) what the live database
   actually contains; reconcile it with the corrected chain before any deploy.
4. Fix `format:check` (two files) and decide the `next-intl` major upgrade as
   a planned follow-up, not a release dependency.
5. Then the AGENT 6 owner decisions (storage provider, session policy) and the
   AGENT 5 gap closures remain, per those reports.

A GO after these fixes is still not a deployment authorization; production
deployment requires explicit owner approval per standing rules.
