# AmisiBiz Testing & Verification Strategy

**Status:** Canonical Quality Standard  
**Authority:** AGENT 00 — Chief Engineering Orchestrator  
**Baseline Date:** 2026-10-18

---

## 1. Test Pyramid & Scope

```
                ┌─────────────────────────────────┐
                │        E2E Tests (Future)       │  Browser journeys, Playwright
                ├─────────────────────────────────┤
                │   Database RLS Harness (CI)     │  Real Postgres, tenant boundary tests
                ├─────────────────────────────────┤
                │  Integration & Contract Tests   │  Server Actions, Route Handlers, Sync
                ├─────────────────────────────────┤
                │    Unit & Domain Pure Tests     │  Tokens, Decimals, Numbering, Zod
                └─────────────────────────────────┘
```

1. **Unit Tests:** Fast, in-memory tests verifying pure domain logic, money arithmetic, token generation, rate limiting, and input validation.
2. **Integration & Server Action Tests:** Uses `tests/prisma-mock.ts` to test server actions, role hierarchy guards, tenant lifecycle transitions, and document workflows without requiring a live database connection. Current suite: **24 test files, 558 passed / 33 skipped** (2026-10-18, working tree at HEAD `d79c520` including the owner's uncommitted in-flight work; 546/33 across 23 files at the prior `ef191dd` commit).
3. **Database RLS Harness:** Executed in CI (`.github/workflows/ci.yml`) against a real disposable PostgreSQL instance. Exercises row-level security policies directly as `amisibiz_app` role to guarantee zero cross-tenant leakage. **Current: 31/33 proofs pass** on the completed 22-migration chain; the 2 failures are the H1 permission-catalog seed gap (#87). The harness re-runs `migrate deploy` against `TEST_DATABASE_URL`, so it only ever runs against a **fresh** database — never a reconciled/live one. Offline procedure (throwaway cluster, clean-room driver, checks batteries): `docs/implementation/orchestration/acceptance-backlog.md` + the project runbook.
4. **Client Bundle Scans:** Executed via `scripts/security/scan-client-bundles.mjs` in CI to ensure no server secrets, private keys, or internal environment variables leak into client-side JS bundles. Last run: clean (248 files, 6.0 MB).
5. **Migration Verification:** Every migration chain change is proven on a throwaway/fresh database — full `prisma migrate deploy`, then `prisma migrate diff --from-url <deployed> --to-schema-datamodel prisma/schema.prisma` must print an empty migration — before any live application (live applications need explicit owner authorization).

---

## 2. Mocking Conventions & Harness

- **Prisma Mock:** Handled in `apps/web/tests/prisma-mock.ts`. Every Prisma delegate is automatically mocked with Vitest functions.
- **Scope Mocking:** Scoped database execution (`runInScope`, `sessionScope`, `bootstrapScope`) is mocked to execute callback transactions with the mock client.
- **Environment Isolation:** Tests that manipulate `process.env` must back up and restore environment variables in `beforeEach` and `afterEach` hooks.

---

## 3. Mandatory Quality Gates

No feature or bug fix may be merged or marked as complete without passing:

1. **Type-Check Gate:** `pnpm type-check` (0 errors; 10 turbo tasks across the 12 workspace packages).
2. **Lint Gate:** `pnpm lint` (0 errors).
3. **Format Gate:** `pnpm format:check` (clean).
4. **Test Suite Gate:** `pnpm test:run` (all unit and contract tests green).
5. **Build Gate:** `pnpm build` (production Next.js build succeeds with valid route manifests).
6. **Bundle Secret Scan:** `pnpm check:bundles` (clean).
7. **Dependency Audit:** `pnpm audit --prod` (exit 0; current accepted baseline: 7 transitive advisories via `next>postcss`).
8. **Database Verification:** for schema-touching changes — clean-DB deploy + empty `migrate diff` + RLS harness (per §1.5).

---

## 4. Execution Commands

```bash
# Run unit and contract tests
pnpm test:run

# Run the real-Postgres RLS harness (fresh database only)
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55499/<fresh-db> pnpm vitest run tests/integration-security.test.ts

# Run tests in watch mode for a specific file
pnpm --filter @amisibiz/web test tests/password-recovery.test.ts

# Run monorepo type-check
pnpm type-check

# Run monorepo lint
pnpm lint

# Run bundle security scan
pnpm check:bundles

# Dependency audit (prod)
pnpm audit --prod

# Verify live/candidate database matches the datamodel (read-only)
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
```
