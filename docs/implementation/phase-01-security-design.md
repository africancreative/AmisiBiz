# Phase 1 — Security foundation design (design lock)

Status: **locked 2026-10-14**, implementation in progress. Owner directive:
"Phase 1: Foundation, Supabase and RBAC" — implement the security foundation;
business features stay blocked until the eight required authorization/RLS
tests pass.

This document records the design decisions, the interpretation of every
ambiguous point in the directive, and the exact verification strategy **before**
any SQL or code was written. It is the contract the implementation and the
final completion report will be measured against.

---

## 1. Constraints and environment facts (verified, not assumed)

| Fact                                                                                                                | Consequence                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Docker, no Supabase CLI on this machine; PostgreSQL 18.4 `initdb`/`pg_ctl`/`psql` available                      | The "local Supabase integration or equivalent" is a **native throwaway PostgreSQL cluster** (port 55499, `TEST_DATABASE_URL`-gated), matching the verified Phase 03.5/04 procedure. Supabase-hosted RLS semantics are standard PostgreSQL RLS — the equivalent environment is honest, and limitations are documented. |
| Live Supabase project is **shared with AmisERP** (separate app, `schema_migrations`)                                | Migrations touch only AmisiBiz tables. One security remediation is required anyway (§8): the Phase 03 migration granted `amisibiz_app` blanket `GRANT ... ON ALL TABLES IN SCHEMA public` + default privileges, which sweep in **the other app's tables**. Must be revoked.                                           |
| RLS policies exist (20 tables) but are **inert**: no code sets the GUC context, runtime connects as the table owner | Enforcement means: (a) runtime connects as `amisibiz_app`, (b) every tenant/platform query runs in a transaction that sets the GUC context first, (c) policies are completed for all pre-context flows.                                                                                                               |
| Existing PKs are `TEXT` cuid; `User.id` is already a Supabase auth UUID                                             | UUID requirement (§4) → forward migration converting all 20 tables, with backfill. `User.id` is a clean cast; business tables need an id remap.                                                                                                                                                                       |
| Existing table names are Prisma-default PascalCase (`Tenant`, `TenantMember`…)                                      | Kept. The directive's names ("tenants", "tenant memberships"…) are concepts; a rename adds churn and zero security value. Concept → table mapping is in §4.                                                                                                                                                           |

## 2. Role model (9 roles)

Platform domain (on `User.platformRole`, now **nullable** — null means "no
platform privileges"; it never grants tenant data):

| Directive name       | Enum          | Notes                                                                                                                                                                         |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platform_super_admin | `SUPER_ADMIN` | Amisi Genuine internal administration. Only role that manages platform domain + grants support access. Tenant-data access only through an explicit, audited platform context. |
| platform_support     | `SUPPORT`     | **No permissions by default.** Tenant data only via a time-boxed, audited support grant (§6), read-only.                                                                      |

Tenant domain (on `TenantMember.role`):

| Directive name       | Enum                   | Notes                                                                                                                                                   |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenant_owner         | `TENANT_OWNER`         | Full workspace control. Sole role that may grant/revoke the owner role.                                                                                 |
| tenant_admin         | `TENANT_ADMIN`         | All routine operations **including member management** (guards below). Cannot create/modify/remove owners. [Interpretation §11.5]                       |
| sales                | `SALES`                | Contacts + catalogue (no deletes), quotations end-to-end; invoices/delivery notes read-only; cannot void.                                               |
| finance              | `FINANCE`              | Invoices end-to-end (issue/void), payments later; quotations/delivery notes read-only; exports.                                                         |
| operations           | `OPERATIONS`           | Catalogue create/update; delivery notes end-to-end; quotations/invoices read-only.                                                                      |
| viewer               | `VIEWER`               | Read-only (settings, members list, branding, contacts, items, documents read/download).                                                                 |
| customer_portal_user | `CUSTOMER_PORTAL_USER` | Portal only: own documents read/download. **No internal records** — enforced in app permissions and in RLS (internal-table policies exclude this role). |

Legacy enum remap (existing rows): `BUSINESS_OWNER→TENANT_OWNER`,
`BUSINESS_ADMIN→TENANT_ADMIN`, `DOCUMENT_MANAGER→OPERATIONS` [§11.4],
`SALES_STAFF→SALES`, `VIEWER→VIEWER`; platform `PLATFORM_ADMIN→SUPER_ADMIN`,
`PLATFORM_SUPPORT→SUPPORT`, `USER→NULL`.

Separation invariant (kept from the existing authorization service): a
`platform.*` permission is granted to no tenant role, and a tenant permission
to no platform role. Owners can never grant platform permissions because
platform permissions are not reachable from any tenant-membership operation.

## 3. Permission catalog and matrix

Source of truth: `packages/auth/src/permissions.ts` in code, **mirrored into
the database** as `Permission` + `RolePermission` catalog tables (directive
lists "permissions" in the schema), seeded by migration and kept honest by a
parity test (code catalog ≡ DB catalog, both directions).

New/changed keys by directive area:

| Area                 | Keys                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| tenant management    | `business.settings.read/update` (existing)                                                  |
| branding             | `business.branding.read/update` (new — previously folded into settings)                     |
| membership           | `business.members.read/manage` (existing)                                                   |
| contacts             | `contacts.read/create/update/delete` (existing)                                             |
| items                | `items.read/create/update/delete` (existing)                                                |
| quotations           | `documents.quotation.create/update_draft/issue/void` (new, explicit per type)               |
| invoices             | `documents.invoice.create/update_draft/issue/void` (new)                                    |
| delivery notes       | `documents.delivery_note.create/update_draft/issue/void` (new)                              |
| (all document types) | `documents.read`, `documents.download` (existing, generic)                                  |
| portal access        | `portal.access.manage` (new); `portal.documents.read/download` (new, portal role only)      |
| exports              | `exports.create` (new)                                                                      |
| audit logs           | `audit.read` (new)                                                                          |
| platform             | `platform.tenants.read/create/activate/suspend` (existing) + `platform.support.grant` (new) |

Role → permission matrix (tenant domain; ✓ = granted):

| Permission                              | OWNER | ADMIN | SALES | FINANCE | OPS | VIEWER | PORTAL |
| --------------------------------------- | ----- | ----- | ----- | ------- | --- | ------ | ------ |
| business.settings.read                  | ✓     | ✓     | ✓     | ✓       | ✓   | ✓      | –      |
| business.settings.update                | ✓     | ✓     | –     | –       | –   | –      | –      |
| business.branding.read                  | ✓     | ✓     | ✓     | ✓       | ✓   | ✓      | –      |
| business.branding.update                | ✓     | ✓     | –     | –       | –   | –      | –      |
| business.members.read                   | ✓     | ✓     | –     | –       | –   | ✓      | –      |
| business.members.manage                 | ✓     | ✓ *   | –     | –       | –   | –      | –      |
| contacts.read                           | ✓     | ✓     | ✓     | ✓       | ✓   | ✓      | –      |
| contacts.create/update                  | ✓     | ✓     | ✓     | –       | –   | –      | –      |
| contacts.delete                         | ✓     | ✓     | –     | –       | –   | –      | –      |
| items.read                              | ✓     | ✓     | ✓     | ✓       | ✓   | ✓      | –      |
| items.create/update                     | ✓     | ✓     | ✓     | –       | ✓   | –      | –      |
| items.delete                            | ✓     | ✓     | –     | –       | –   | –      | –      |
| documents.read/download                 | ✓     | ✓     | ✓     | ✓       | ✓   | ✓      | –      |
| quotation.create/update_draft/issue     | ✓     | ✓     | ✓     | –       | –   | –      | –      |
| quotation.void                          | ✓     | ✓     | –     | –       | –   | –      | –      |
| invoice.create/update_draft/issue       | ✓     | ✓     | –     | ✓       | –   | –      | –      |
| invoice.void                            | ✓     | ✓     | –     | ✓       | –   | –      | –      |
| delivery_note.create/update_draft/issue | ✓     | ✓     | –     | –       | ✓   | –      | –      |
| delivery_note.void                      | ✓     | ✓     | –     | –       | –   | –      | –      |
| portal.access.manage                    | ✓     | ✓     | –     | –       | –   | –      | –      |
| portal.documents.read/download          | –     | –     | –     | –       | –   | –      | ✓      |
| exports.create                          | ✓     | ✓     | –     | ✓       | –   | –      | –      |
| audit.read                              | ✓     | ✓     | –     | –       | –   | –      | –      |

\* with delegation guards (never self, never an owner's row, never a role ≥
own, sole-owner protection — app layer **and** DB triggers §5.5).

Platform: `SUPER_ADMIN` holds all `platform.*`; `SUPPORT` holds none. Support
tenant-data access uses a separate read-only set (§6).

## 4. Schema changes

Concept → table mapping (directive wording → actual): tenants→`Tenant`,
tenant domains→`TenantDomain`, user profiles→`User`, tenant memberships→
`TenantMember`, platform roles→`User.platformRole` (enum; assignment) + the
`Permission`/`RolePermission` catalogs for the permission side [§11.1],
tenant status history→**`TenantStatusHistory` (new)**, audit events→`AuditLog`.

**Migrations (forward-only, three files):**

1. `20261018000000_uuid_identity_and_role_alignment`
   - All 20 tables: `id` → `uuid` (`gen_random_uuid()`), every FK column →
     uuid. Business ids remapped via join-backfill (old TEXT id kept during the
     migration only); `User.id` is cast `::uuid` (already a Supabase auth uid).
   - `PlatformRole`/`TenantRole` enum remap per §2 (new type + `USING` cast).
   - `Tenant.createdById uuid` (new column, FK `User`, SetNull, indexed) —
     needed to make the registration "self-create owner membership" policy
     attacker-proof (§5.4).
   - Indexes/unique constraints recreated on the new columns; all RLS policies
     dropped and recreated by migration 2 (a column swap would silently drop
     policies that reference the swapped columns).
2. `20261018000001_rbac_catalog_support_access_and_status_history`
   - `Permission`, `RolePermission` (seeded from the matrix in §3),
     `SupportAccessGrant`, `TenantStatusHistory` tables + RLS.
3. `20261018000002_rls_enforcement_storage_and_grants`
   - Full policy set (read/write split, role gates, support-grant clauses,
     portal exclusion), context helpers + guard triggers, `app_find_user_id_by_email`,
     numbering allocation guard, storage bucket + `storage.objects` policies,
     `amisibiz_app` grant cleanup (§8), extended `set_tenant_context`.

Prisma schema mirrors all of it (`@db.Uuid`, `@default(dbgenerated("gen_random_uuid()"))`
so DB-side defaults stay drift-free while app code may supply client-side UUIDs
— required for the offline track).

## 5. RLS activation architecture

### 5.1 Context (GUCs), transaction-local, fail-closed

`app.current_tenant_id`, `app.current_user_id`, `app.current_tenant_role`,
`app.is_platform_admin`, `app.is_platform_support` — all set through
`set_tenant_context(p_tenant_id, p_user_id, p_tenant_role, p_is_platform_admin,
p_is_platform_support)` with `set_config(..., true)` (transaction-local — also
safe under the Supabase pgbouncer). `clear_tenant_context()` scrubs all five.
Every helper reading a GUC is `NULLIF`-guarded (empty string ≡ no context →
deny). The runtime must set a context in **every** transaction that touches
app tables; a missed context fails closed (0 rows / constraint errors), never
open.

### 5.2 Scoped client (app layer)

`packages/database` gains `withAuthzTx(scope, fn)` with four scopes:
`tenant` (tenant+user+role), `user` (user only — session resolution),
`join` (tenant+user — invitation acceptance), `platform` (platform admin flag;
or support flag + tenant for a granted support session). All other DB access
(seed, CLI, migrations) stays on the privileged connection. `APP_DATABASE_URL`
(new env: `amisibiz_app` pooled) powers the runtime client; `DATABASE_URL`
stays the migration/owner connection for Prisma CLI + seed [§11.10].

### 5.3 Policy families (replaces the single `FOR ALL` policies)

- `has_tenant_read_access(t)`: `t = current_tenant_id()` **and role ≠
  CUSTOMER_PORTAL_USER**, or platform admin, or support-with-active-grant.
- `has_tenant_write_access(t)`: same but **no support path** (support is
  read-only at the database level too).
- Business tables: SELECT → read helper; INSERT/UPDATE/DELETE → write helper;
  role-gated writes where the matrix is strict (settings/branding → owner/
  admin only; invitations + memberships → owner/admin; numbering/sequences →
  not viewer/portal).
- `Tenant`: reads per helper + self-membership discovery (`EXISTS` own
  membership — needed before a context exists); writes: platform admin, or
  tenant context with owner/admin role.
- `User`: self-select; platform admin select; co-member select (members of the
  current tenant); self-insert (`id = current_user_id()` — registration);
  updates guarded by trigger (§5.5).
- `TenantMember`: self-select (membership discovery), tenant read/write with
  owner/admin gate + triggers; INSERT only via three narrow paths: platform
  admin, accepted-invitation self-join (email match + role match + invitation
  ACCEPTED, checked in SQL), registration self-create OWNER of a PENDING
  tenant **the actor created** (`createdById = current_user_id()`).
- `Invitation`: tenant read (any internal member — team page), tenant write
  (owner/admin); recipient read/update by verified email match; column-change
  trigger per §5.5.
- `AuditLog`: append-only (`INSERT WITH CHECK (true)` — audited actions happen
  in every context including registration), SELECT gated to owner/admin,
  platform admin, support-with-grant; no UPDATE/DELETE for `amisibiz_app`.
- `TenantStatusHistory`: append-only; initial PENDING row writable in tenant
  context; all other transitions platform-admin only.

### 5.4 Pre-context flows (auth), resolved explicitly — not by weakening RLS

- Session resolution / login / self profile: run `user` scope (sets the user
  GUC) — covered by self policies.
- Duplicate-registration check, forgot-password, invite "does this email
  exist": a single narrow `SECURITY DEFINER` function
  `app_find_user_id_by_email(text) → (id uuid, status)` — returns exactly one
  fact, granted only to `amisibiz_app`; no broad User read is opened.
- Registration transaction: `join`-style scope for the new tenant (user GUC =
  new auth uid, tenant GUC = new tenant id, role = owner-for-creation); writes
  are additionally constrained by the policies above (PENDING + createdById).
- Invitation acceptance: recipient reads/updates the invitation via the email
  policies, then an acceptance transaction updates the invitation to ACCEPTED
  **before** inserting the membership (the self-join policy requires ACCEPTED).
  Action order adapted accordingly.
- Health check (`SELECT 1`): no table access, works without context.

### 5.5 Guard triggers (defense in depth, DB-level)

- `users_guard_update`: self may change only name/image/emailVerified and
  increment sessionVersion; **platformRole/status/email are immutable except
  for platform admins** (kills self-elevation of platform role at the database
  level); other users' rows only via sessionVersion bump by an owner/admin of
  a shared tenant (mirrors `revokeUserSessions`).
- `tenant_members_guard_role_change`: role changes require owner/admin actor;
  **no self role change**; cannot touch an owner's row unless actor is owner;
  cannot grant a role ≥ actor's own; owner role granted only by an owner.
- `tenant_members_guard_delete`: no self-removal; the last owner of a tenant
  cannot be removed.
- `invitations_guard_update`: inviter-side changes require owner/admin;
  recipient-side changes may only set status/acceptedAt; tokenHash/tenantId/
  email/role are immutable except by owner/admin/platform.
- `allocate_document_number`: refuses to run for viewer/portal/no-context
  (backs "viewer cannot issue documents" at the DB layer; per-type precision
  stays in the app matrix §3).

### 5.6 Runtime role swap and production gating

The Next.js runtime connects as `amisibiz_app` via `APP_DATABASE_URL`
(production: **required**, the client constructor throws if absent; local dev:
falls back to `DATABASE_URL` with an explicit warning that RLS is not
enforced). `amisibiz_app`: `NOINHERIT LOGIN`, no `BYPASSRLS` (existing
hardening), password set by the documented operator step (§9), never in the
repo.

## 6. Support access (separately authorized, audited, scoped)

`SupportAccessGrant(tenantId, platformUserId, grantedById, reason, expiresAt,
revokedAt?)`. Only `SUPER_ADMIN` (`platform.support.grant`) creates/revokes.
`SUPPORT` staff hold **zero** tenant permissions without an active grant. With
an active, unexpired, unrevoked grant: read-only access to an explicit
diagnostic set (`settings.read`, `members.read`, `branding.read`,
`contacts.read`, `items.read`, `documents.read/download`, `audit.read`) — no
writes at app or DB level. Every use is audited (`SUPPORT_ACCESS_GRANTED`,
`SUPPORT_ACCESS_REVOKED`, `SUPPORT_ACCESS_USED`); the DB independently
re-checks the grant in `has_support_grant()` (defense in depth beyond the
server check). Management UI is out of scope for Phase 1; the actions +
tests exist, and this is stated in the report.

## 7. Supabase Storage for logos

- Private bucket `tenant-branding`; object path
  `tenants/<tenantId-uuid>/logo/<32-hex>.<png|jpg|webp>` (same validation
  rules as today: MIME allow-list, magic bytes, dimension cap, 5 MB).
- Upload/serve stay **server-mediated** (authorized server action + member-
  checked route handler streaming the object; the browser still never holds a
  Supabase client). Security headers preserved.
- `storage.objects` policies (defense in depth for any future direct-access
  path): bucket-scoped, `authenticated` role only, path tenant segment must
  match a membership of `auth.uid()`; no anon policies; no cross-tenant.
- Legacy `/uploads/...` logoUrl values keep serving through the existing
  filesystem branch during transition (documented; no new writes).
- Offline tests use a **stub `storage`/`auth` schema** in the throwaway
  cluster (guarded by existence checks in the migration, so the same
  migration is correct on Supabase and reproducible locally); live
  verification of the applied policies runs in §9.

## 8. Cross-application grant remediation (required finding)

In the shared project, `amisibiz_app` currently holds table privileges that
can cover the **other application's** tables (`GRANT ... ON ALL TABLES`,
`ALTER DEFAULT PRIVILEGES` — granted before/independent of per-table
enumeration). Migration 3: (a) `ALTER DEFAULT PRIVILEGES ... REVOKE` the
blanket grants, (b) revoke `amisibiz_app` privileges on every table/sequence
in `public` that is **not** an AmisiBiz table, (c) grant explicitly per
AmisiBiz table (the audit convention going forward: every new table migration
must include its own grants). A verification query lists remaining
`amisibiz_app` privileges so the claim is checkable, not asserted.

## 9. Deployment & verification (task order)

1. Build everything; run gates (`format`, `lint`, `type-check`, `test:run`,
   `build`).
2. Throwaway cluster: apply all 10 migrations from scratch; run drift check
   (`prisma migrate diff`), the numbering/phase04/phase05 check scripts, and
   the full integration suite (the eight required tests live there).
3. Live project: apply migrations (owner connection via `DIRECT_URL`),
   `prisma migrate status` = up to date, run the post-apply verification
   queries (RLS enabled on all tables, policy inventory, storage policies
   present, `amisibiz_app` privilege list = exactly the AmisiBiz tables).
   Set the `amisibiz_app` password (operator step, documented) and record the
   exact evidence in the completion report.
4. CI: add a `postgres:18` service; CI applies migrations and runs the
   integration tests with `TEST_DATABASE_URL` (the eight tests run for real on
   every push).

## 10. Tests (directive's eight, mapped)

| #   | Required test                                       | Where                                                                                                                              |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | anon cannot access private tenant data              | integration: no-context/anon role queries fail closed on every family; app: unauthenticated route checks                           |
| 2   | Tenant A cannot read/mutate Tenant B                | integration: two tenants, all four verbs, as `amisibiz_app`                                                                        |
| 3   | viewer cannot issue documents                       | unit: matrix (viewer has no issue keys) + integration: allocation guard refuses viewer context                                     |
| 4   | customer portal user cannot access internal records | unit: matrix; integration: portal context reads 0 rows on internal tables                                                          |
| 5   | users cannot elevate their own role                 | unit: delegation guards; integration: trigger refusals (self tenant-role and platform-role)                                        |
| 6   | tenant IDs cannot be manipulated to bypass RLS      | integration: forged tenantId in WHERE/WITH CHECK with a different context — denied                                                 |
| 7   | privileged credentials absent from client bundles   | build-time scan test (value-shaped `sb_secret_*` + `APP_DATABASE_URL`/owner URL never in `.next` client output)                    |
| 8   | storage policies prevent cross-tenant logo access   | integration (stub storage schema + role/JWT simulation): cross-tenant object read/insert denied; live: policy presence check in §9 |

Plus: parity tests (code matrix ≡ DB seed), context-leak test (pooled
connection reuse cannot see a previous context), and the existing suites kept
green.

## 11. Interpretation register (ambiguities, resolved not invented)

1. "platform roles, permissions" as schema items → platform _assignment_ stays
   `User.platformRole` (nullable enum; null = none) + new `Permission` /
   `RolePermission` catalog tables seeded from the code matrix.
2. Table naming stays Prisma PascalCase; mapping in §4.
3. Per-type document permissions were made explicit (quotations/invoices/
   delivery notes) instead of one generic set — the directive lists them
   separately.
4. `DOCUMENT_MANAGER` legacy rows map to `OPERATIONS` (closest functional
   successor; dev-data only).
5. `TENANT_ADMIN` gains member management with delegation guards; the earlier
   owner-only note predates the 9-role directive and is superseded.
6. Support grants are read-only, expiring, revocable, audited on every use.
7. Portal role: DB denies internal tables entirely; the portal's own
   document-visibility policy comes with the portal feature (not built here).
8. UUID conversion is a data-preserving forward migration (pre-launch; no
   DROP/recreate).
9. Storage adoption is server-mediated; policies are defense-in-depth with a
   live presence check.
10. `APP_DATABASE_URL` split (§5.6) with production gating.
11. Cross-app grant remediation included (§8) — a security fix Phase 1 owns.
12. Email lookups for auth flows use one narrow `SECURITY DEFINER` function
    rather than broad `User` read policies.
