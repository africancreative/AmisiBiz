# AmisiBiz — Agent Work Plan (authoritative backlog)

- **Status:** Active plan. Authoritative prioritised backlog for the MVP,
  written after the as-built audit at `main` @ `ddcdec9` (2026-10-17).
- **Relationship to other docs:** this plan _supersedes the ordering_ in
  `phase-checklist.md` for new work (that file remains the historical phase
  record). It is the "what next, in what order, behind which gate" companion to
  `../architecture/system-overview.md`, `../architecture/data-model.md`,
  `../architecture/security-model.md` and `acceptance-matrix.md`.
- **Rule:** no major feature implementation proceeds until the acceptance gate
  in `../architecture/system-overview.md` §13 and `acceptance-matrix.md` is met
  for the preceding item. Security-critical items (P0) come first.

---

## 1. Verified baseline (2026-10-17)

- Supabase is **fully removed** (`2fff426`); the stack is Neon PostgreSQL +
  Prisma + native HMAC cookie auth.
- Unit/contract suite is **green**: 420 passed / 26 skipped (446 tests), 18
  files; the 26 skipped are the DB-backed RLS harness.
- CI has two jobs (`verify`, `security`); the `security` job runs the 26-case
  harness against a runner-local PostgreSQL 16.
- Three product areas exist and are guarded: platform admin, business
  workspace, customer portal.

The build is healthy; the risks below are **completeness, drift, and the
not-yet-effective RLS runtime**.

---

## 2. Prioritised backlog

Priority key: **P0** security/correctness before any pilot • **P1** required by
the MVP spec • **P2** consolidation/quality • **P3** deferred/optional.

### P0 — Security & correctness (before any production pilot)

| ID   | Item                                                                                                                                                  | Why                                                                                                                                           | Evidence anchor                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0-1 | **Activate RLS for the deployed app** (create/rotate `amisibiz_app`, set `APP_DATABASE_URL`, `STRICT_APP_ROLE=true`, verify via `pnpm db:assert-rls`) | Policies exist in the schema but the app may connect as the owner role, which bypasses RLS — the strongest tenancy control is currently inert | `security-model.md` §13.1; `../administration/rls-activation-operator-procedure.md` |
| P0-2 | **Real email transport** for verification, password reset and invitations (today `lib/email` is a no-op)                                              | Reset/invite flows are security-relevant and currently non-functional in production                                                           | `apps/web/src/lib/email/index.ts`                                                   |
| P0-3 | **Email-verification route + enforcement** (`/[locale]/verify-email` does not exist; `REQUIRE_EMAIL_VERIFICATION` is not honoured end-to-end)         | Account-takeover / spam exposure                                                                                                              | `README.md` route table (wrong); message strings exist                              |
| P0-4 | **Rate-limit hardening** — confirm Redis/Upstash is mandatory in production (in-memory fallback must not silently apply)                              | Brute-force protection depends on the backing store                                                                                           | `apps/web/src/lib/security/rate-limit.ts`                                           |
| P0-5 | **Secrets review** — ensure no server secret is reachable from the client bundle; keep CI's bundle scan (`security` job) green                        | Spec requirement: no secrets in client bundles                                                                                                | CI `verify` job; `scripts/security`                                                 |

### P1 — MVP completeness

| ID   | Item                                                                                       | Notes                                                      |
| ---- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| P1-1 | **File/storage metadata model** (`StoredFile`) + migrate branding/attachments off raw URLs | `data-model.md` §5.1; needs owner decision on object store |
| P1-2 | **Invitation acceptance flow end-to-end** (send via P0-2, accept, create `TenantMember`)   | `Invitation` model is complete; delivery is the gap        |
| P1-3 | **Subscription status enum + entitlement decision**                                        | `data-model.md` §5.2–§5.3                                  |
| P1-4 | **Playwright E2E smoke suite** (login → workspace CRUD → document issue → portal download) | Spec requires Playwright; none exists                      |
| P1-5 | **Tenant self-service settings** (populate or remove `TenantSettings`)                     | `data-model.md` §5.4                                       |
| P1-6 | **Billing/invoice & reports surfaces** if in MVP scope                                     | Confirm scope with owner (see §6)                          |

### P2 — Consolidation, dead code, drift

| ID   | Item                                                                                                                                                                                                                                  | Evidence                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| P2-1 | Remove dead modules: `lib/admin/overview-queries.ts`, `lib/admin/subdomain.ts`, `ModulePlaceholder`, `tests/prisma-mock.ts` `createAdminSupabase`                                                                                     | zero importers (verified) |
| P2-2 | Collapse duplicate dashboards: `/[locale]/dashboard` vs `/[locale]/app`                                                                                                                                                               | `system-overview.md` §6.2 |
| P2-3 | Reconcile the two platform trees (`platform/*` vs `admin/*`) into one shell + IA                                                                                                                                                      | `system-overview.md` §6.1 |
| P2-4 | Move `/[locale]/team` under the workspace shell consistently                                                                                                                                                                          | `system-overview.md` §6.2 |
| P2-5 | **Fix Supabase-era leftovers in CI** (placeholder env lines, `sb_secret_` grep guard) and `next.config.mjs` `*.supabase.co` image allowance if present                                                                                | `ci.yml:36–38,79–88`      |
| P2-6 | Fix documentation drift: `system-design.md` stack/paths, `README.md` (`/verify-email`, suspension semantics, "no remote push"), `schema.prisma` Supabase comments, `phase-checklist.md`/`IMPLEMENTATION_STATUS.md` behind phases 7–11 | `system-overview.md` §14  |
| P2-7 | Decide fate of unwired packages (`@amisibiz/offline`, `@amisibiz/integrations`, `@amisibiz/domain` repository ports) — wire or document as frozen                                                                                     | `system-overview.md` §13  |

### P3 — Deferred

| ID   | Item                                                           |
| ---- | -------------------------------------------------------------- |
| P3-1 | Live eTIMS / DPO / POS integrations (currently labelled mocks) |
| P3-2 | Mobile (Capacitor) & desktop (Tauri) shell builds              |
| P3-3 | Native offline client rollout into `apps/web`                  |
| P3-4 | Migrate schema comments to native-auth wording (cosmetic)      |

---

## 3. Stable module boundaries (target contract)

Enforced as written; deviations are review findings.

```
app/**                 routing + presentation only
  └ may import: components/**, server/actions/* (types), lib/*, server/auth/*
server/actions/*       transport: zod parse → authorize → service call → ActionResult
  └ may import: server/auth/authorization, server/services/**, lib/validations, lib/audit
server/services/**     domain rules + multi-step transactions (no cookies/headers)
  └ may import: @amisibiz/database (scoped), @amisibiz/documents, @amisibiz/domain
server/auth/**         identity + tenant context + permission matrix + write gate (single source)
lib/**                 infrastructure (auth token/session, tenancy, i18n, security, audit client)
packages/database      the only PrismaClient + scope bootstrap (fail-closed)
packages/auth          permission catalogue + role matrices + session contract (DB-seeded)
packages/documents     money/decimal, numbering, lifecycle, PDF — no DB, no React
packages/domain        pure validation/contrast helpers + repository ports (ports currently unused)
```

Non-negotiables: one PrismaClient; one place that opens request scope; no
business rules in actions; no cookie/header reads in services; all user-facing
strings externalised in `messages/{en,fr,sw}`.

## 4. Integration contracts

| Boundary                           | Contract                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Browser ↔ Server Action            | Zod-validated input; discriminated `ActionResult` (`{ok}                                                              | {error}`); no stack traces |
| Session cookie ↔ Server            | HMAC-SHA256 token `{userId, sessionVersion, platformRole?, exp}`; DB recheck of `status=ACTIVE` + `sessionVersion`    |
| Bearer ↔ Sync API                  | Same session resolution via `AsyncLocalStorage` request-session override                                              |
| Service ↔ Database                 | All queries via scoped client inside a `set_tenant_context(...)` transaction; unscoped read raises `ScopeNotSetError` |
| Authorization ↔ Permission catalog | `packages/auth` matrices are code-defined and DB-seeded; a parity test asserts equality                               |
| Portal ↔ Documents                 | Portal download resolves `Contact.portalUserId`, rejects any document whose `contactId` differs                       |
| Offline client ↔ Server            | Closed operation registry; idempotent via `SyncOperation.@@unique([clientId, operationId])`                           |

## 5. Sequencing (lowest-risk order)

1. **P0 block** (RLS activation, email transport, verification, rate-limit,
   secrets) — each behind its own migration/verify step and a security review.
2. **P1-1/P1-2/P1-3** (storage model, invitations, subscription enum) — schema
   changes with backup/verify per the migration policy.
3. **P1-4** (Playwright smoke) — locks in the above.
4. **P2** cleanup can run in parallel where it does not touch P0/P1 code paths.
5. **P3** only after MVP acceptance.

## 6. Decisions requiring explicit owner approval

1. **Object storage backend** for private files (Cloudinary vs S3-compatible vs
   Neon-hosted) and whether a `StoredFile` metadata table is mandatory.
2. **Plans are billing-enforced or informational-only** (drives P1-3).
3. **MVP feature scope** — are billing/invoices and reporting surfaces in scope
   for the MVP, or deferred (affects P1-6)?
4. **Portal access model** — first-class `CustomerPortalMembership` vs the
   current `Contact.portalUserId` link.
5. **Email provider** choice for P0-2.
6. **Production RLS cut-over window** (P0-1 requires a maintenance-safe
   connection-string change and rollback plan).

## 7. Definition of done (per item)

An item is done when: code merged with tests (unit or integration), the mocked
suite stays green, any DB change has a committed migration plus a
backup/verify note, documentation touched by the change is updated, and the
relevant row in `acceptance-matrix.md` is flipped from ⛔/⚠️ to ✅ with evidence.
