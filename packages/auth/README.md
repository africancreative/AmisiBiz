# @amisibiz/auth

Authorization contracts shared by the web app and every future client
(mobile, desktop). Contains **no** Supabase or Next.js code — only the
security vocabulary of the product:

- `src/roles.ts` — `UserStatus`, `PlatformRole`, `TenantRole` unions
  (structurally identical to the Prisma enums; the database is the source of
  truth).
- `src/permissions.ts` — the single source of truth for permission strings and
  the documented role → permission policy. Deny-by-default.
- `src/session.ts` — `AppSessionUser`, the only identity shape application
  code may rely on (always the product of a validated token AND a
  session-version check against the database).

Consumed by `apps/web` via `@amisibiz/auth`. The session _resolution_ logic
(GoTrue validation, claim comparison, revocation) stays in the server app —
this package only defines the contracts.
