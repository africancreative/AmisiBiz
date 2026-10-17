# AmisiBiz — Phased Implementation Checklist

- **Status:** Active plan — Phases 00–04 complete; Phase 03.5 (Supabase alignment audit) complete; Phase 04.5a (Supabase Auth swap) complete and deployed; Phase 05 documents schema + numbering deployed; **Phase 04.5b — Turborepo monorepo + shared packages + client shells + CI — complete (2026-10-14)**, executed as the owner-directed “Phase 1 — application foundation”; next: 04.5c (shadcn/ui for new UI), 04.5d/04.5e (offline + DPO/eTIMS design docs), then Phase 05 implementation resumes with the engine authored in `@amisibiz/documents`/packages. **Separately, the constitution's Phase 1 directive (core authorization, RBAC catalog and PostgreSQL RLS) is code-complete through task #35 (2026-10-14) and now DB-proven: the integration harness runs 26 cases as `amisibiz_app` against a disposable PostgreSQL and passes, with the behavioral batteries and the clean-room driver committed (#37a/#37b, 2026-10-15 — `phase-01-security-harness-report.md`), the automated bundle scan in place (#37c) and a CI `security` job authored and rehearsed step by step locally but never run (#37d). It is still not live-verified: RLS stays inert until the operator step in `../administration/rls-activation-operator-procedure.md` (#38). The Phase 05 gate was then **opened by the owner's Phase 4 directive** (2026-10-15, _"Directive opens the gate"_), so business feature work is in the tree while #37 and #38 stay open. The Phase 03/05 business code that had been parked on branch `wip/phase05-business-features` (`0a67b69`, task #52) was **resurrected and repaired** into the working tree (tasks #53/#54): the 10 type errors are gone, the missing `document-detail-client.tsx` was written, and the tree now runs **18/18** turbo tasks — **337 passed / 26 skipped**, build and format green, bundle scan clean (205 files / 5.5 MB), harness 26/26 on a fresh database, clean-room chain 78 · 71 + SKIP · 71 + SKIP · 55 · 72 PASS. It is **uncommitted** pending the owner's decision, `main`'s HEAD still ends at `22f035d`, and `0a67b69` stays as the parking record it always was.**
- **Companion docs:** `../IMPLEMENTATION_STATUS.md` (status dashboard), `phase-00-repository-audit.md` (Phase 0 audit — current), `../architecture/repository-audit.md` (historical), `../architecture/system-design.md`, `../architecture/security-model.md`, `phase-04-completion-report.md`, `phase-03.5-supabase-alignment-audit.md`, `phase-04.5b-monorepo-and-clients-audit.md`, `phase-01-foundation-report.md`, `phase-01-security-design.md` (Phase 1 directive design), `phase-01-security-harness-report.md` (the DB-backed proofs, #37a/#37b), `../RUNBOOK.md` (operations, RLS activation), `../administration/rls-activation-operator-procedure.md` (the #38 walkthrough, step by step, not executed)

Rules: implement **one phase at a time**; do not start a phase whose dependencies are unmet; every phase ends with the verification suite below green and a completion report.

---

## 1. Migration strategy

- **Engine:** Prisma Migrate against Supabase PostgreSQL.
- **Connections:** migrations use `DIRECT_URL` (and load `apps/web/.env`, so
  **both** URLs must be pinned when verifying locally — see `../RUNBOOK.md` §4.3);
  the runtime connects as the least-privileged role through
  `APP_DATABASE_URL` (pooled, `pgbouncer=true`), falling back to `DATABASE_URL`
  only outside production.
- **Baseline:** the chain is **applied and frozen** on the shared Supabase
  project (2026-10-13/14) — ten migrations in order:
  `20261013000000_init`, `20261013000001_rls_policies_and_constraints`,
  `20261014000000_phase04_branding_contacts_and_catalogue`,
  `20261015000000_phase05_documents_and_numbering`,
  `20261015000001_narrow_app_role_on_prisma_bookkeeping`,
  `20261016000000_rls_hardening_auth_tables_and_function_privileges`,
  `20261017000000_supabase_auth_alignment` (04.5a — retires the Auth.js
  tables/column), `20261018000000_uuid_identity_and_role_alignment`,
  `20261018000001_rbac_catalog_support_access_and_status_history`,
  `20261018000002_rls_enforcement_storage_and_grants` (Phase 1 directive).
  Applied files are immutable — checksum-frozen; corrections ship as new
  migrations (`prisma migrate status` verifies). The shared database already
  carried another application's `public.schema_migrations`, so a fresh
  `migrate deploy` needs the empty `_prisma_migrations` table pre-created
  (P3005 — never baseline). `prisma migrate dev` is for local authoring only.
  The offline verification procedure (throwaway cluster, `migrate diff` must be
  empty, checks suite run exactly once) and post-apply assertions
  (`prisma/scripts/phase01-migration-checks.sql`,
  `phase04-migration-checks.sql`, `phase05-migration-checks.sql` — the last two
  still assume text ids and legacy role labels, so they are stale against the
  UUID schema) are documented in `../RUNBOOK.md` §4.3 and §5, and in the Phase
  03.5 audit report §5/§10.
- **Never** use `prisma db push` against shared/staging/production databases.
- **Change discipline:** expand → backfill → contract for breaking changes; one logical change per migration; review generated SQL before applying; no manual production edits.
- **Data safety:** no destructive drops without a backup and a reversible plan; seed scripts must be idempotent and must not contain default credentials.
- **Naming:** `<timestamp>_<snake_case_summary>`; keep `migration_lock.toml` committed.
- **Rollback:** prefer forward-fix migrations; document any irreversible step in the phase report.

---

## 2. Testing strategy

| Layer          | Tool                                                            | Scope                                                           | Gate          |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| Unit           | Vitest                                                          | Pure logic, validators, guards (mocked Prisma/Auth)             | every phase   |
| Integration    | Vitest + ephemeral Postgres (Testcontainers or Supabase branch) | Real queries, tenant isolation, RBAC, transactions              | from Phase 01 |
| Contract       | Vitest                                                          | Server-action/route input→output contracts                      | from Phase 02 |
| E2E            | Playwright                                                      | Critical journeys (register, login, invite/accept, module CRUD) | from Phase 03 |
| Security suite | Vitest                                                          | Section 10 of `security-model.md`                               | every phase   |

**Definition of done for every phase:** `format`, `lint`, `type-check`,
`test:run`, `build` all green + phase-specific security tests. Coverage
thresholds to be set in Phase 07.

**Integration reality (updated 2026-10-15):** the "integration" layer now **runs
against a real database**. `apps/web/tests/integration-security.test.ts` is a DB-
backed harness — 26 cases that build fixtures as the table owner, then assert
inside `SET LOCAL ROLE amisibiz_app` — and it passes 26/26 against a disposable
PostgreSQL; the behavioral battery, the legacy fixture and the clean-room chain
driver are tracked files (`prisma/scripts/rls-behavior-battery.sql`,
`prisma/scripts/fixtures/phase1-legacy-fixture.sql`,
`scripts/db/cleanroom-chain.sh`), so the `.tmp/` scratch dependency is gone. It
still self-skips when `TEST_DATABASE_URL` is unset, so a green `pnpm test:run` on
a machine without a database proves nothing about policies. #37c and #37d are now
in the tree too: `pnpm check:bundles` scans the build output for privileged
credentials, and `ci.yml` has a `security` job that stands up a disposable
PostgreSQL 16 and runs the chain, both batteries, the harness and three
anti-vacuousness SQL assertions. Every step of that job has been executed locally
as a rehearsal (see `phase-01-security-harness-report.md` §5.2), but the job itself
has never run, because nothing has been pushed. Two of the harness's findings became
follow-up migrations rather than documented exceptions:
`20261021000000_phase1_support_read_access_scoped_to_context` and
`20261021000001_phase1_support_and_invitation_windows_are_instants` (§5.3), each
with a harness case that fails on the pre-migration schema and passes on the
post-migration one. The Phase 1
directive's gate ("no business feature work until the core authorization and RLS
tests pass") therefore **still stays shut** — its other half is operational, not
repository, and belongs to #38.

**Integration-suite safety:** the DB-backed suites read `TEST_DATABASE_URL`
and wipe tables between tests — they must point at a disposable database (the
throwaway cluster above or a scratch DB), **never at the shared Supabase
project**.

---

## 3. Minimum environment variables

| Variable                                                            | Local dev | Test           | Vercel             | Notes                                                                                                                                   |
| ------------------------------------------------------------------- | --------- | -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                                               | required  | —              | required           | public; used by metadata/links                                                                                                          |
| `NEXT_PUBLIC_APP_NAME`                                              | optional  | —              | optional           | public                                                                                                                                  |
| `DATABASE_URL`                                                      | required  | dummy (mocked) | required           | **owner-role** pooled URL — Prisma CLI only, bypasses RLS                                                                               |
| `DIRECT_URL`                                                        | required  | dummy          | required           | direct URL for migrations                                                                                                               |
| `APP_DATABASE_URL`                                                  | optional  | —              | **required**       | runtime role `amisibiz_app`; the only connection RLS applies to. Production refuses the owner-role fallback — see `../RUNBOOK.md` §2/§3 |
| `TEST_DATABASE_URL`                                                 | —         | optional       | —                  | enables `integration-security.test.ts`; disposable DB **only**                                                                          |
| `APP_BASE_DOMAIN` / `NEXT_PUBLIC_APP_BASE_DOMAIN`                   | optional  | —              | required (routing) | tenant hostname base domain                                                                                                             |
| `TRUST_PROXY`                                                       | optional  | —              | as needed          | trust `X-Forwarded-Host`                                                                                                                |
| `SEED_*`, `ALLOW_PROD_SEED`                                         | optional  | —              | optional           | super-admin bootstrap                                                                                                                   |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | required  | dummy          | required           | browser-safe; auth + session refresh                                                                                                    |
| `SUPABASE_SECRET_KEY`                                               | required  | dummy          | required           | **server-only** — never in a client bundle, log or error message                                                                        |

Tests run with mocks; `tests/setup.ts` supplies placeholder values. Never place real secrets in `.env.example` or client bundles. Auth emails are sent by the Supabase project (configure Site URL / redirect allow-list in the dashboard); `SUPABASE_SECRET_KEY` never appears with a real value in `.env.example`, client bundles, logs or error messages.

---

## 4. Phase checklist

### Phase 00 — Repository audit ✅ COMPLETE

- **Deliverables:** `repository-audit.md`, `system-design.md`, `security-model.md`, `phase-checklist.md`; `.env.example` clarified.
- **Acceptance:** accurately describes current state, identifies material risks (R1–R12), defines module boundaries, migration/testing strategies, env vars, phase plan.

### Phase 01 — Foundation (auth, tenants, minimal RBAC) ✅ SUPERSEDED BY PHASE 02

- Credentials auth, registration, initial RBAC helpers, team actions, login/register/dashboard/team UI, initial migration, safe seed.
- The role model and enforcement from this phase were replaced by the Phase 02
  authorization service and permission matrix.

### Phase 02 — Authentication, Authorization & RBAC ✅ COMPLETE

- **Delivered:** two disjoint role domains (`PlatformRole` / `TenantRole`);
  central permission definitions + documented matrix
  (`docs/architecture/permission-matrix.md`); server-side authorization service
  with deny-by-default + audited denials; register/login/logout/password-reset/
  email-verification flows; login rate limiting; session expiry + revocation;
  platform console (suspend/activate); middleware auth-bypass fix (**R1**);
  `AccountToken` (hashed, single-use); 39 passing security tests.
- **Still open:** RLS + least-privileged DB role; email transport (blocks
  production registration); distributed rate limiting; hash invitation tokens
  (**R8**); active-tenant/unique-default (**R5**); DB-backed isolation tests
  (**R7**); baseline commit (**R2**).
- **Depends on:** Phase 01.

### Phase 03 — Tenant lifecycle & provider administration ✅ COMPLETE

- **Delivered:** tenant lifecycle `PENDING | ACTIVE | SUSPENDED` with
  activation/suspension metadata; `TenantSettings`, `TenantBranding` and
  `TenantDomain` models; shared provisioning service (unique/validated slug,
  default settings/branding, hostname mapping, `PENDING` on create); owner
  provisioning by invitation only; platform lifecycle actions (`create`,
  `activate`, `suspend` with required reason, `reactivate`) — permission-gated,
  atomic (status-guarded), audited; provider admin UI (overview counts + recently
  changed, searchable/filterable tenant list, tenant detail with confirmation
  dialogs, metadata only); configurable-base-domain hostname routing with reserved
  hostnames and untrusted forwarded-host handling; new permission
  `platform.tenants.create`. 63 passing tests.
- **Superseded by the directive's Phase 2 (see "Phase 2 directive" below):** this
  line originally also claimed _"suspension blocks all workspace read/write while
  preserving data"_. The owner's Phase 2 decision replaced that with **writes and
  synchronization denied, reads and downloads preserved** —
  `../architecture/security-model.md` §4.1.
- **Still open:** DB-backed hostname verification / subdomain→tenant rewrite;
  custom-domain verification (`TenantDomain.verifiedAt`); email delivery of owner
  invitations; unique-default membership DB constraint (**R5b**).
- **Depends on:** Phase 02.

### Phase 04 — Tenant branding, contacts CRM and catalogue ✅ COMPLETE

- **Brief reconciliation:** this checklist line previously read "Contacts". The
  authoritative Phase 04 brief (sections A–F) also assigned tenant branding,
  the item/service catalogue and customer-specific catalogues, so the scope was
  widened accordingly and `Item`/`TaxCategory`/`TaxRate`/`ContactItem` landed
  here rather than in Phase 05.
- **Delivered:**
  - **Branding (A):** `TenantBranding` extended with display/registered name,
    logo, primary/secondary/accent colours, contact email/phone, postal and
    physical address, website, tax PIN, currency (KES only for now), default
    document footer, payment instructions and document layout. Hex colours are
    validated and lower-cased server-side; the primary/secondary pair is
    rejected by the Server Action when it misses the WCAG 2.1 AA 4.5:1 ratio
    (`src/lib/branding/contrast.ts` is shared with the form's live warning, so
    the browser can warn but never decide). Logo upload accepts PNG/JPEG/WebP
    only — never SVG — and classifies the file from its own bytes (magic
    signature, then dimensions parsed from the PNG IHDR, JPEG SOF segment or
    WebP VP8/VP8X/VP8L header), so neither the extension nor the declared MIME
    type is trusted; unparsable headers reject rather than pass. Files are
    written under `uploads/tenants/<tenantId>/logo/<random 32-hex>.<ext>` with
    mode `0640`, and served only through
    `GET /uploads/tenants/[...path]`, which requires an authenticated active
    member, an exact four-segment `tenants/<cuid>/logo/<32-hex>.<raster>` shape,
    and a re-check that the resolved path stays under the uploads root;
    responses are `private, no-store`, `nosniff`, sandboxed CSP, `no-referrer`.
    Live document preview in the branding form; branding CSS reaches only tenant
    surfaces (a custom property on the workspace shell), never the platform
    console, security indicators or system messages.
  - **Contacts CRM (B):** paginated/searchable list (name, company, phone,
    email), create/edit, individual vs business identity enforced by a shared
    `superRefine` on both the create and update schemas, addresses, tax PIN,
    notes, per-customer catalogue, document history and an outstanding-balance
    summary aggregated only from ISSUED/OVERDUE/PARTIALLY_PAID documents and
    returned as a decimal **string**. Archiving is soft: no contact hard-delete
    path exists, and the archive action leaves `ContactAddress` and `Document`
    rows untouched.
  - **Items and services (C):** `Item` with name, SKU, description, unit of
    measure (controlled enum), unit price as `numeric(18,4)`, currency, explicit
    `TaxCategory` + `TaxRate` (`rate` stored as a 0–1 fraction, CHECK-constrained)
    and active/inactive. Monetary values travel as decimal strings and become
    `Prisma.Decimal`; no binary floating-point arithmetic anywhere on a financial
    path.
  - **Customer-specific catalogue (D):** `ContactItem` carries the customer code,
    description, agreed price, discount percentage and availability. It is a
    separate table keyed by `(contactId, itemId)`; writing an agreed price never
    issues an `Item` update, so other customers' default prices are unaffected.
  - **Data security (E):** every read and write re-derives the tenant from
    `authorizeTenant`, destructures the locator fields and builds the payload
    field-by-field (no spreads), pins the tenant inside the `where` clause of
    each `updateMany`/`deleteMany` and fails closed when `count === 0`; query
    parameters (page, pageSize, sortBy, sortOrder) are bounded and enum-checked;
    audit rows record field **names** and ids only — never addresses, tax PINs,
    emails, prices or uploaded file names.
  - **Tests:** `tests/phase04-security.test.ts` (78) and
    `tests/phase04-logo-storage.test.ts` (28) — 106 new assertions covering
    cross-tenant reads/writes, forged cuids, suspended and pending tenants,
    privilege escalation for every `TenantRole`, mass assignment, decimal
    handling, tax-rate ownership, query bounds, unauthenticated redirects, and
    every upload/serving rejection path. Both files were mutation-checked: the
    tenant-pinned update predicate, the mass-assignment mapping, the logo
    membership check and the magic-byte gate were each deliberately broken and
    each break produced failures.
- **Defects found and fixed while verifying this phase:** JPEG dimension parsing
  read the segment length as the height (a valid 640×480 logo was rejected as
  oversized) and lossy-WebP dimensions were read one byte early with no start-code
  check; the RLS migration used snake_case columns, omitted `CREATE EXTENSION
pgcrypto` and set the tenant GUC at session scope over a pooled connection;
  the items list had inert sorting/pagination; `parsePageParam` was added so
  `?page=abc` cannot 500 a page; the "View item" control pointed at a route that
  does not exist and was removed rather than left decorative.
- **Still open / limitations:**
  - The three migrations have never been applied to a real AmisiBiz database —
    there is no reachable project DB in this environment, and neither git-ignored
    credential set authenticated. Evidence comes from `prisma migrate diff`
    (`--from-empty --to-schema-datamodel` is the canonical DDL the migrations
    reproduce, and `--from-url <verify-db>` returns `-- This is an empty
migration.`) plus applying the chain to a throwaway local cluster.
  - RLS is defined but **inert**: the policies read `app.current_tenant_id`,
    which no code sets yet, and the app still connects as the table owner. The
    application layer is the control actually in force. Wiring
    `set_config(..., true)` per request and connecting as `amisibiz_app` is
    Phase 08 work.
  - Logos live on the server filesystem; that does not survive a stateless
    serverless deploy, so Phase 06/08 should move them to provider storage with
    the same authorization contract.
  - Currency is KES-only by design (`SUPPORTED_CURRENCIES`), and there is no
    `/app/items/[id]` detail route.
  - `Document` currently stores header fields only (no line items) — the
    outstanding-balance summary is correct for what exists and is completed by
    Phase 06.
- **Acceptance (F):** met at the application layer — a business can configure
  branding, manage contacts, create products/services and assign
  customer-specific items and prices; every action is tenant-scoped; contact and
  catalogue writes never touch `Document` rows.
- **Depends on:** Phase 03 (settings).
- **Report:** `phase-04-completion-report.md` (evidence, limitations, next phase).

### Phase 03 brief — business workspace dashboard, line snapshot & offline ports ✅ IMPLEMENTED (application layer)

The Phase-3 brief's CRM, item-catalogue and customer-catalogue requirements were
already delivered inside Phase 04 (above); this entry records the remaining
surface. Distinct from "Phase 03 — Tenant lifecycle" above.

- **Delivered:** tenant business dashboard — `getDashboardOverviewAction`
  (tenant-scoped under `documents.read`, grouped counts, exact decimal-string
  outstanding totals) + `/[locale]/app` server-rendered overview with stat cards,
  recent-documents feed, outstanding-invoice card, account/branding card, quick
  actions and empty states; en/fr/sw catalogues. Exact text-based decimal
  arithmetic (`@amisibiz/documents/decimal`); the pure catalogue→document-line
  snapshot builder (`buildDocumentLineSnapshot`, copies item details/price, applies
  an available customer override **only inside its validity window**, never
  recomputes an existing line); and the tenant-scoped repository ports for a future
  SQLite/offline adapter (`@amisibiz/domain/repositories`).
- **Customer-catalogue delta (2026-10-15):** `ContactItem` gained the two terms the
  brief names that Phase 04 did not carry — a customer-specific **unit of measure**
  and a **validity window** (`validFrom`/`validUntil`, either bound open). Enforced
  at three layers: the Zod schemas (inverted pair rejected), the Server Action (a
  one-sided edit is checked against the stored window), and a migration CHECK
  constraint. Migration `20261022000000_phase03_contact_item_units_and_validity`
  is authored and the Prisma client regenerated, **not applied to the live project**.
- **Tests:** `tests/phase03-dashboard-catalogue.test.ts` (35, was 23) — dashboard
  authorization/scoping/arithmetic, snapshot immutability, exact decimal maths, an
  in-memory implementation of all three ports, and the new customer unit/validity
  rules. Cross-tenant, required-field, invalid-price, permissions, search,
  pagination and archiving cases for the CRM/item/contact-item actions, plus the
  action-level one-sided-window guard, live in `tests/phase04-security.test.ts`
  (79). Web suite total **398 passed / 26 skipped**; format/lint/type-check/build
  green.
- **Honest limits:** not browser-exercised; migration `20261022000000` is not
  applied to the live project; the snapshot builder is the canonical path but is
  not yet wired into the issuing action (Phase 05 freezes payload values after
  ownership validation); "outstanding" is invoiced-not-yet-settled; RLS still inert.
- **Report:** `phase-03-business-workspace-dashboard-report.md`.
- **Depends on:** Phase 04 (CRM/catalogue); Phase 05 (frozen lines, payment netting).

### Phase 03.5 — Supabase alignment & tenant-provisioning audit ✅ COMPLETE

- **Delivered:** audit report `phase-03.5-supabase-alignment-audit.md`;
  technology audit (no Neon/Drizzle/alternate-auth anywhere); provisioning and
  RBAC/RLS reviews against code + tests, which found and fixed four real
  database defects in a forward migration
  (`20261016000000_rls_hardening_…`): auth-table policies were never activated,
  empty-string GUCs broke the fail-closed default on pooled connections,
  `SECURITY DEFINER` functions lacked a pinned `search_path`, and the RLS
  helper functions were PUBLIC-executable. The integration security suite was
  repaired and extended with a live two-tenant RLS behavioural test
  (182/182 green across 7 files); migration chain applied to Supabase and
  verified; fresh-cluster chain diff empty; both checks suites exit 0.
- **Still open (audit §8):** Auth.js → Supabase Auth, migration-tooling
  decision, cuid-vs-UUID for offline capture, filesystem logos, RLS activation
  prerequisites, `currency ?? "USD"` sweep, distributed rate limiting, email
  transport. The constitution (2026-10-14) resolves the first three via Phase
  04.5; the rest stay scheduled in Phases 04.5/08.
- **Depends on:** Phase 03.

### Phase 04.5 — Constitution alignment of existing code (IN PROGRESS — 04.5a + 04.5b complete)

- **Trigger:** the AmisiBiz master engineering constitution (2026-10-14)
  requires Supabase Auth/Storage, Turborepo, shadcn/ui, a shared TS domain
  layer and the Capacitor/Tauri/SQLite offline architecture. The owner
  instructed that existing code be aligned **before** further phases proceed.
- **Sub-phases:**
  - **04.5a — Supabase Auth swap ✅ COMPLETE (2026-10-14):** Auth.js credentials
    stack replaced by Supabase Auth (`@supabase/ssr`): login/register/logout/
    password-reset via GoTrue; `/auth/callback` handles code+OTP email links
    with a same-app-only redirect sanitiser; middleware refreshes the session
    and gates protected routes fail-closed; `User.sessionVersion` remains the
    app-layer freshness guard, now compared against the access token's
    `app_metadata.amisibiz_session_version` claim, with revocation = DB bump →
    GoTrue session kill (1s ban + unban) → claim sync (semantics live-verified
    by probe). Migration `20261017000000` retires `Account`/`Session`/
    `VerificationToken`/`AccountToken`/`User.password`; seed bootstraps the
    GoTrue platform admin and re-identified the legacy row (FK-safe). Gates:
    format/lint/type-check/tests (184 passed, 13 DB-backed skipped) /build all
    green; migration applied to Supabase and verified (7/7, drift-free on a
    fresh cluster); live sign-in with the seeded admin succeeded. Evidence:
    `phase-04.5-constitution-alignment.md` §4. Known limits: email links need
    the dashboard Site URL/redirect allow-list; PKCE links are same-device;
    `REQUIRE_EMAIL_VERIFICATION` stays off until email delivery is verified.
  - **04.5b — Turborepo monorepo + shared packages + client shells ✅ COMPLETE (2026-10-14):**
    executed as the owner-directed “Phase 1 — application foundation”
    (deliverable record: `phase-01-foundation-report.md`). Delivered: Turborepo
    2.11.8 + pnpm workspace (`apps/*` + `packages/*`) with the existing Next.js
    app moved intact to `apps/web` (env files relocated copy→checksum→delete,
    never printed); seven source-only shared packages — `@amisibiz/config`
    (strict tsconfig bases + shared ESLint flat config), `@amisibiz/auth`
    (role unions, permission matrix, session contract), `@amisibiz/database`
    (Prisma singleton, Supabase admin client, aggregated env validation),
    `@amisibiz/domain` (validation/contrast), `@amisibiz/documents` (money,
    series, PDF contracts), `@amisibiz/sync` (offline contracts, design-only),
    `@amisibiz/integrations` (eTIMS / payments / POS boundaries, mocks only),
    `@amisibiz/ui` (21 components, deep-import subpaths); Capacitor Android
    (`apps/mobile`) and Tauri 2 Windows (`apps/desktop`) configured scaffolds
    with verified feasibility tables (JDK 17 + Android SDK present; Rust
    toolchain absent — desktop compiled nowhere, no build claimed) and Tauri
    icons generated from the brand logo; root scripts delegate via Turborepo;
    `next build` transpiles the packages; web-layer env accessors
    (`getAppUrlOrNull` production fail-closed) + route `loading.tsx`/
    `error.tsx`; CI workflow (`.github/workflows/ci.yml`: frozen-lockfile
    install → format check → lint/type-check/test/build → `sb_secret_` bundle
    guard); foundation test suite. Gates: lint + type-check 16/16 turbo tasks
    green; 201 passed / 13 skipped; production build green. Limitations: client
    shells are not compiled anywhere yet; the CI workflow's first remote run is
    pending a push; Vercel project still not created (Phase 08).
  - **04.5c — shadcn/ui adoption** for new UI (Phase 05 document screens
    first); existing components migrate when touched.
  - **04.5d — offline architecture design** (Capacitor/Tauri/SQLite, sync
    queue, tombstones, client-generated UUIDs, idempotency, revocation and
    maximum-authorization-freshness policy) — design only, before any offline
    implementation.
  - **04.5e — DPO Group / eTIMS / POS integration boundaries** — **design +
    contracts done** (the owner's "Phase 7: integration boundaries"). Provider-neutral
    ports in `packages/integrations` (`@amisibiz/integrations`), an
    explicitly-labelled mock adapter set that can never fabricate confirmation
    (a verified outcome is only constructible with `source: "provider"`), and rule
    tests in `phase045e-integration-boundaries.test.ts`; design and the
    explicit "not built" list in `../architecture/integration-boundaries.md`.
    **No live call, no credential, no payment processing, no stock deduction**;
    eTIMS stays a separate system and the POS port is extension points only.
- **Explicitly excluded:** branding and logo storage stay as shipped in Phase
  04 (owner decision, 2026-10-14). Supabase Storage for generated documents is
  planned inside Phase 05.
- **Depends on:** Phase 03.5.

### Phase 1 directive — core authorization, RBAC catalog and RLS (CODE-COMPLETE — live verification pending)

Owner directive under the constitution: identity, roles, permissions and
row-level security must exist before any business feature is built. Design
record: `phase-01-security-design.md`; enforcement status:
`../architecture/security-model.md` §13; operations: `../RUNBOOK.md`.

- **Delivered (migrations 8–10, applied live, checksum-clean, frozen):**
  `20261018000000` UUID primary keys and the nine-role alignment;
  `20261018000001` the `Permission`/`RolePermission` catalog,
  `SupportAccessGrant`, `TenantStatusHistory`; `20261018000002` the RLS policy
  families, guard triggers, `tenant-branding` storage object policies and the
  exact per-table grants for `amisibiz_app` (plus revoking the blanket
  default-privileges path migrations 2 had opened).
- **Delivered (application):** `packages/auth` role unions + 38-permission
  catalog + role→permission matrix; `packages/database` scoped client,
  transaction-local tenant context (`set_tenant_context`) and RLS probes;
  `authorizeTenant` / `authorizePlatform` / `authorizePlatformTenant` /
  `assertWritableContext`; support-access service (reason required, default 24 h,
  hard max 30 d, revocable, read-only grant set); action refactor onto the scoped
  path; audit writer that sanitises before serialising.
- **Delivered (verification & configuration):** harness aligned to production
  shapes (full-model Prisma mock, raw-`INSERT` audit inspection, UUID fixtures,
  matrix-accurate issuance — 204 passing, 13 DB-gated skips); one credential-leak
  defect found and fixed with a test that fails if it returns;
  `setup-app-role.sql` rewritten to verify rather than grant; `APP_DATABASE_URL`
  documented in `.env.example`; `pnpm db:assert-rls` added.
- **Not done (do not describe this phase as complete):**
  - **#38** operator step — `amisibiz_app` still has no password, so the runtime
    cannot connect as the role the policies were written for. **RLS is inert.**
    Procedure: `../administration/rls-activation-operator-procedure.md` (not executed).
  - **#37** — repository side closed (2026-10-15). The DB-backed harness runs the
    eight required proofs as `amisibiz_app` against a disposable PostgreSQL, the
    code↔database catalog and matrix parity is one of its cases, the behavioral
    battery is committed rather than left in scratch files, proof 8 has an automated
    bundle scan (`pnpm check:bundles`), and CI has a `security` job that runs all of
    it on runner-local Postgres. Two things keep #37 out of the "done" column: that
    job has **never executed** (no push), and the workflow's own numbers are therefore
    rehearsal numbers, not CI numbers. The harness's two findings have since become
    migrations (`20261021000000`, `20261021000001` — tasks #50, #51), verified offline.
  - **#36** Supabase Storage adoption (policies exist; the app still uses
    `/uploads`).
- **Gate this phase imposes:** _"Do not begin business feature development until
  the core authorization and RLS tests pass."_ Phase 05 (#11–#15) stays closed
  until #37 and #38 are green.

### Phase 2 directive — provider administration (CODE-COMPLETE — live verification pending)

Owner directive pack "PHASE 2 — PROVIDER ADMINISTRATION", executed 2026-10-14
(tasks #41–#45). Report: `phase-02-provider-administration-report.md`;
administrator documentation + the verified transition list:
`../administration/provider-console.md`; enforcement status:
`../architecture/security-model.md` §14; operations: `../RUNBOOK.md` §5–§7.

**Terminology:** this is the directive's _Phase 2_, not the internal "Phase 02 —
Authentication, Authorization & RBAC" or "Phase 03 — Tenant lifecycle" headings
above. Same warning as §6: read the heading's own wording.

- **Owner decisions of record (all four "Recommended" options):** plan =
  informational catalogue assigned by a permission-gated audited platform action;
  suspension = deny writes + synchronization, **allow reads and downloads**, rows
  and storage untouched, existing sessions become read-only on their next request;
  offline/synchronization = server-side rejection + audit only, with the
  `lastActivityAt` / `lastSyncAt` / `lastSyncErrorCode` indicators and a plain UI
  statement that a cached device is not reached; document previews = branding
  preview shells now, true per-document rendering in Phase 05.
- **Delivered (migration 11, authored — NOT applied to the live project):**
  `20261019000000_phase02_provider_administration_plans_and_suspension_gates` —
  `Plan`/`PlanStatus` + `Tenant.planId` converted from untyped TEXT to a UUID FK
  (loudly refusing legacy text values), the three indicator columns +
  `touch_tenant_activity()` / `record_tenant_sync_attempt()` (`SECURITY DEFINER`,
  `amisibiz_app` only), catalog 38 → **42** / matrix 112 → **116** (4 platform
  permissions, asserted inside the migration), `app_tenant_accepts_writes()`, the
  write-family policy rewrite (`has_tenant_admin_write_access`, read policies
  deliberately untouched), `tenant_provider_columns_guard_update`, the
  `TenantDomain` `DELETE` grant, `TenantDomain_one_primary_per_tenant`,
  `plan_select`, and `allocate_document_number()` redefined with the suspension
  refusal.
- **Delivered (application):** `TENANT_STATUS_TRANSITIONS` as the single source
  for UI, refusals and documentation; `transitionTenantStatus()` authorizing
  **inside** the writer and committing status + history + audit in one
  transaction; `executeProviderWrite()` for the ten other provider writes;
  `assertWritableContext` awaiting its denial audit; the `readonly` context for a
  suspended workspace in `resolveTenantContext` / `getWorkspaceState`;
  `tenant-indicators.ts` (`answerSyncRequest` + refusal codes).
- **Delivered (UI):** `/admin` overview, tenant search with status/plan filters
  and filter-preserving pagination, provisioning form, and the workspace detail
  page with lifecycle actions, suspension-reason card, profile, plan, domains +
  slug, numbering, branding with document-preview shells, owner invitation,
  status history, audit trail (own `platform.audit.read` gate, stated refusal when
  absent) and indicators. en/fr/sw catalogues.
- **Delivered (verification):** 46 new cases in
  `tests/phase02-provider-admin.test.ts` (denials per permission, atomicity, the
  write-vs-read split, the sync-answer matrix, console-read authorization);
  **256 passed / 13 skipped**; format / lint / type-check / build green; client
  bundles scanned clean; and the throwaway-cluster clean-room chain — abort probe
  refuses legacy `planId`, migration applies to `catalog=42 / matrix=116 /
planId uuid`, Phase 2 battery **55 PASS**, Phase 1 battery **67 PASS** as
  regression, `migrate diff` empty.
- **Defects found and fixed during the phase** (details in the report §3): a
  status transition performed **without a permission check**; the write-denial
  audit was not awaited; the harness could not see camelCase audit actions; no
  `plan` mock delegate; branding/settings policies had **no platform branch**
  (a provider could not have edited branding); `TenantDomain` had no `DELETE`
  grant.
- **Not done (do not describe this phase as verified live):** migration 11 is
  unapplied to the shared project (owner-gated); `answerSyncRequest()` has no
  transport caller until Phase 06, so `lastSyncAt` is `null` everywhere; no
  browser walkthrough against a live tenant; provider-side logo upload into
  Supabase Storage is still #36; DB-backed proofs are still scratch scripts (#37);
  **RLS remains inert** while `amisibiz_app` has no password (#38).
- **Gate unchanged:** the Phase 1 directive still closes business feature work —
  Phase 05 (#11–#15) stays shut until #37 and #38 pass.
  _Superseded 2026-10-15:_ the owner's Phase 4 directive opened the gate by
  direction (_"Directive opens the gate"_) while **#37 and #38 stay open**, so the
  Phase 05 code is in the tree and RLS is still inert in the deployed app.

### Phase 05 — Documents & PDF generation 🟡 IN THE WORKING TREE (gates green; uncommitted; audit halted; product gaps open)

- **Brief reconciliation:** this checklist line previously read "Documents &
  PDF generation". The brief's Phase 4 sections (quotations, invoices, delivery
  notes, numbering/issuance, payments, branding/PDF, customer portal, eTIMS
  boundary) were implemented together as Phase 05.
- **Delivered (schema layer, `20261015000000`, pre-existing):** `Document`
  (+ line/payment/status-event tables) with tenant-scoped unique numbers,
  issuance snapshots + immutability triggers, totals-identity CHECKs,
  status-per-type CHECKs, `idempotencyKey`, and
  `allocate_document_number()` (per-tenant/type/period counters under
  `FOR UPDATE`) plus `DocumentNumbering`/`DocumentNumberSequence`; the 23-check
  migration suite and `prisma/scripts/phase05-numbering-concurrency.sql`.
- **Delivered (engine):** the pure shared engine in `@amisibiz/documents` —
  exact decimal-string arithmetic (`decimal.ts`), line/document calculations
  (`calculations.ts`), the lifecycle state machine + `deriveInvoiceStatus` /
  `deriveDeliveryStatus` (`lifecycle.ts`), number composition/preview
  (`numbering.ts`), snapshot build/read (`snapshot.ts`) and the dependency-free
  A4 `renderDocumentPdf` (`pdf-writer.ts`). The server services
  (`apps/web/src/server/services/documents/**`) wrap it with Prisma + auth:
  `createDraft`, `updateDraft`, `issueDocument`, `voidInvoice`,
  `recordQuotationDecision`, `convertQuotationToInvoice`,
  `createDeliveryNoteFromDocument`, `recordDelivery`, `recordPayment`,
  `reversePayment`, `createReplacementDraft`, `getDocumentWithLines`.
- **Delivered (actions, validation, routes):**
  `apps/web/src/lib/validations/document-write.ts`; the full read + write surface
  in `apps/web/src/server/actions/document.ts` (permission chosen from the
  document's **stored** type via `authorizeByDocumentType`);
  `GET /api/documents/[documentId]/pdf` (`documents.download`) and
  `GET /api/portal/documents/[documentId]/pdf` (`portal.documents.*`, contact-
  scoped by a `contactId` predicate in the query).
- **Delivered (customer portal linkage, `20261020000000`):**
  `Contact.portalUserId` (nullable FK → `User`) + `@@unique([tenantId,
portalUserId])`, so a `CUSTOMER_PORTAL_USER` maps to at most one contact per
  tenant. Authored, **not applied** — see limitations.
- **Delivered (tests):** `tests/phase05-documents.test.ts` (46) covering
  arithmetic precision, rounding, derived status, immutable snapshots,
  corrections, quotation conversion (including the retry), numbering, PDF
  output and both routes' authorization/cross-tenant behaviour. Suite total on
  this tree: **337 passed / 26 skipped** (12 files passed, 1 skipped).
- **Delivered (UI + i18n):** the `/app/documents` list, the new-document form
  and the document detail page with the frozen-snapshot preview, status history,
  payments, and the lifecycle actions, plus PDF preview/download; en/fr/sw
  catalogues.
- **Acceptance:** unique tenant-scoped numbers; immutable issued snapshots;
  controlled correction/voiding/replacement; audited transitions; a commercial
  PDF is never presented as a KRA/eTIMS-compliant tax invoice (eTIMS remains a
  separate future integration). Met at the application layer.
- **Limitations (do not read as live-verified):** `20261020000000` is unapplied
  to the shared project (owner-gated); RLS is still inert (#38) and Storage is
  still #36; the PDF writer is a hand-rolled A4 renderer without full script
  shaping; currency is KES-only; the UI was not browser-exercised; concurrent
  numbering is a database guarantee proved by the SQL script, not the mock suite.
- **This cycle (2026-10-15, the owner's Phase 4 directive):** the parked tree was
  brought back and repaired — the 10 type errors fixed and the
  `document-detail-client.tsx` the pages imported but that never existed was
  written. Gates on that tree: **18/18** turbo tasks
  (`lint` 0 errors / 1 known `<img>` warning, `type-check` green,
  **337 passed / 26 skipped**, build green with all five document routes),
  `format:check` green, `pnpm check:bundles` clean (205 files / 5.5 MB), DB harness
  **26/26** on a fresh database, clean-room chain **78 · 71 + SKIP · 71 + SKIP · 55
  · 72 PASS / 0 FAIL**. The work is **uncommitted** pending the owner's decision.
- **Not a completion claim:** the clause-by-clause audit of the engine against every
  requirement in the directive (task #55) was **stopped by the owner** mid-review,
  so `phase-05-documents-report.md` §5 maps criteria to evidence rather than to a
  finished audit, and no part of this phase is called verified live.
- **Product gaps, not evidence gaps:** no `TaxRate` read action and no tax picker in
  the create form, so documents created through the UI are untaxed; no draft-editing
  screen although `updateDocumentDraftAction` exists; the customer portal is a
  download route with no portal UI; no test renders a multi-page document or a logo
  and no PDF was opened; the list and create screens still hardcode English while
  only the detail client and `documentEnums` are translated (en/fr/sw).
- **Note:** the old "Phase 05 — Catalogue" slot was absorbed by the expanded
  Phase 04; leftover ideas (price lists, catalogue import, bulk price edits)
  are optional extras without a phase number.
- **Depends on:** Phase 04 + Phase 04.5.
- **Report:** `phase-05-documents-report.md`.

### Phase 06 — ⤵ merged into Phase 05

- The former Phase 06 (document storage adapter — Supabase Storage signed
  URLs, `lib/pdf` renderer, issue/void/download flows) was folded into Phase 05
  when the numbering was reconciled; Supabase Storage adoption is decided
  there. Kept as a stub for traceability only.

### Phase 06 — Offline client architecture 🟡 CLIENT HALF COMPLETE, SERVER HALF NOT BUILT

- Directive scope: shared repository architecture for installed Android (Capacitor)
  and Windows (Tauri) clients — SQLite local storage, offline operations, durable
  outbox + synchronization client, platform validation, documented limits.
- Owner decisions for the phase: commit Phase 4 first (`e0a75cd`); **Android real,
  Windows documented as blocked**; **shared SQL + one driver adapter per platform**;
  **static offline client in the shells**.
- Built and green: `@amisibiz/offline` (driver abstraction, checksummed migration
  runner, local schema, repositories, `LocalOutbox`, `SyncClient`); `@amisibiz/sync`
  contracts reshaped (`entity`/`entityId`, `schemaVersion`, `serverTime`, `release()`,
  runtime `CONFLICT_RESOLUTIONS`); 31 storage tests + 17 engine tests on real SQLite;
  the bundle secret scan now also covers both shell `web/` directories.
- Not built (do not read the phase as done): `/api/sync/push` + `/api/sync/pull`, the
  bearer session wrapper, `SyncOperation` receipts, `SyncDeletion` tombstones, and any
  `revision` column on `Contact`/`Item`/`ContactItem`/`Document`; the shell UI; an
  Android project or build; any Windows build (no Rust/MSVC, and
  `@tauri-apps/plugin-sql` 2.6.0 has no transaction API).
- **Gate held:** conflict, authorization-expiry, suspension and recovery have named
  passing tests **on the device** and none against a server, so the offline feature set
  is **not** production-ready.
- **Report:** `phase-06-offline-client-report.md`; design and limits:
  `../architecture/offline-client-design.md` (§12 lists built vs not built).

### Phase 07 — Audit viewer & observability ✅ COMPLETE (repository half)

- Tasks: central `lib/audit` writer (**already existed**); audit viewer for
  platform/tenant admins; structured redacting logger; error tracking.
- Built: **recursive** redaction shared by the writer and the logger
  (`lib/redaction.ts`; a credential-shaped key is omitted at every depth, where the
  old pass only walked the top level — the one real defect this phase closed), with
  the audit-hygiene test still asserting the surviving key list; the isomorphic
  `lib/logger.ts` (one JSON record per line in production, a readable line in
  development, importing nothing server-only so a client boundary shares the exact
  rule); `lib/error-tracking.ts` (`reportError` returns a correlation digest and
  emits `message`/`stack` **only** in development); the tenant viewer at
  `/[locale]/app/settings/audit` (`audit.read` — owner/admin, plus a read-only
  support grant) and the platform viewer at `/[locale]/platform/audit`
  (`platform.audit.read`, SUPER_ADMIN only), both served by one `AuditLogViewer`
  client over `getAuditLogAction` / `getPlatformAuditLogAction`; `global-error.tsx`
  added and the locale boundary wired to `reportError`.
- **Acceptance:** privileged actions already emit audit rows through `recordAudit`;
  both viewers are permission-gated in the server action on every fetch; the 9
  Phase 07 tests lock recursive redaction (audit **and** logger), the withheld raw
  message in a non-development report, permission denial, forged-tenant denial,
  tenant scoping, the platform cross-tenant read and the page-size bound.
- **Boundary, stated explicitly:** no error-tracking SaaS is wired — that needs a
  vendor account and a credential, neither of which exists, so the integration is
  **not** claimed; `reportError` is the single boundary a backend is later pointed
  at. The viewer does not self-audit reads (walking the trail must not append to
  it); the audited event is the support grant's `support.accessUsed`.
- **Gate:** `format:check` clean, `lint` 0 errors / 1 known `<img>` warning,
  `type-check` green, **407 passed / 26 skipped**, build green with both new routes
  (`/en/app/settings/audit`, `/en/platform/audit`). Uncommitted.
- **Depends on:** Phase 03.
- **Report:** `phase-07-audit-observability-report.md`.

### AGENT 4 directive — business workspace, branding, CRM and catalogue 🟡 DELIVERED IN THE WORKING TREE (gates green; uncommitted; live-DB proof still gated on #38)

- Tasks: sections A–F of the directive — `/app/*` workspace navigation and
  dashboard, business profile and branding, customer management, catalogue
  management, customer-specific catalogue and pricing, manual data entry — under an
  acceptance gate of seven properties.
- Reality of scope: **A–E were already built across Phases 03–05**; this pass closed
  what was actually missing. Section A's "Customer portal access management" nav
  entry pointed at a page that did not exist — it is now
  `/[locale]/app/settings/portal`, backed by
  `server/actions/portal-access.ts` (`getPortalAccessOverviewAction`,
  `grantPortalAccessAction`, `revokePortalAccessAction`), gated on
  `portal.access.manage` (owner/admin only, and a write permission, so a suspended
  workspace and a support grant are refused). Section E's pricing precedence was
  resolved in the UI; task #68 moved the resolution into the server transaction
  (catalogue → override → line) and aligned the tests to `ItemStatus`' real
  vocabulary (`ACTIVE`/`INACTIVE`, no `ARCHIVED`). `/[locale]/dashboard` is now the
  forward it was documented as: platform admin with no workspace → `/admin`,
  `CUSTOMER_PORTAL_USER` → `/portal`, everyone else → `/app`, replacing a second
  untranslated copy of the overview that printed slug/status/currency outside the
  workspace guard.
- **The security shape of the portal screen:** it links `Contact.portalUserId` and
  never creates an identity or flips a role, because `tenant_member_insert` RLS
  makes the Team invitation flow the single door to `CUSTOMER_PORTAL_USER`; a
  second path from a settings screen would be strictly weaker. Every write is a
  compare-and-set on `{ id, tenantId, portalUserId }` with `count === 0` reported as
  a conflict, and the audit events carry ids only.
- **Acceptance:** 74 new cases (`agent4-portal-access.test.ts` 33,
  `agent4-acceptance-gate.test.ts` 41) over the gate lines that had no proof:
  branding writes pinned to the authorized tenant and updated by row id so no
  payload can move a record between workspaces; archiving a customer writes exactly
  `{ status, archivedAt }` and deletes nothing, with the surviving document count
  audited; and per-field error-state coverage for the four shipped forms plus
  `invalidInput()`.
- **Gaps this pass records rather than hides** (full list in the report §4): RLS
  still inert in the deployed app (#38); no DOM/RTL harness, so form error state is
  proven at the schema layer and not as rendered output; duplicate detection is
  email-only; `updateDocumentDraftAction` has no UI caller, so an issued draft's
  lines cannot be corrected; `branding-page.tsx` has no `useTranslations` at all
  (≈34 English strings, task #71); a long tail of `TenantBranding` columns
  (templates/customizations, numbering, eTIMS, Cloudinary, DPO, Mailtrap) is read by
  nothing; and the Swahili catalogue rendered "invoice" as **"Ankara"** in five
  places — now "Ingza", with the remaining Swahili wording left for a fluent
  reviewer rather than guessed at.
- **Coupling warning:** another agent states the `Contact`/`ContactItem`/`Item`
  models are **not frozen** and `/app/{items,contacts}/` is mid-remodel. This
  phase's tests are written against the current field shapes, so sections C/D/E
  need re-verification when that lands.
- **Gate:** `format:check`, `lint`, `type-check` clean; web suite green;
  `next build` succeeded with `/[locale]/app/settings/portal/page` present in
  `.next/app-path-routes-manifest.json`. Uncommitted, in a 61-entry working tree
  shared with other agents.
- **Report:** `agent-4-business-workspace-report.md`.

### Phase 08 — Hardening & release readiness

- Tasks: full security suite, RLS + least-privileged DB role, distributed rate limiting, email transport, coverage thresholds, performance/load, E2E breadth, accessibility pass, deployment config (`vercel.json`), CI pipeline, backups/DR runbook.
- **Acceptance:** green CI on PRs; documented deployment actually executed and verified; DR tested.
- **Depends on:** Phases 02–07.

---

## 5. Change-control / compatibility notes

- Do not upgrade `next-intl` to v4 without a coordinated migration (breaking).
- Do not re-enable `experimental.typedRoutes` without casting locale-prefixed hrefs.
- Keep middleware on the Node runtime while the session callback uses Prisma.
- Do not rename `AuditLog.action` values.
- Do not alter `TenantMember` uniqueness/default semantics without a data migration.
- Preserve the `authorizeTenant` / `authorizePlatform` enforcement pattern in every
  new module; never reintroduce role-list checks or trust client-supplied roles.
- Do not grant tenant roles any `platform.*` permission or vice versa.
- Keep money as decimal **strings** across the server-action boundary and
  `Prisma.Decimal` in the database. Never `parseFloat`/`Number()` a price,
  total or balance on an authoritative path (Phase 04 stores `numeric(18,4)`
  amounts, a `numeric(5,4)` tax fraction and a `numeric(5,2)` discount).
- Do not add tenant-controlled HTML or CSS to the document surfaces, and do not
  accept SVG uploads — the logo allow-list is PNG/JPEG/WebP and the serving
  route re-checks the extension. Branding reaches tenant document chrome only,
  never the platform console or security indicators.
- Contact and catalogue writes must never mutate `Document` rows; documents keep
  their own header snapshot. Contacts are archived, not deleted.
- **Supabase Auth supersedes Auth.js** (constitution, 2026-10-14): after Phase
  04.5a lands, do not reintroduce Auth.js, its adapter tables or new
  `AUTH_*`-driven session logic; read the active auth model from the repo, not
  from older docs.
- Keep `User.sessionVersion` semantics as the app-layer authorization-freshness
  guard after the auth swap (checked server-side on every request).
- The RLS model stays **server-set, fail-closed GUCs** (`set_tenant_context`
  with `NULLIF`-guarded reads) — clients never set tenant/user context, and a
  missing context must deny, not error.
- **Suspension means writes + synchronization only** (directive Phase 2): reads
  and document downloads stay available, and the read-family policies are
  deliberately untouched. Do not "tighten" this by suspending reads, and do not
  add an automatic or overdue-driven transition — `Plan` carries no entitlement
  logic.
- `TENANT_STATUS_TRANSITIONS` is the single source for which transitions exist,
  which permission each needs, which audit action it writes and which reason the
  UI must demand. Add a transition there (plus the verified list in
  `../administration/provider-console.md` §4) or not at all; never branch on raw
  status strings in a new writer.
- A suspended workspace's denial is audited **before** the error is thrown, and
  the audit append is awaited. Do not convert `assertWritableContext` into a
  fire-and-forget call, and do not let `tenant.writeDenied` / `sync.rejected`
  action names change (rule above about `AuditLog.action`).
- `lastSyncAt` stays `null` until a synchronization transport exists; do not
  fabricate a sync timestamp or a "device received the suspension" claim.

---

## 6. Immediate next action

**Terminology warning:** "Phase 1" has been used for three different things in
this repository — the original plan's `Phase 01 — Foundation` (superseded by
Phase 02), the owner's _"Phase 1 — application foundation"_ that produced the
monorepo (04.5b), and the constitution's **Phase 1 directive** (core
authorization, RBAC and RLS). Below, "Phase 1 directive" always means the last
one. Its design record is `phase-01-security-design.md`; its status is
`../architecture/security-model.md` §13.

**Completed this cycle (committed 2026-10-14 as `f0dfe59` + `b6bbea1` on `main`;
no remote push — task #30 closed by the owner's two-commit approval):**

- Phase 0 audit, 04.5a (Supabase Auth, deployed as `ed030c7`) and 04.5b
  (monorepo + shared packages + client shells + CI) remain as recorded in
  `phase-01-foundation-report.md` and
  `phase-04.5b-monorepo-and-clients-audit.md`.
- **Phase 1 directive: tasks #31–#35 and #40 complete.** Migrations
  `20261018000000` / `…000001` / `…000002` are written, applied to the live
  project, checksum-clean and frozen. UUID identity, the nine-role model, the
  38-permission catalog (extended to 42 by Phase 2; see
  `../architecture/permission-matrix.md` §2), `SupportAccessGrant`,
  `TenantStatusHistory`, RLS
  policies + guard triggers + storage object policies + least-privilege grants,
  the scoped context API (`packages/database/src/scope.ts`), the support-access
  service and the action refactor are in place. The test harness was aligned to
  production shapes (full-model Prisma mock, raw-`INSERT` audit inspection, UUID
  fixtures, matrix-accurate issuance), one real credential-leak defect in the
  audit writer was fixed and locked with a test, and operator-facing
  configuration was hardened (`setup-app-role.sql` rewritten to grant nothing,
  `APP_DATABASE_URL` documented, `pnpm db:assert-rls` added).
- **Phase 2 directive: tasks #41–#45 complete (code + docs), live verification
  not performed.** Migration `20261019000000` (plans, suspension gates, activity
  indicators, the four platform permissions) is authored and clean-room verified
  but **not applied to the live project**, so `migrate status` reports the
  repository one migration ahead of the shared database. The provider console,
  `Plan` catalogue, `Tenant.planId`, the three verified status transitions, the
  write-vs-read suspension split, the indicator columns and the append-only
  status history are in place. Records:
  `phase-02-provider-administration-report.md` (end-of-phase report) and
  `../administration/provider-console.md` (administrator documentation, incl.
  §4 "Verified list of implemented status transitions").
- **Gates:** format / lint / type-check / test:run / build green —
  Phase 1 cycle: 204 passed, 13 skipped; Phase 2 cycle: **256 passed, 13
  skipped** with 46 Phase 2 cases, plus the offline clean-room chain (abort
  probe, 55 Phase 2 PASS, 67 Phase 1 regression PASS, empty `migrate diff`).
  Client bundles scanned clean for secret-shaped values.
- **Owner decision of record:** _keep forward_ — no restore, no production
  writes; the live project stays at the Phase 1 schema with zero business data,
  and the security layer is inert until deliberately switched on. Phase 2 adds
  migration 11, which stays **unapplied there** under the same decision, so the
  provider console's live behavior is unverified by design.

**Next, in order (each owner-gated):**

1. **#38 — operator step** (`../administration/rls-activation-operator-procedure.md`,
   summarised in `../RUNBOOK.md` §3): rotate the compromised Supabase credential block,
   generate a strong `amisibiz_app` password out of band, `ALTER ROLE`, publish
   `APP_DATABASE_URL`,
   then run `pnpm db:assert-rls` and the live verification probes **only with the
   owner's explicit go-ahead**. Until this lands, RLS does not govern the running
   application, and no authorization claim here should be read as "enforced by
   the database in production".
2. **Apply migration 11 to the live project, then `20261021000000`/`20261021000001`**
   (`../RUNBOOK.md` §5, procedure §8): with
   `DATABASE_URL`/`DIRECT_URL` pinned to the session-mode pooler and the
   clean-room chain already green, `prisma migrate deploy` then re-runs
   `pnpm db:assert-rls`. It aborts loudly if any `Tenant.planId` still holds a
   legacy text label — an operator resolves the row, never the migration file.
   Once applied, migration 11 is frozen like 1–10.
3. **#37 remainder — what is actually left:** the harness, both batteries, the
   clean-room chain, the automated client-bundle secret scan (`pnpm check:bundles`,
   #37c) and the CI `security` job with its runner-local Postgres service (#37d) are
   all committed and green against a disposable PostgreSQL as `amisibiz_app`
   (`tests/integration-security.test.ts`, `prisma/scripts/rls-behavior-battery.sql`,
   `prisma/scripts/phase02-migration-checks.sql`, `scripts/db/cleanroom-chain.sh`).
   The two findings in `../architecture/security-model.md` §13.7 are now migrations —
   `20261021000000_phase1_support_read_access_scoped_to_context` and
   `20261021000001_phase1_support_and_invitation_windows_are_instants`. What is left
   is not repository work: the `security` job must actually run, which needs the push
   in item 1, or the owner must accept the documented local rehearsal as equivalent.
4. **#36 — Supabase Storage adoption** for logos (bucket + object policies exist
   in migration 10; the app still writes to `/uploads`).
5. **04.5c → 04.5d → 04.5e, and the owner's commit decision on the Phase 4 tree.**
   The Phase 05 gate was **opened by direction, not by evidence**: the owner's
   Phase 4 directive (2026-10-15, _"Directive opens the gate"_) put the document
   engine, actions, routes and UI back into the working tree while #37 and #38
   remain open, so the constitution's rule — _"Do not begin business feature
   development until the core authorization and RLS tests pass"_ — is satisfied on
   the repository half only, and **RLS is still inert in the deployed app**. The
   first action is therefore the commit decision (the tree is gate-green and exists
   nowhere but the working directory), then the halted audit (#55) and the product
   gaps in `phase-05-documents-report.md` §7.

Carried into Phase 08 rather than left implicit: distributed rate limiting,
email transport + `REQUIRE_EMAIL_VERIFICATION`, Vercel deployment config and
security headers, the CI migration-drift job, and an Android-emulator/Tauri
compile rehearsal on a machine with the full toolchains. The RLS behavioural test
(`tests/integration-security.test.ts`) runs only against a disposable database
via `TEST_DATABASE_URL` — never the shared Supabase project.
