# @amisibiz/database

Server-side database access. **Never import this package from client code** —
it carries the Prisma client and the Supabase secret-key client. The web app
re-exports the admin factory from `src/lib/supabase/server.ts`, which is
guarded by `server-only` so a client import fails at build time.

- `src/prisma.ts` — the request-safe Prisma singleton (globalThis-cached in
  development so hot reloads do not exhaust connections).
- `src/supabase-admin.ts` — `createAdminSupabase()` for GoTrue admin
  operations only (session revocation, metadata sync, seed bootstrap).
- `src/env.ts` — lazy, zod-validated environment access. Failures name the
  exact variable; `collectSupabaseEnvProblems()` reports every problem at
  once, and `requireSupabaseEnv()` throws one aggregated error.

Env vars consumed: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
`DATABASE_URL` (read by Prisma itself; see `.env.example`).

Note: the Prisma schema, migrations and seed live in `apps/web/prisma/` —
this package consumes the generated client, it does not own the schema.
