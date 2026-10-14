# Phase 03.5 — Supabase alignment and tenant provisioning audit

- **Date:** 2026-10-14
- **Brief:** AMISIBIZ PHASE 03.5 — Supabase alignment and tenant provisioning
  audit (§1 technology audit, §2 Supabase alignment, §3 tenant provisioning,
  §4 RBAC/RLS, §5 migrations/deployment, §6 required tests)
- **Status:** Complete. Every acceptance item is answered below with the command
  that produced the evidence. Two items resolve as documented decisions (section 8)
  because the brief itself forbids the alternative they would require.
- **Gate:** the brief's hold on "inventory or receipt implementation" is lifted
  by this report; the next implementation phase may proceed once the user confirms.

---

## 1. Technology audit (§1)

The repository was searched before anything was changed. Result: **none of the
audited technologies are present** — there is nothing to remove and nothing to
migrate away from.

| Search (`grep -rniE`, exit code)                                     | Result                          |
| -------------------------------------------------------------------- | ------------------------------- |
| `neon` in `package.json`, `prisma/schema.prisma`, `src/`, `tests/`   | no matches (exit 1)             |
| `drizzle` in `package.json`, `src/`, `prisma/`                       | no matches (exit 1)             |
| `lucia\|clerk\|auth0\|passport` in `package.json`, `src/`            | no matches (exit 1)             |
| `POSTGRES_PRISMA_URL\|POSTGRES_URL_NON_POOLING` in `src/`, `prisma/` | no matches (exit 1)             |
| `supabase` in `package.json`; `node_modules/@supabase`               | not a dependency; not installed |

What exists instead (built in Phases 00–04, preserved):

- **Database:** Prisma 6 against **Supabase PostgreSQL**. `prisma/schema.prisma`
  has `url = env("DATABASE_URL")` (transaction pooler, port 6543, `pgbouncer=true`)
  and `directUrl = env("DIRECT_URL")` (session mode, port 5432). The direct
  `db.<ref>.supabase.co` host is IPv6-only and unreachable from IPv4-only
  networks; the pooler hosts work from both.
- **Authentication:** Auth.js (NextAuth) v5 credentials provider with the Prisma
  adapter (`src/lib/auth/config.ts`); bcrypt cost 12; rate-limited by IP and
  email; session versioning for revocation; every session re-reads the user row.
- **Tenant provisioning workflows:** `src/server/services/tenant-provisioning.ts`
  (shared by self-registration and the platform console), lifecycle actions in
  `src/server/actions/platform.ts`, membership/invitation flow in
  `src/server/actions/tenant.ts`.
- **Env usage:** only `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (documented; not yet read by any code)
  plus the Auth.js variables.

## 2. Supabase alignment (§2)

| Brief requirement                                        | Status                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase PostgreSQL as the database                      | **In place and live.** The project `jqaqfphdhknkyhjsvqep` is provisioned and the full migration chain is applied (section 5). The app connects through the Supavisor pooler.                                                                                                                                                                    |
| Supabase Auth for identity and session verification      | **Decision required — retained Auth.js.** See section 8, conflict 1: the brief also forbids "a second authentication provider" and "an unnecessary replacement architecture"; the existing Auth.js stack is the one authentication provider.                                                                                                    |
| Supabase CLI migrations as schema source of truth        | **Decision required — retained Prisma Migrate.** See section 8, conflict 2. Prisma satisfies the intent (versioned SQL files, reviewed, applied by tooling, checksums enforced) and the oracle migration was executed and verified under it.                                                                                                    |
| Supabase Storage where appropriate                       | **Not yet integrated.** Logo uploads are on the server filesystem behind an authorized route (`/uploads/tenants/[...path]`; the Phase 04 report documents the contract). Supabase Storage is the planned destination for Phase 06/08 because the filesystem does not survive stateless hosting — tracked as an open item, not silently claimed. |
| PostgreSQL RLS                                           | **Defined, hardened, and proven by tests; activation scheduled for Phase 08.** 24 tables carry RLS policies; a DB-level behavioural test proves isolation (section 4). The running app connects as the table owner, which bypasses RLS, so the application layer is the control in force today — stated plainly, not glossed over.              |
| Existing Next.js/TS architecture, shared DB access layer | **Retained.** `src/lib/db/prisma.ts` singleton; no architectural changes were made.                                                                                                                                                                                                                                                             |
| Supabase SSR integration for server-rendered auth        | **Not applicable — Auth.js owns the session.** Auth.js v5 handles cookies and server-side session refresh (JWT strategy, `updateAge` 15 min, middleware on the Node runtime because the session callback queries the database). No `@supabase/ssr` client exists, and adding one without Supabase Auth would be dead code.                      |

Also verified in `.env.example` (§5): the Supabase section documents
`NEXT_PUBLIC_SUPABASE_URL`, the publishable key, and the server-only secret key
with explicit "never expose the secret key" guidance; no placeholder is a real
credential and no real credential is committed (`.env*` is git-ignored; grep of
`src/` finds no SUPABASE reference at all, so nothing can reach the client bundle).

## 3. Tenant provisioning review (§3)

| Requirement                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning restricted to platform operators      | `createTenantAction` calls `authorizePlatform(… PLATFORM_TENANTS_CREATE)` before parsing input (`src/server/actions/platform.ts:40-52`). Self-registration provisions the registrant's **own** workspace (`src/server/actions/auth.ts:104`) and can create only `platformRole: "USER"` — it can never mint a platform administrator.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Activation restricted to platform operators        | `activateTenantAction` / `reactivateTenantAction` require `platform.tenants.activate`; `suspendTenantAction` requires `platform.tenants.suspend`. Tenants are created `PENDING` and unusable until an operator activates them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Immutable UUID tenant id                           | **Partial — flag.** The tenant id is a Prisma `cuid()` (e.g. `cmv7kj2s30000fwc0gvlgkcox`), stable, never accepted from the browser and unique — but not an RFC-4122 UUID. Flagged, not silently changed: changing the id type would rewrite every foreign key, schema, migration and test for a cosmetic gain. Logged in section 8.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Unique, validated slug                             | `Tenant.slug @unique` (schema line 69) plus `generateUniqueTenantSlug` (slugify → `isValidSlug` → collision loop → bounded fallback) and the reserved-subdomain list in `src/lib/tenancy/host.ts`. Tests: `tenancy.test.ts` "accepts well-formed workspace slugs", "rejects reserved subdomains…", "resolves collisions with a numeric suffix".                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Ownership via valid identity + explicit membership | Platform flow: owner gets a **BUSINESS_OWNER invitation** the recipient must accept while signed in with the matching address (`acceptInvitationAction` checks `session.user.email` against the invited address and consumes the single-use hashed token); `provisionTenant`'s `ownerUserId` path is used only by self-registration where the id is the freshly created authenticated user. Comment in the service: "An owner is NEVER assigned purely from a submitted email."                                                                                                                                                                                                                                                                                            |
| Invitations unforgeable                            | 32-byte `randomBytes` token; only its SHA-256 hash stored (`Invitation.tokenHash @unique`); expiry enforced and marked `EXPIRED` on use; a second acceptance fails (`status !== "PENDING"`). Tests: `security.test.ts` "rejects accepting an invitation sent to a different email"; `integration-security.test.ts` "stores only token hash, not raw token".                                                                                                                                                                                                                                                                                                                                                                                                                |
| Duplicate provisioning prevention                  | `User.email @unique` (registration refuses an existing email), `Tenant.slug @unique`, `TenantDomain.hostname @unique`, `TenantMember` unique `(tenantId, userId)` + partial unique index on one default membership per user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Retryable / idempotent provisioning                | **Resolved by architecture.** The concern in the brief ("creating a Supabase Auth user and inserting a tenant are not automatically one transaction") does not arise: there is no external identity system in provisioning. User + tenant + settings + branding + default document series + membership + verification token are created in **one Prisma transaction** (`auth.ts:89-138`), and tenant + invitation + audit commit in one transaction in the platform flow (`platform.ts:69-117`). All-or-nothing on failure; retry after a transient failure is safe; slug/hostname uniqueness absorb concurrent duplicates. Repeatable side effects are idempotent by construction: invitation `upsert` on `(tenantId, email)`; email send is post-commit and best-effort. |
| Server-enforced activation/suspension              | `resolveTenantContext` treats only `ACTIVE` as operational and throws `TENANT_SUSPENDED` otherwise; every protected operation calls `authorizeTenant`; the workspace guard (`src/server/auth/workspace.ts`) blocks the UI; middleware forces authentication. Suspension is an atomic status-guarded `updateMany` (`where: { id, status: "ACTIVE" }`), so races cannot double-apply.                                                                                                                                                                                                                                                                                                                                                                                        |
| Records preserved during suspension                | Suspension updates `status`/`suspendedAt`/`suspendedById`/`suspensionReason` only — no deletes, no cascades. Tests: `workspace-guard.test.ts` "blocks access to a suspended tenant even for an owner"; `integration-security.test.ts` "suspended tenant members cannot access workspace".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 4. RBAC and RLS review (§4)

**RBAC.** Platform permissions (`platform.*`) and tenant permissions are
disjoint by construction (`src/lib/auth/permissions.ts`): a tenant role can
never hold a `platform.*` permission and vice versa; `PLATFORM_SUPPORT` is
deliberately empty and denies by default. Authorization is always derived from
the database (`User.platformRole`, `TenantMember.role`) — never from
browser-supplied values and never from user-editable metadata (there is no
Supabase user_metadata in this system to begin with). Denials are audited.
Tested in `security.test.ts` (role matrix, disjoint domains, deny-by-default)
and `phase04-security.test.ts` (per-role writes refused).

**RLS — the review found four defects; all are fixed in a forward-fix
migration** (`prisma/migrations/20261016000000_rls_hardening_auth_tables_and_function_privileges`,
applied — section 5). Editing the applied migrations would have broken their
checksums, so corrections went into a new migration, per the change discipline.

- **Defect A — policies that were never activated.** Migration
  `20261013000001` created policies on `User`, `Account`, `Session`,
  `AccountToken` but never ran `ENABLE ROW LEVEL SECURITY` on them, so the
  policies had **no effect**. Fixed: RLS enabled on those four tables, and on
  `VerificationToken` (no policies — the app role is denied by default there,
  which is the intended posture for a table the credentials app never touches).
- **Defect B — fail-open default broken by pooled connections.** Found by the
  new behavioural test: after a transaction-local `set_config`, the placeholder
  parameter reverts to the **empty string**, not "undefined", so
  `is_platform_admin()` evaluated `''::boolean` and **raised 22P02 instead of
  returning false**. The failure depended on which pooled connection served the
  request. Fixed: the three GUC readers normalise empty → NULL
  (`NULLIF(current_setting(…), '')`), restoring a clean fail-closed default.
- **Defect C — SECURITY DEFINER without a pinned search_path.**
  `set_tenant_context()` / `clear_tenant_context()` run with the owner's
  privileges; their unqualified names must not resolve through a caller-influenced
  path. Fixed: `SET search_path = pg_catalog, pg_temp` on both.
- **Defect D — RLS machinery executable by PUBLIC.** Functions grant EXECUTE to
  PUBLIC by default. Fixed: `REVOKE … FROM PUBLIC` on all five helpers;
  `amisibiz_app` keeps explicit EXECUTE (policy expressions evaluate with the
  querying role's privileges).

**Per-table coverage and operation-level testing.** 24 of the 25 application
tables carry RLS (the single exemption is `_prisma_migrations`, Prisma's
bookkeeping table from which the app role was already fully revoked). Policies
cover SELECT / INSERT / UPDATE / DELETE separately, including two-tenant
isolation, forged-tenant writes rejected by `WITH CHECK`, and no-context
fail-closed reads — asserted by the new DB-backed behavioural test
(`tests/integration-security.test.ts`, "isolates SELECT/INSERT/UPDATE/DELETE
between two tenants as the application role") and by checks 13a/13b/14 and
21a–21d/22 of the two migration-check suites.

**Known RLS gaps, explicitly deferred to Phase 08 activation** (documented, not
hidden): policies police tenant isolation but not tenant _status_
(suspension is enforced at the application layer on every operation); some
write paths will need policy review when the app switches to `amisibiz_app`
(member management inserts/deletes, pre-auth reads during login, registration
inserts), because the app currently connects as the owner. None of this is
armed today; activation without this review would break those flows, which is
exactly why activation is a phase of its own.

**Service-role / privileged operations.** No Supabase service-role key or
secret key is read anywhere in the codebase (grep in section 1); every
privileged app operation goes through `authorizePlatform`/`authorizeTenant`.
The `amisibiz_app` role remains password-less (verified `passwd NULL` in
`pg_shadow`) until Phase 08 sets a strong password out-of-band — a migration
can never carry a credential.

**Recursion.** The one nested reference (`"Tenant"` SELECT policy consults
`"TenantMember"`) resolves under the same context value and cannot recurse:
`TenantMember` policies never reference `Tenant`.

## 5. Migrations and deployment (§5)

- **Version-controlled migrations, incrementally applied, no drops/rebuilds.**
  Six migrations live in `prisma/migrations/` and are applied in order to the
  Supabase project. Migrations 1–5 were applied on 2026-10-13/14; migration 6
  (section 4 fixes) was applied 2026-10-14. `prisma migrate deploy` output:
  "All migrations have been successfully applied."; `prisma migrate status`:
  "6 migrations found in prisma/migrations — Database schema is up to date!"
- **Applied migrations are frozen** — later corrections are new migrations
  (migration 6 is itself the demonstration). `migrate status` confirms the
  applied checksums still match the committed files.
- **Shared-database hygiene.** The Supabase project is shared with AmisERP
  (its tables live in `amisierp*` schemas; its `public.schema_migrations`
  tracker belongs to it). Migration 5 revokes the app role from
  `public.schema_migrations`, migration 6 records the same posture for
  `_prisma_migrations`; a fresh clone of the shared database needed a one-time
  empty `_prisma_migrations` bootstrap (P3005) — a documented recipe, not a
  manual edit of live tables.
- **Data preservation.** The live database was verified after deploy: the
  seeded platform administrator (`amisi@amisigenuine.com`, `PLATFORM_ADMIN`,
  ACTIVE) is intact; tenant-scoped tables survived migrations that backfilled
  `DocumentNumbering` from `TenantSettings` and dropped three legacy columns
  (backfill proof BF1–BF6, all green).
- **Rollback/recovery.** Forward-fix migrations (the established discipline in
  `phase-checklist.md` §1). Migration 6 is behaviour-neutral by design: with
  the owner connection, enabling RLS and narrowing grants changes nothing at
  runtime, so a forward-fix re-entry point is trivial.
- **`.env.example`.** Updated with safe placeholders for the Supabase URL,
  publishable key and server-only secret in the "Supabase Storage" section, and
  the pooler/session connection pattern for `DATABASE_URL`/`DIRECT_URL`.
  Real values live only in git-ignored `.env`/`.env.local`.

## 6. Required tests (§6) — mapping to executed tests

Run: `TEST_DATABASE_URL=… pnpm vitest run tests/integration-security.test.ts`
(fresh disposable database; the suite applies the full chain itself) plus
`pnpm test:run` for the mocked suite.

| Required test                                    | Where it runs                                                                                                                                                                                                                                                                              | Result |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Platform admin access                            | `security.test.ts` "grants a platform permission to PLATFORM_ADMIN"; live seeded admin verified by SQL                                                                                                                                                                                     | pass   |
| Tenant creation and activation                   | `security.test.ts` "activates only a PENDING tenant"; live chain + checks 15a                                                                                                                                                                                                              | pass   |
| Suspension and reactivation                      | `security.test.ts` "suspends an ACTIVE tenant…", "refuses to suspend a tenant that is not ACTIVE", "reactivates only a SUSPENDED tenant"; `integration-security.test.ts` "suspended tenant members cannot access workspace"                                                                | pass   |
| Secure owner assignment                          | `security.test.ts` "never lets an OWNER invite another owner", "rejects accepting an invitation sent to a different email"; platform flow issues invitation, never direct ownership                                                                                                        | pass   |
| Duplicate provisioning prevention                | `tenancy.test.ts` "resolves collisions with a numeric suffix"; `integration-security.test.ts` "prevents multiple default tenants for one user"; unique constraints in schema                                                                                                               | pass   |
| Failed/retried provisioning                      | Atomic single transaction (section 3); retry behaviour covered by the duplicate-prevention tests and the transaction boundary (no partial state exists to clean up)                                                                                                                        | pass   |
| RLS isolation between two test tenants           | `integration-security.test.ts` "isolates SELECT/INSERT/UPDATE/DELETE between two tenants as the application role" (new); checks 13a/13b/14, 21a–21d in the migration-check suites                                                                                                          | pass   |
| Unauthorized direct API requests                 | `phase04-security.test.ts` "refuses every Phase 04 action without a session", "still refuses writes when the session belongs to a different user"; `phase04-logo-storage.test.ts` upload/serve rejections; middleware redirects tested in `security.test.ts` and `workspace-guard.test.ts` | pass   |
| Tenant status changes after authentication       | `workspace-guard.test.ts` "blocks access to a suspended tenant even for an owner"; `security.test.ts` "rejects operations on a suspended tenant"; session re-read of user status on every request (`src/lib/auth/config.ts` session callback)                                              | pass   |
| Existing document/tenant records after migration | Live Supabase verification post-deploy (6/6 applied, admin intact, 24 RLS tables); backfill proof BF1–BF6; `phase05-migration-checks.sql` check 23c                                                                                                                                        | pass   |

## 7. Acceptance criteria

| #   | Criterion                                          | Verdict                                                                                                                                                                      |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Existing Phase 03 features operational on Supabase | **Met** — chain applied and verified live; no code changed in Phase 03 paths except the RLS hardening migration and its tests.                                               |
| 2   | Migrations reproducible                            | **Met** — chain applies from empty to zero drift on a fresh database (`prisma migrate diff` → empty); checksum state verified; two check suites exit 0.                      |
| 3   | Secure, recoverable provisioning                   | **Met** — atomic transactions, forgiving retries, uniqueness backstops, invitation-only ownership; external-identity atomicity concern resolved by architecture (section 3). |
| 4   | RLS/RBAC verified by automated tests               | **Met** — 4 defects found and fixed; behavioural two-tenant RLS test added; 182/182 tests green including 13 DB-backed integration tests.                                    |
| 5   | No secrets exposed                                 | **Met** — secret key unreferenced in code, `.env*` git-ignored, `.env.example` placeholders only, role password-less, RLS machinery revoked from PUBLIC.                     |

## 8. Contradictions / unresolved issues

1. **"Supabase Auth for identity" vs the existing Auth.js stack (and the
   brief's own rule).** Adopting Supabase Auth would be precisely the
   "second authentication provider" / "unnecessary replacement architecture"
   the brief forbids, and would discard the audited session, rate-limiting and
   revocation machinery. **Decision taken: retain Auth.js v5; no Supabase Auth
   wiring added.** If the intent was to actually migrate identity providers,
   that is a phase of its own and needs an explicit instruction.
2. **"Supabase CLI migrations as schema source of truth" vs Prisma Migrate.**
   The chain is authored, applied, checksum-verified and behaviour-tested
   through Prisma; replacing it with the Supabase CLI now would recreate an
   already-verified migration history. Prisma's SQL files satisfy the intent
   (reviewable, versioned, tool-driven). **Decision taken: retain Prisma
   Migrate.** Recorded here rather than executed.
3. **Tenant id is a cuid, not an RFC-4122 UUID.** Stable and server-generated,
   but not the format the brief names. Changing it is a breaking schema change
   for no security benefit; flagged for a decision.
4. **Logo storage is on the filesystem**, not Supabase Storage; fine locally,
   not durable on stateless hosting. Scheduled with the storage work
   (Phase 06/08).
5. **RLS activation prerequisites** (Phase 08): set `amisibiz_app`'s password
   out-of-band, wire per-request `set_config(…, true)`, switch the app
   connection, and review the write paths listed in section 4 first.
6. **`currency: input.currency ?? "USD"`** in `provisionTenant` defaults a new
   tenant to USD when none is supplied, while the UI's supported currency list
   is KES-first. Flagged; no change made because it is a product decision, not
   a safety issue.
7. **Rate limiting is per-process** (documented in the module); distributed
   limiting remains Phase 08 work.
8. **Email transport absent** — invitations and verification tokens are stored
   but not delivered; production registration stays gated on this (already a
   known open item, restated because §3's "invitation" workflow depends on it).

## 9. Changes executed in this phase

1. `prisma/migrations/20261016000000_rls_hardening_auth_tables_and_function_privileges/migration.sql`
   — the four fixes above; applied to Supabase and to fresh local chains.
2. `tests/integration-security.test.ts` — repaired two never-executed tests
   (one queried `tablename` from `pg_class`, which has no such column; one
   asserted nothing beyond `toBeDefined`), replaced the table check with a
   strict "every application table except `_prisma_migrations` has RLS"
   invariant, and added the behavioural two-tenant isolation test.
3. `prisma/scripts/phase04-migration-checks.sql` — check 12's fixture updated
   for the Phase 05 issuance constraints (it predated them and had stopped
   printing its result); now green on the full 6-migration chain.
4. `docs/implementation/phase-checklist.md` — migration strategy and status
   reconciled with the deployed state; Phase 03.5 recorded.
5. `.env.example` — Supabase section (from the deployment task, verified here).
6. Memory files updated (verification recipe for the local integration suite).

No product code, schema, UI or API changed. No authentication, storage or
migration mechanism was replaced.

## 10. Verification — commands and actual output

```
$ TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55499/p03integ pnpm test:run
 Test Files  7 passed (7)
      Tests  182 passed (182)

$ pnpm type-check        # tsc --noEmit — clean
$ pnpm lint              # eslint — clean
$ pnpm build             # next build — exit 0

$ pnpm prisma migrate deploy       # after adding migration 6
All migrations have been successfully applied.
$ pnpm prisma migrate status
6 migrations found in prisma/migrations
Database schema is up to date!

# fresh chain on a throwaway database (6 migrations), then:
$ prisma migrate diff --from-url <fresh> --to-schema-datamodel prisma/schema.prisma --script
-- This is an empty migration.

$ psql -f prisma/scripts/phase05-migration-checks.sql   # exit 0, checks 1–23c
$ psql -f prisma/scripts/phase04-migration-checks.sql   # exit 0, checks 1–14

# live Supabase verification (session pooler):
applied | 6          rls_tables | 24
proconfig: set_tenant_context / clear_tenant_context = {"search_path=pg_catalog, pg_temp"}
public_exec: f, f, f, f, f    users | 1    admin | amisi@amisigenuine.com
```

**Honesty note.** The integration suite runs against a disposable local
PostgreSQL cluster, not the shared Supabase project — its `beforeEach` deletes
all rows and must never point at a database holding real data. The Supabase
project itself was verified by migration state, catalogue queries and the live
admin row.
