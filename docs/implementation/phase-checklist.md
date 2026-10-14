# AmisiBiz — Phased Implementation Checklist

- **Status:** Active plan — Phases 00–04 complete; Phase 03.5 (Supabase alignment audit) complete; Phase 05 documents schema + numbering deployed; next: **Phase 04.5 — constitution alignment**, then Phase 05 completion.
- **Companion docs:** `../architecture/repository-audit.md`, `../architecture/system-design.md`, `../architecture/security-model.md`, `phase-04-completion-report.md`, `phase-03.5-supabase-alignment-audit.md`

Rules: implement **one phase at a time**; do not start a phase whose dependencies are unmet; every phase ends with the verification suite below green and a completion report.

---

## 1. Migration strategy

- **Engine:** Prisma Migrate against Supabase PostgreSQL.
- **Connections:** migrations use `DIRECT_URL`; runtime uses pooled `DATABASE_URL` (`pgbouncer=true&connection_limit=1`).
- **Baseline:** the chain is **applied and frozen** on the shared Supabase
  project (2026-10-13/14) — six migrations in order:
  `20261013000000_init`, `20261013000001_rls_policies_and_constraints`,
  `20261014000000_phase04_branding_contacts_and_catalogue`,
  `20261015000000_phase05_documents_and_numbering`,
  `20261015000001_narrow_app_role_on_prisma_bookkeeping`,
  `20261016000000_rls_hardening_auth_tables_and_function_privileges`.
  Applied files are immutable — checksum-frozen; corrections ship as new
  migrations (`prisma migrate status` verifies). The shared database already
  carried another application's `public.schema_migrations`, so a fresh
  `migrate deploy` needs the empty `_prisma_migrations` table pre-created
  (P3005 — never baseline). `prisma migrate dev` is for local authoring only.
  The offline verification procedure (throwaway cluster, `migrate diff` must be
  empty, checks suite run exactly once) and post-apply assertions
  (`prisma/scripts/phase04-migration-checks.sql`,
  `phase05-migration-checks.sql`) are documented in the Phase 03.5 audit
  report §5/§10.
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

**Definition of done for every phase:** `type-check`, `lint`, `test`, `build` all green + phase-specific security tests. Coverage thresholds to be set in Phase 07.

**Integration-suite safety:** the DB-backed suites read `TEST_DATABASE_URL`
and wipe tables between tests — they must point at a disposable database (the
throwaway cluster above or a scratch DB), **never at the shared Supabase
project**.

---

## 3. Minimum environment variables

| Variable                                          | Local dev | Test                     | Vercel             | Notes                          |
| ------------------------------------------------- | --------- | ------------------------ | ------------------ | ------------------------------ |
| `NEXT_PUBLIC_APP_URL`                             | required  | —                        | required           | public; used by metadata/links |
| `NEXT_PUBLIC_APP_NAME`                            | optional  | —                        | optional           | public                         |
| `DATABASE_URL`                                    | required  | dummy (mocked)           | required           | pooled Supabase URL            |
| `DIRECT_URL`                                      | required  | dummy                    | required           | direct URL for migrations      |
| `AUTH_SECRET`                                     | required  | dummy (`tests/setup.ts`) | required           | ≥ 32 bytes                     |
| `AUTH_URL`                                        | required  | —                        | optional (derived) | local dev only                 |
| `AUTH_TRUST_HOST`                                 | optional  | —                        | as needed          | for non-Vercel hosts           |
| `APP_BASE_DOMAIN` / `NEXT_PUBLIC_APP_BASE_DOMAIN` | optional  | —                        | required (routing) | tenant hostname base domain    |
| `TRUST_PROXY`                                     | optional  | —                        | as needed          | trust `X-Forwarded-Host`       |
| `SEED_*`, `ALLOW_PROD_SEED`                       | optional  | —                        | optional           | super-admin bootstrap          |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from 04.5a | dummy | required | browser-safe; auth + session refresh |
| `SUPABASE_SECRET_KEY`                             | from 04.5a | dummy    | required           | **server-only** — never in a client bundle, log or error message |
| `SMTP_*`, `EMAIL_FROM`                            | optional  | —                        | optional           | auth emails move to Supabase project config in 04.5a |

Tests run with mocks; `tests/setup.ts` supplies placeholder values. Never place real secrets in `.env.example` or client bundles. The `AUTH_*` rows belong to the Auth.js stack and are retired when Phase 04.5a lands; `SUPABASE_SECRET_KEY` never appears with a real value in `.env.example`, client bundles, logs or error messages.

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
  hostnames and untrusted forwarded-host handling; suspension blocks all
  workspace read/write while preserving data. New permission
  `platform.tenants.create`. 63 passing tests.
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

### Phase 04.5 — Constitution alignment of existing code (NEXT)

- **Trigger:** the AmisiBiz master engineering constitution (2026-10-14)
  requires Supabase Auth/Storage, Turborepo, shadcn/ui, a shared TS domain
  layer and the Capacitor/Tauri/SQLite offline architecture. The owner
  instructed that existing code be aligned **before** further phases proceed.
- **Sub-phases:**
  - **04.5a — Supabase Auth swap:** replace the Auth.js credentials stack
    (login/register/reset/session/revocation/middleware) with Supabase Auth
    (`@supabase/ssr`); keep `User.sessionVersion` as the app-layer
    authorization-freshness guard; retire obsolete auth tables in a forward
    migration. Rules in force: local tenant status is never authoritative;
    never claim an unverified flow works.
  - **04.5b — Turborepo monorepo + shared domain package:** restructure to
    `apps/web` + `packages/domain` (pure calculation/lifecycle/numbering
    logic) so the Capacitor/Tauri clients can reuse it — lands before Phase 05
    services are written.
  - **04.5c — shadcn/ui adoption** for new UI (Phase 05 document screens
    first); existing components migrate when touched.
  - **04.5d — offline architecture design** (Capacitor/Tauri/SQLite, sync
    queue, tombstones, client-generated UUIDs, idempotency, revocation and
    maximum-authorization-freshness policy) — design only, before any offline
    implementation.
  - **04.5e — DPO Group / eTIMS interface design** (design only — no simulated
    live payments, no undocumented DPO assumptions, eTIMS stays separate).
- **Explicitly excluded:** branding and logo storage stay as shipped in Phase
  04 (owner decision, 2026-10-14). Supabase Storage for generated documents is
  planned inside Phase 05.
- **Depends on:** Phase 03.5.

### Phase 05 — Documents & PDF generation (IN PROGRESS — paused for 04.5)

- **Delivered (schema layer, applied via `20261015000000`):** `Document`
  (+ line/payment/status-event tables) with tenant-scoped unique numbers,
  issuance snapshots + immutability triggers, totals-identity CHECKs,
  status-per-type CHECKs, `idempotencyKey`, and
  `allocate_document_number()` (per-tenant/type/period counters under
  `FOR UPDATE`) plus `DocumentNumbering`/`DocumentNumberSequence`; the 23-check
  migration suite and `prisma/scripts/phase05-numbering-concurrency.sql`;
  read-only server actions (`getDocumentsAction`, `getDocumentAction`).
- **Remaining:** calculation engine + numbering service
  (`src/server/services/documents/**`); create/update/issue/void/payment/
  conversion server actions + lifecycle state machine; tenant-branded PDF
  renderer + download route; `/app/documents` UI + i18n; Phase 05 tests, gate
  and completion report.
- **Acceptance:** unique tenant-scoped numbers; immutable issued snapshots;
  controlled correction/voiding/replacement; audited transitions; a commercial
  PDF is never presented as a KRA/eTIMS-compliant tax invoice (eTIMS remains a
  separate future integration).
- **Note:** the old "Phase 05 — Catalogue" slot was absorbed by the expanded
  Phase 04; leftover ideas (price lists, catalogue import, bulk price edits)
  are optional extras without a phase number. Implementation must not resume
  until Phase 04.5 has aligned the existing code.
- **Depends on:** Phase 04 + Phase 04.5.

### Phase 06 — ⤵ merged into Phase 05

- The former Phase 06 (document storage adapter — Supabase Storage signed
  URLs, `lib/pdf` renderer, issue/void/download flows) was folded into Phase 05
  when the numbering was reconciled; Supabase Storage adoption is decided
  there. Kept as a stub for traceability only.

### Phase 07 — Audit viewer & observability

- Tasks: central `lib/audit` writer (done); audit viewer for platform/tenant admins; structured redacting logger; error tracking.
- **Acceptance:** privileged actions emit audit rows; viewer permission-gated; no secrets/PII leakage in logs.
- **Depends on:** Phase 03.

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

---

## 6. Immediate next action

Phase 03.5 is complete and committed. Phase 05's schema/numbering layer is
already deployed, but **implementation must not continue until the constitution
alignment of the existing code (Phase 04.5) is executed** — starting with the
Supabase Auth swap (04.5a), then the Turborepo/domain restructure (04.5b)
before any Phase 05 service code is written. Branding (Phase 04) is explicitly
out of scope for the alignment (owner decision, 2026-10-14).

Carried into Phase 08 rather than left implicit: activating RLS (per-request
`set_config`, connecting as `amisibiz_app`), distributed rate limiting, email
transport verification, and production deployment config. The RLS behavioural
test (`tests/integration-security.test.ts`) runs only against a disposable
database via `TEST_DATABASE_URL` — never the shared Supabase project.
