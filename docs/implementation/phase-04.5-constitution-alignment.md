# Phase 04.5 — Constitution alignment of existing code

**Status:** IN PROGRESS — **04.5a (Supabase Auth swap) COMPLETE and deployed** (2026-10-14); next sub-phase is 04.5b (Turborepo + shared domain).
**Trigger:** the AmisiBiz master engineering constitution (2026-10-14) requires
Supabase Auth / Storage, Turborepo, shadcn/ui, a shared TypeScript domain layer
and the Capacitor/Tauri/SQLite offline architecture. The owner instructed that
the existing code be aligned before further phases proceed. **Branding is
explicitly out of scope** (owner correction, same day): Phase 04 branding and
the filesystem logo storage stay as shipped.

This document supersedes, where they conflict, the Phase 03.5 audit's
"retained Auth.js / retained Prisma Migrate" notes (§2/§8 there):
the constitution now mandates **Supabase Auth**; this phase executes the swap.

---

## 1. Gap analysis (constitution vs. current code)

| Constitution requirement           | Current state                                            | Action                 |
| ---------------------------------- | -------------------------------------------------------- | ---------------------- |
| Next.js App Router + strict TS     | In place                                                 | —                      |
| Supabase PostgreSQL + RLS          | In place (6 frozen migrations, hardened RLS)             | —                      |
| **Supabase Auth**                  | Auth.js v5 credentials stack                             | **04.5a (this phase)** |
| Supabase Storage                   | Filesystem logos (out of scope); documents storage later | Phase 05               |
| Turborepo monorepo                 | Single Next.js app                                       | 04.5b                  |
| Tailwind + shadcn/ui               | Tailwind in place; hand-rolled UI components             | 04.5c                  |
| Shared TS domain layer             | Logic embedded in `src/`                                 | 04.5b (with monorepo)  |
| Capacitor / Tauri / SQLite offline | Not present                                              | 04.5d (design)         |
| Zod, server-side authz, tests      | In place                                                 | —                      |
| DPO Group / eTIMS                  | Not present                                              | 04.5e (design only)    |

## 2. Verified Supabase Auth semantics (live probe, 2026-10-14)

`prisma/scripts/verify-supabase-auth.mts` ran against the real project
(disposable user created and deleted; no email sent):

1. `admin.createUser` (email_confirm) works; `signInWithPassword` issues a
   session whose access-token JWT **embeds `app_metadata` as of issue time**.
2. `admin.updateUserById({ app_metadata })` merges custom keys;
   `refreshSession({ refresh_token })` re-embeds the **current** app_metadata
   and rotates the refresh token.
3. Old access tokens **survive** an app_metadata bump at GoTrue level —
   therefore revocation must additionally be enforced **server-side** by
   comparing the token claim with the database.
4. `updateUserById({ ban_duration: "1s" })` **permanently deletes the user's
   sessions** (a pre-ban refresh token fails even after unban); unban
   (`ban_duration: "none"`) restores sign-in.
5. `admin.signOut(jwt)` is by-JWT only — not usable server-side for kill-by-id.

**Consequence — revocation design:** `revokeUserSessions(userId)` becomes:
bump `User.sessionVersion` → admin ban (1s) + unban (session kill) → sync
`app_metadata.amisibiz_session_version` (claim marker). Old access tokens are
rejected at our server immediately (claim ≠ DB); refresh tokens are really
dead. If the kill or sync fails, the flow stays **fail-closed**: old tokens
fail the claim check, refreshed tokens fail until a fresh sign-in heals
(`loginAction` compares claim with DB and re-syncs + refreshes when drifted).

**Honest limits (documented):** an already-issued access token remains valid
at GoTrue for its TTL (default 1 h) — our server rejects it; Supabase-managed
email links require the project's Site URL / redirect allow-list to be
configured in the dashboard (not settable from this environment).

## 3. 04.5a — file inventory

**New:** `src/lib/supabase/server.ts` (server-only factories),
`src/lib/supabase/middleware.ts`, `src/lib/auth/session-user.ts`,
`src/lib/auth/redirects.ts`, `src/app/auth/callback/route.ts`,
`prisma/migrations/20261017000000_supabase_auth_alignment/migration.sql`,
`prisma/scripts/verify-supabase-auth.mts` (kept as ops evidence),
`tests/phase045-auth.test.ts`, `tests/supabase-mock.ts`,
`tests/stubs/{server-only,next-headers}.ts`, this document.

**Rewritten:** `src/lib/auth/session.ts` (claim reader + revocation),
`src/server/actions/auth.ts` (register/login/logout/forgot/update-password),
`src/middleware.ts`, `prisma/seed.ts` (GoTrue admin bootstrap + FK-safe
identity swap), `src/components/auth/*` (login, register, sign-out,
reset-password), `src/app/[locale]/{page,reset-password}`,
`src/app/uploads/tenants/[...path]/route.ts` (uploads guard now uses
`getSessionUser()`), `tests/auth-mock.ts` + 4 test files' mock target,
`tests/integration-security.test.ts`, `tests/setup.ts`, `vitest.config.ts`,
`.env.example`.

**Deleted:** `src/lib/auth/config.ts`, `src/app/api/auth/[...nextauth]/route.ts`,
`src/types/next-auth.d.ts`; deps `next-auth`, `@auth/prisma-adapter`,
`bcryptjs`.

**Unchanged:** all tenant/platform/contact/item/branding actions (they consume
`requireAuth()`/`session.user.id` — the helper keeps its contract), the
authorization service, RLS model (server-set fail-closed GUCs), branding.

## 4. Execution record

**04.5a complete and deployed — 2026-10-14.**

### Gates (run after all source changes; all green)

| Gate       | Command           | Result                                                                                                                                                                                                                                            |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format     | `pnpm format`     | clean (idempotent)                                                                                                                                                                                                                                |
| Lint       | `pnpm lint`       | 0 errors, 0 warnings                                                                                                                                                                                                                              |
| Type-check | `pnpm type-check` | clean                                                                                                                                                                                                                                             |
| Tests      | `pnpm test:run`   | **184 passed / 13 skipped** (DB-backed, need `TEST_DATABASE_URL`) across 7 files + 1 new file — `tests/phase045-auth.test.ts` (15 tests: claim reader, validity, revocation order/skip-sync, open-redirect barrier, `getSessionUser` trust chain) |
| Build      | `pnpm build`      | compiled; `/auth/callback` route present; middleware on the nodejs runtime                                                                                                                                                                        |

Test-infrastructure changes this phase: `tests/auth-mock.ts` now stands in for
`@/lib/auth/session-user`; new `tests/supabase-mock.ts` (admin + request
clients, with `resetSupabaseMocks()`); `tests/setup.ts` supplies Supabase env
placeholders; `vitest.config.ts` aliases `server-only` and `next/headers` to
`tests/stubs/*` so server modules load outside the react-server condition.
`tests/integration-security.test.ts` was updated for the retired columns
(`password`, `accountToken`).

### Migration: offline verification → live apply

1. Fresh database on the throwaway cluster (127.0.0.1:55499): **all seven
   migrations applied in timestamp order**, exit 0.
2. `prisma migrate diff --from-url <scratch> --to-schema-datamodel` →
   `-- This is an empty migration.` (the chain reproduces the datamodel; no
   drift).
3. Live project: `pnpm db:migrate:deploy` applied
   `20261017000000_supabase_auth_alignment`; `prisma migrate status` → 7/7 up
   to date.
4. Post-apply assertions against live SQL: `public` no longer contains
   `Account`, `Session`, `VerificationToken` or `AccountToken`;
   `User.password` column and the `AccountTokenPurpose` enum are gone.

### Seed / live sign-in (Supabase Auth)

- Seed ensured the GoTrue identity for the platform admin
  (`amisi@amisigenuine.com`) and re-identified the legacy profile row
  (`cmv7kj2s3…` cuid → `e1d95b41-148b-45da-aa28-44b88d671cfb`); the FK
  cascade applied and there were no dependent membership/audit rows.
- Live `signInWithPassword` (publishable key, server-side) with the seeded
  credential **succeeded**. The issued access token carried no
  `amisibiz_session_version` claim → `readSessionVersionClaim` reads 0, which
  matches `User.sessionVersion = 0`, so the `getSessionUser` trust chain
  accepts the session. The test session was then locally signed out.

### Known limitations (deliberate, documented)

- An already-issued access token remains acceptable **at GoTrue** until its
  natural TTL (default 1 h); our server rejects it immediately via the claim
  check (fail-closed). This asymmetry is the designed revocation model.
- Supabase-managed email links require the dashboard **Site URL / redirect
  allow-list** — not settable from this environment. Default email templates
  use PKCE code links (same-device); if cross-device links are needed later,
  switch templates to the token-hash form (the callback supports both).
- `REQUIRE_EMAIL_VERIFICATION` stays **off** until email delivery is verified;
  the gate itself is implemented and testable independently.
- Middleware performs the per-request token refresh; Server Components cannot
  persist rotated cookies (read-only store, handled gracefully) — an accepted
  design that relies on middleware always running.
- 13 DB-backed integration tests stay skipped without `TEST_DATABASE_URL`
  (disposable cluster only — never the shared project).
