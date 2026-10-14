# Phase 1 (owner directive) — Application foundation: execution record

- **Status:** Executed 2026-10-14; **committed as `f0dfe59`** on 2026-10-14 after
  the owner approved a two-commit split (no remote push). Was the subject of the
  Phase 0 audit while it sat in the working tree.
- **Directive:** "Implement Phase 1 of AmisiBiz: establish the application
  foundation" — workspaces `apps/web`, `apps/mobile`, `apps/desktop`,
  `packages/{domain,database,auth,ui,documents,sync}`, with strict TS,
  lint/format, env validation, app shell, screens, accessible nav/loading/error
  states, automated checks and README. "Do not begin CRM or financial document
  implementation in this phase."
- **Relation to 04.5b:** this directive expanded the
  `phase-04.5b-monorepo-and-clients-audit.md` §2.1 minimum layout (single
  domain package) into the constitution-aligned split below; the audit remains
  the plan record, this is the execution record.

## Delivered

| # (directive)                     | Deliverable                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Strict TS config               | `@amisibiz/config` tsconfig bases (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) extended by every workspace                                                       |
| 2. Consistent lint/format         | Shared ESLint flat config (`base` + plugin-free `shared` overlay composed with Next presets); Prettier at root (`format`, `format:check`); `.prettierignore` for pnpm-managed files      |
| 3. Env validation                 | `@amisibiz/database` zod suite: aggregated problem lists + single aggregated throw + `.env.example` pointers, lazy getters; web accessors (`getAppUrlOrNull` fails closed in production) |
| 4. Responsive app shell           | Existing auth/workspace/admin shells moved intact to `apps/web` (mobile drawer via native `<dialog>`, `aria-expanded`)                                                                   |
| 5. Dashboard/sign-in/unauthorized | Existing screens preserved (dashboard, login/register, access-denied states)                                                                                                             |
| 6. Accessible nav + states        | Nav preserved; **new** route-level `loading.tsx` (spinner, translated) and `error.tsx` (client, logs name+digest only — never `error.message`), i18n keys added for en/fr/sw             |
| 7. Automated checks               | Turborepo tasks (`build` with `^build`, `lint`, `type-check`, `test:run`, persistent `dev`); root delegation scripts; **new CI workflow** `.github/workflows/ci.yml`                     |
| 8. README                         | Rewritten for the monorepo: layout map, setup, env loading convention, workspace commands, routes, security rules, doc map                                                               |

## Workspace layout (11 projects)

`apps/web` (the product, moved intact; env files relocated copy→checksum→delete,
never printed) · `apps/mobile` (Capacitor 8 scaffold) · `apps/desktop`
(Tauri 2 scaffold) · `packages/config|auth|database|domain|documents|sync|ui`
— source-only packages (`exports` → `./src/*.ts(x)`, no build step), compiled
by Next via `transpilePackages`; `@amisibiz/ui` is consumed via deep imports
(no barrel — `Select` name collision between two modules); no runtime
cross-imports between packages (verified by grep — no cycles).

Shared contracts added while extracting: role unions mirroring the Prisma
enums (`@amisibiz/auth`), Supabase env guards + Prisma singleton + admin
client (`@amisibiz/database`), money/series/PDF contracts
(`@amisibiz/documents`), offline queue/conflict contracts (`@amisibiz/sync`,
design-only), `cn` + 21 components (`@amisibiz/ui`).

## Client shells (scaffolds only — no build claimed)

Both shells are pinned, configured and documented; **neither has been compiled
in this environment**:

- `apps/mobile` — Capacitor 8.5.3, `com.amisigenuine.amisibiz`, `webDir` +
  placeholder, **no `server.url`** (remote-URL shape deliberately not chosen —
  04.5d decides). Feasibility verified: JDK 17 + Android SDK present; commands
  documented, never executed.
- `apps/desktop` — Tauri 2, `frontendDist` placeholder, MSI/NSIS targets,
  core-only capabilities, **icons generated** from the brand logo via the
  prebuilt CLI (all `tauri.conf.json` icon paths exist). Rust toolchain
  absent → cannot compile here; README states this explicitly.

## Verification evidence

- Baseline preserved across the move: 184 passed / 13 skipped before → same
  after the restructure; then extended with `tests/phase1-foundation.test.ts`
  (17 tests: real package imports, env-guard aggregation, permission policy,
  money/series contracts, app-URL fail-closed) → **201 passed / 13 skipped**.
- `turbo run lint type-check` 16/16 across the 8 script-bearing workspaces
  (mobile participates; desktop intentionally has no lint/type-check scripts).
- Production build (`next build`) green — full route tree, server/client
  boundaries intact (admin client stays behind `server-only`).
- **Pristine-copy CI rehearsal** (no `node_modules`, no `.env`): frozen-lockfile
  install + postinstall Prisma generate OK; 18/18 turbo tasks green cold;
  secret scan clean after refining the guard to a value-shaped pattern (the
  bare `sb_secret_` prefix is legitimate Supabase library code).
- Formatting: 15 stray files fixed during the rehearsal; `format:check` green.

## Limitations (no unverified claims)

- The CI workflow has **never run on GitHub** — the sequence above was
  rehearsed locally from a pristine copy only.
- No Android or Windows build has been produced anywhere; app-store submission
  is far future.
- Vercel is not configured and no deployment was performed.
- RLS remains inert; offline/SQLite and DPO/eTIMS are design-gated (04.5d/04.5e).
- Everything above was the owner's to commit, and is now in `f0dfe59`; no remote
  push has been made.
