# Turning RLS on in the deployed app — #38 operator procedure

**Audience:** the project owner (or someone acting with the owner's explicit
go-ahead). **Nothing in this file has been executed.** Every step below that touches
the live Supabase project is deliberately left as instructions, because the standing
rule is that live probes and live migrations require the owner's explicit go-ahead.

Read `../RUNBOOK.md` §2–§4 first if the two database roles are not yet familiar.

---

## 1. Why this is the last thing standing between the project and the gate

The Phase 1 directive says: _"Do not begin business feature development until the core
authorization and RLS tests pass."_ The repository half is done — 26 harness cases and
two behavioural batteries run as the real runtime role `amisibiz_app` against a
disposable PostgreSQL, all green (`phase-01-security-harness-report.md`).

What is not done is operational. `amisibiz_app` **has no password**, so no application
can connect as it. Whatever connects instead is the table owner, and the owner bypasses
every policy — the policies are correct but _inert_ in a deployed app. That single
missing password is risk **S2**, task **#38**, and the reason business-feature work
stays gated.

There is a second operational item bundled here because it is the same class of action:
a full Supabase credential block (owner DB password with an embedded secret, JWT
signing secret, `sb_secret_*`, service-role key) was pasted into a chat transcript
during an earlier session. Those values must be treated as compromised and rotated.

## 2. What is true about the live project right now

Recorded state as of 2026-10-15, verified read-only:

| Fact                                         | Value                                                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                                      | Supabase ref `jqaqfphdhknkyhjsvqep`, region `eu-west-2` — **shared with AmisERP** (risk S1)                                                                                                                             |
| Migrations applied                           | **10 of 10** Phase 0/1 (applied 2026-10-14 07:04 UTC; no checksum drift), frozen from here on                                                                                                                           |
| Migrations pending in the repository         | `20261019000000` (Phase 2 plans + suspension gates), `20261021000000` (support read fence), `20261021000001` (instants)                                                                                                 |
| Business data                                | **0 tenants, 0 memberships, 0 contacts, 0 documents, 0 invitations, 0 audit rows**; 1 user (`SUPER_ADMIN`)                                                                                                              |
| Foreign application inside the same database | AmisERP's 96 tables in `amisierp` / `amisierp_audit` and its `public.schema_migrations` — **must stay untouched**                                                                                                       |
| `amisibiz_app`                               | exists, `LOGIN`, `NOINHERIT`, no `BYPASSRLS`, no password, 24 explicit `SELECT` grants from migration `20261018000002`                                                                                                  |
| Storage                                      | `tenant-branding` bucket exists with path-scoped policies; the app still writes logos to `/uploads` (task #36)                                                                                                          |
| Reachability                                 | Supavisor only: `aws-1-eu-west-2.pooler.supabase.com` — `5432` session mode for CLI/DDL, `6543` transaction mode for the runtime. The direct `db.<ref>.supabase.co` host is IPv6-only and unreachable from this machine |

Because there is zero business data, this is the cheapest the procedure will ever be.
Do it before the first real tenant exists.

## 3. Preparation (no writes)

1. **Take a backup you can restore.** Supabase → Database → Backups (or a
   `pg_dump` through the **session-mode** pooler). Record its id/timestamp. This is the
   rollback plan; everything below is additive, but a schema change without a restorable
   backup is not a change you can undo.
2. **Confirm the state table above still holds** with read-only queries in the SQL
   Editor:

   ```sql
   SELECT count(*) FROM "Tenant";                  -- expect 0
   SELECT count(*) FROM "User";                    -- expect 1
   SELECT count(*), bool_and(finished_at IS NOT NULL) FROM "_prisma_migrations"; -- expect 10, true
   SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolconnlimit
     FROM pg_roles WHERE rolname = 'amisibiz_app'; -- expect t / f / f / -1
   ```

   If `Tenant` is no longer 0, **stop** — you are no longer on a pre-launch database and
   the window-column conversion in `20261021000001` needs a data-aware rehearsal, not
   this shortcut.

3. **Have somewhere to put secrets that is not this repository**: a password manager or
   the deployment platform's secret store. Nothing below is ever committed, pasted into
   an issue, or pasted into a chat.

## 4. Step 1 — rotate the compromised credentials (owner, dashboard)

Order matters for one reason only: do the rotation **before** publishing new
connection strings, so nothing is configured twice.

1. Supabase → Project Settings → Database → **Rotate new password** for the `postgres`
   owner role. Update `DATABASE_URL` and `DIRECT_URL` wherever they are stored.
2. Supabase → Project Settings → API → **reset the `anon` / `service_role` publishable
   and secret keys**, and revoke any named API key that was exposed.
3. Supabase → Project Settings → API → **JWT signing key**: rotate (or reset the JWT
   secret if the project still uses the legacy shared secret).
4. Supabase → Project Settings → Auth → Sign In / Providers: **invalidate existing
   sessions** — a leaked JWT secret or `sb_secret_*` means existing tokens cannot be
   trusted. Anyone signed in will need to re-authenticate. That is the cost; it is
   smaller than the alternative.
5. If the project settings show the old values anywhere reusable (e.g. saved snippets,
   CI variables), update them in the same pass.

**Do not** reuse any part of the leaked strings, and do not paste the new values
anywhere except the secret store.

## 5. Step 2 — give `amisibiz_app` a password (the #38 operator step)

1. Generate locally, out of band:

   ```sh
   openssl rand -base64 32
   ```

2. In the Supabase **SQL Editor** (authenticated as the project owner — never through
   the application), run exactly one statement, pasting the generated value:

   ```sql
   ALTER ROLE amisibiz_app PASSWORD '<the-generated-secret>';
   ```

   This is §1 of `apps/web/prisma/scripts/setup-app-role.sql`. That script **grants
   nothing on purpose** — migration `20261018000002` is the only authoritative grant
   statement, and re-granting by hand would re-open the default-privilege path that
   migration closed. Do not run any `GRANT` from old notes.

3. Immediately verify the least-privilege end state by running **§2–§9 of the same
   file** in the SQL Editor. They are checks, not grants. Every block should print a
   `NOTICE`; any `WARNING` or `SECURITY ERROR` means drift — stop and investigate rather
   than continuing.

## 6. Step 3 — publish `APP_DATABASE_URL`

`packages/database/src/client.ts` is the contract: `APP_DATABASE_URL` set → used;
unset in production → **the app refuses to boot** (deliberate: an unavailable service
beats an unprotected one).

Set, in the deployment secret store (transaction-mode pooler, port 6543):

```
APP_DATABASE_URL="postgresql://amisibiz_app:<the-generated-secret>@aws-1-eu-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require&connection_limit=1"
```

Keep `DATABASE_URL` / `DIRECT_URL` pointed at the **owner** role, for Prisma CLI work
(`migrate`, `seed`) only. Remember the trap that already bit this project once:
`prisma migrate deploy` connects through **`DIRECT_URL`**, so any local command that
sets only `DATABASE_URL` still migrates production.

The tenant context is five **transaction-local** GUCs (`set_config(..., true)` inside a
Prisma `$transaction`) — the pooling-safe form, which is why 6543 is correct for the
runtime and wrong for DDL.

## 7. Step 4 — prove enforcement before anything else is trusted

From `apps/web` (it reads `.env.local` then `.env` and never prints either):

```sh
pnpm tsx prisma/scripts/assert-rls.mts        # or: pnpm db:assert-rls
```

| Exit | Meaning                                                                                                     | Action                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `0`  | runtime source is `APP_DATABASE_URL`, the role is not a bypass role, an empty context reads 0 `Tenant` rows | continue                                                                       |
| `1`  | **not enforced** — the connection bypasses RLS, or an empty context can read tenant rows                    | stop; do **not** weaken a policy to make this pass — that is the standing rule |
| `2`  | misconfigured or unreachable (e.g. pooler host/params, password, IPv4/IPv6)                                 | fix the connection, re-run                                                     |

The log line to look for is `[rls-probe] runtime role source: APP_DATABASE_URL (amisibiz_app)`.
If it says `DATABASE_URL fallback`, step 6 did not take effect in the environment you
just probed.

Then confirm the app itself still works end-to-end through the enforced connection:
sign in, load a tenant-scoped page, and check that a query issued without a context
fails closed with `ScopeNotSetError` rather than returning rows from every tenant.

## 8. Step 5 — apply the three pending migrations (owner go-ahead)

**Order is fixed by the filenames and by dependencies:** Phase 2 (`20261019000000`)
first, then the two harness-earned ones. `20261021000000` redefines
`has_tenant_read_access(uuid)` and compares it against `current_tenant_id()`, which only
returns `uuid` from migration `20261018000000` onward — the clean-room chain caught that
ordering as a real `operator does not exist: uuid = text` failure, so do not hand-pick a
different sequence.

From `apps/web`, with **both** URLs pinned to the live session-mode pooler (5432):

```sh
DATABASE_URL='postgresql://postgres:<new-owner-password>@aws-1-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require' \
DIRECT_URL='postgresql://postgres:<new-owner-password>@aws-1-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require' \
  npx prisma migrate deploy
```

Expect three migrations applied and `prisma migrate status` reporting 13 up to date.

Two things this sequence is designed to surface loudly rather than silently:

- **Migration 11 aborts on a legacy text `Tenant.planId`.** On a database with zero
  tenants that cannot happen; if it does abort, an **operator resolves the row** — the
  migration file is never edited. It is one transaction, so an abort leaves nothing
  partial.
- **`20261021000001` changes column types** (`timestamp(3)` → `timestamp(3) WITH TIME
ZONE` for `SupportAccessGrant.expiresAt/revokedAt/createdAt` and
  `Invitation.expiresAt/acceptedAt`), dropping and re-adding the two
  `SupportAccessGrant` CHECK constraints around it. Values are reinterpreted as UTC
  instants, which is what they always were. It has been rehearsed on disposable databases
  from a fully-migrated 10/10 state; on an empty live database it is a metadata-only
  change.

Never use `migrate resolve --applied` or baselining on this project.

## 9. Step 6 — verify the new schema actually behaves (read-only probes)

Run in the SQL Editor, and treat any mismatch as a blocker:

```sql
-- 1. the fence is in the function body
SELECT pg_get_functiondef('public.has_tenant_read_access(uuid)'::regprocedure)
  LIKE '%current_tenant_id() IS NULL OR%';            -- expect true

-- 2. windows are instants
SELECT attname, format_type(atttypid, atttypmod)
  FROM pg_attribute
 WHERE attrelid = '"SupportAccessGrant"'::regclass
   AND attname IN ('expiresAt','revokedAt','createdAt')
   AND attnum > 0 AND NOT attisdropped;               -- expect timestamp(3) with time zone ×3

-- 3. both CHECK constraints survived the type change
SELECT conname FROM pg_constraint
 WHERE conrelid = '"SupportAccessGrant"'::regclass AND contype = 'c';  -- expect the two window checks

-- 4. Phase 2 landed
SELECT (SELECT count(*) FROM "Plan") AS plans,          -- expect 1
       (SELECT count(*) FROM "Permission") AS catalog,  -- expect 42
       (SELECT count(*) FROM "RolePermission") AS matrix, -- expect 116
       (SELECT data_type FROM information_schema.columns
         WHERE table_name = 'Tenant' AND column_name = 'planId'); -- expect uuid

-- 5. nothing leaked into AmisERP
SELECT count(*) FROM information_schema.routines
 WHERE specific_schema = 'amisierp';                   -- unchanged from before
```

Then, as `amisibiz_app` (a `psql` session in the **same VPC/pooler session mode**, or a
temporary app route — **never** the owner role): a `SELECT count(*) FROM "Tenant"` with
no context must return 0, and with a forged context for a tenant the caller does not
belong to must also return 0. That is proof 7 on the live database.

Do **not** point `TEST_DATABASE_URL` at this project. The harness wipes tables and
refuses `*.supabase.co` hosts by design; that guard is what keeps a test run from
touching real data.

## 10. Step 7 — record it, and what closes

Write down, in `../IMPLEMENTATION_STATUS.md` (or a dated operations note):

- the backup id/timestamp you took in §3;
- that the credential rotation in §4 happened, and which artefacts were rotated (never
  the values);
- the `pnpm db:assert-rls` exit code and its source line;
- `prisma migrate status` after §8 (expected: 13 applied, no drift);
- the §9 probe results.

That closes **S2 / #38**. Then, per the owner's gate sequence
(**#38 → apply 11 → #37**):

- **#37** closes when the CI `security` job has run at least once — which needs a push —
  or when the owner accepts the documented local rehearsal (both batteries plus the 26
  harness cases green on a disposable database) as the equivalent evidence. Its steps
  have all been executed locally; the job itself has never run on GitHub.
- **#50 / #51** are authored and verified offline; applying them in §8 is what makes
  them real for a deployed app.
- The Phase 1 gate can then open for business-feature work (Phase 05 tasks #11–#15,
  starting from the parked branch `wip/phase05-business-features`), and task **#36**
  (Supabase Storage logos) becomes the next security-adjacent item.

## 11. If something goes wrong

| Symptom                                                                   | Almost always                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `assert-rls` exits `1` after the password is set                          | the probe read `DATABASE_URL`, not `APP_DATABASE_URL` — wrong shell/environment                                                 |
| Production boot fails with "`APP_DATABASE_URL` is required in production" | the secret was never published to the deployment, or `NODE_ENV` is production now                                               |
| `permission denied` at runtime for a table the app reads                  | correct and expected if a new table shipped without the migration's grant — add the grant in a **new** migration, never by hand |
| `25P02` / aborted transaction during a scoped write                       | a policy refused it (WITH CHECK). That is the control working; find the missing context                                         |
| Migration 11 refuses to run                                               | legacy text `planId` rows — resolve the data, do not edit the migration                                                         |
| Something looks broken in AmisERP                                         | **stop**, restore the §3 backup, and treat it as an incident — the two applications share this database                         |

Under no circumstances weaken, drop, or `FORCE`-toggle an RLS policy to make a failing
check pass. Every finding in this phase was closed by a **new migration** or by a
verification script that refuses to certify a wrong state.
