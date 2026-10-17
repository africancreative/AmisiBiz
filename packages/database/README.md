# @amisibiz/database

Server-side database access for Neon PostgreSQL. **Never import this package from client code** —
it carries the Prisma client and scoped session credentials.

- `src/prisma.ts` — the request-safe Prisma singleton (globalThis-cached in
  development so hot reloads do not exhaust connections).
- `src/scope.ts` — AsyncLocalStorage-backed RLS scoping primitives (`enterScope`, `runInScope`, `sessionScope`, `tenantScope`).
- `src/env.ts` — lazy, zod-validated database environment access. Failures name the
  exact variable; `collectDatabaseEnvProblems()` reports every problem at
  once, and `requireDatabaseEnv()` throws one aggregated error.

Env vars consumed: `DATABASE_URL`, `DIRECT_URL`, `APP_DATABASE_URL` (see `apps/web/.env.example`).

Note: the Prisma schema, migrations and seed live in `apps/web/prisma/` —
this package consumes the generated client, it does not own the schema.
