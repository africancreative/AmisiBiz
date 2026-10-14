# AmisiBiz — Authorization & Permission Matrix

- **Status:** Implemented (Phase 1 — RBAC catalog, roles and enforcement;
  Phase 2 — the platform permission set and the suspension write/read split).
  Supersedes the Phase 02/03 five-role matrix.
- **Source of truth:** `packages/auth/src/permissions.ts` (catalog and
  role → permission policy) and `packages/auth/src/roles.ts` (role unions).
- **Database mirror:** `Permission` and `RolePermission` tables, seeded by
  migration `20261018000001`; both are `SELECT`-only for the runtime role, so
  the catalog changes only through a new migration.
- **Enforcement:** `apps/web/src/server/auth/authorization.ts` (application
  side, deny-by-default) **and** PostgreSQL row-level security in migration
  `20261018000002` (database side). Neither is a fallback for the other.

> Roles confer **only** the permissions listed here. No permission is granted
> because a role's name implies authority. Access is **denied by default** when
> a membership, role or permission is missing. Buttons hidden in the UI are not a
> control: every mutation is checked on the server and re-checked by the
> database.

---

## 1. Two separate security domains

| Domain       | Type                      | Values                                                       | Grants access to                 |
| ------------ | ------------------------- | ------------------------------------------------------------ | -------------------------------- |
| **Platform** | `PlatformRole` (nullable) | `SUPER_ADMIN`, `SUPPORT`, or `null` (no platform privileges) | Platform administration only     |
| **Tenant**   | `TenantRole`              | the seven workspace roles below                              | That tenant's business data only |

The directive's snake_case names map to the TypeScript unions like this:
`platform_super_admin` → `SUPER_ADMIN`, `platform_support` → `SUPPORT`,
`tenant_owner` → `TENANT_OWNER`, `tenant_admin` → `TENANT_ADMIN`, `sales` →
`SALES`, `finance` → `FINANCE`, `operations` → `OPERATIONS`, `viewer` →
`VIEWER`, `customer_portal_user` → `CUSTOMER_PORTAL_USER`. Together with the
implicit "no role" (`null`) state that is the required nine-role model.

Both invariants are asserted in `apps/web/tests/security.test.ts`:

- a `platform.*` permission is never present on a tenant role;
- a tenant permission is never present on a platform role — including `SUPPORT`,
  which holds **none** until an explicit grant exists.

A platform role never reads tenant business data on its own. Provider support
access is a separate, authorized, expiring, audited mechanism (§4).

---

## 2. Permission catalog (42 permissions)

Platform domain (9) — the Phase 2 additions are marked. Source:
`packages/auth/src/permissions.ts`; seeded into `Permission` by migration
`20261019000000`.

| Permission                               | Area    | What it decides                                           |
| ---------------------------------------- | ------- | --------------------------------------------------------- |
| `platform.tenants.read`                  | tenants | View the tenant list and a tenant's administration detail |
| `platform.tenants.create`                | tenants | Provision a new workspace (it starts `PENDING`)           |
| `platform.tenants.update` _(new)_        | tenants | Edit a tenant's profile, branding and document settings   |
| `platform.tenants.activate`              | tenants | Activate **or reactivate** a tenant                       |
| `platform.tenants.suspend`               | tenants | Suspend a tenant, reason required                         |
| `platform.tenants.plan.assign` _(new)_   | tenants | Attach an informational plan label to a tenant            |
| `platform.tenants.domain.manage` _(new)_ | tenants | Change the workspace slug or its hostnames                |
| `platform.audit.read` _(new)_            | audit   | Read the provider audit trail for any tenant              |
| `platform.support.grant`                 | support | Grant and revoke provider support access                  |

Reactivation deliberately rides `platform.tenants.activate` rather than the
suspension permission: an operator trusted to pause a business is not
automatically trusted to bring it back.

Tenant domain (33), grouped by area:

| Area              | Permissions                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Settings/branding | `business.settings.read`, `business.settings.update`, `business.branding.read`, `business.branding.update` |
| Membership        | `business.members.read`, `business.members.manage`                                                         |
| Contacts          | `contacts.read`, `contacts.create`, `contacts.update`, `contacts.delete`                                   |
| Catalogue         | `items.read`, `items.create`, `items.update`, `items.delete`                                               |
| Documents (any)   | `documents.read`, `documents.download`                                                                     |
| Quotations        | `documents.quotation.create`, `…update_draft`, `…issue`, `…void`                                           |
| Invoices          | `documents.invoice.create`, `…update_draft`, `…issue`, `…void`                                             |
| Delivery notes    | `documents.delivery_note.create`, `…update_draft`, `…issue`, `…void`                                       |
| Customer portal   | `portal.access.manage`, `portal.documents.read`, `portal.documents.download`                               |
| Exports / audit   | `exports.create`, `audit.read`                                                                             |

Document issuance is split **per document type** on purpose. Issuing a quotation
is selling; issuing an invoice is finance. A `SALES` member therefore holds
`documents.quotation.issue` and not `documents.invoice.issue`.

---

## 3. Tenant role → permission matrix

✓ = held. Blank = not held (deny-by-default).

| Permission                             | OWNER | ADMIN | SALES | FINANCE | OPS | VIEWER | PORTAL |
| -------------------------------------- | :---: | :---: | :---: | :-----: | :-: | :----: | :----: |
| `business.settings.read`               |   ✓   |   ✓   |   ✓   |    ✓    |  ✓  |   ✓    |        |
| `business.settings.update`             |   ✓   |   ✓   |       |         |     |        |        |
| `business.branding.read`               |   ✓   |   ✓   |   ✓   |    ✓    |  ✓  |   ✓    |        |
| `business.branding.update`             |   ✓   |   ✓   |       |         |     |        |        |
| `business.members.read`                |   ✓   |   ✓   |       |         |     |   ✓    |        |
| `business.members.manage`              |   ✓   |   ✓   |       |         |     |        |        |
| `contacts.read`                        |   ✓   |   ✓   |   ✓   |    ✓    |  ✓  |   ✓    |        |
| `contacts.create`                      |   ✓   |   ✓   |   ✓   |         |     |        |        |
| `contacts.update`                      |   ✓   |   ✓   |   ✓   |         |     |        |        |
| `contacts.delete`                      |   ✓   |   ✓   |       |         |     |        |        |
| `items.read`                           |   ✓   |   ✓   |   ✓   |    ✓    |  ✓  |   ✓    |        |
| `items.create`                         |   ✓   |   ✓   |   ✓   |         |  ✓  |        |        |
| `items.update`                         |   ✓   |   ✓   |   ✓   |         |  ✓  |        |        |
| `items.delete`                         |   ✓   |   ✓   |       |         |     |        |        |
| `documents.read`                       |   ✓   |   ✓   |   ✓   |    ✓    |  ✓  |   ✓    |        |
| `documents.download`                   |   ✓   |   ✓   |   ✓   |    ✓    |  ✓  |   ✓    |        |
| `documents.quotation.create`           |   ✓   |   ✓   |   ✓   |         |     |        |        |
| `documents.quotation.update_draft`     |   ✓   |   ✓   |   ✓   |         |     |        |        |
| `documents.quotation.issue`            |   ✓   |   ✓   |   ✓   |         |     |        |        |
| `documents.quotation.void`             |   ✓   |   ✓   |       |         |     |        |        |
| `documents.invoice.create`             |   ✓   |   ✓   |       |    ✓    |     |        |        |
| `documents.invoice.update_draft`       |   ✓   |   ✓   |       |    ✓    |     |        |        |
| `documents.invoice.issue`              |   ✓   |   ✓   |       |    ✓    |     |        |        |
| `documents.invoice.void`               |   ✓   |   ✓   |       |    ✓    |     |        |        |
| `documents.delivery_note.create`       |   ✓   |   ✓   |       |         |  ✓  |        |        |
| `documents.delivery_note.update_draft` |   ✓   |   ✓   |       |         |  ✓  |        |        |
| `documents.delivery_note.issue`        |   ✓   |   ✓   |       |         |  ✓  |        |        |
| `documents.delivery_note.void`         |   ✓   |   ✓   |       |         |  ✓  |        |        |
| `portal.access.manage`                 |   ✓   |   ✓   |       |         |     |        |        |
| `portal.documents.read`                |       |       |       |         |     |        |   ✓    |
| `portal.documents.download`            |       |       |       |         |     |        |   ✓    |
| `exports.create`                       |   ✓   |   ✓   |       |    ✓    |     |        |        |
| `audit.read`                           |   ✓   |   ✓   |       |         |     |        |        |

Counts (verified against `TENANT_ROLE_PERMISSIONS`): `TENANT_OWNER` 31,
`TENANT_ADMIN` 31, `SALES` 13, `FINANCE` 11, `OPERATIONS` 12, `VIEWER` 7,
`CUSTOMER_PORTAL_USER` 2 — unchanged by Phase 2, which added platform
permissions only. Together with `SUPER_ADMIN` 9 and `SUPPORT` 0 that is the 116
`RolePermission` rows migration `20261019000000` asserts, and no tenant role
sums to a `platform.*` permission.

**Design rationale**

- **Owner and admin hold the same permission set.** The difference is not what
  they may do but on whose rows: `TENANT_ADMIN` may never act on an owner's
  seat, never assign a role at or above its own, and never change its own role —
  enforced by delegation guards in `TENANT_ROLE_RANK` **and** by the
  `tenant_members_guard_role_change` / `tenant_members_guard_delete` triggers in
  the database. A table that looked identical in the app layer would still be
  identical here; the guards are what make "admin" weaker than "owner".
- `SALES` runs contacts and catalogue (without deletes) and takes quotations from
  draft to issued — but may not void one, and holds no invoice or delivery-note
  issuance. Money documents are read-only for it.
- `FINANCE` owns the invoice lifecycle and exports; quotations and delivery
  notes are read-only for it.
- `OPERATIONS` owns delivery notes end-to-end and catalogue create/update;
  money documents are read-only.
- `VIEWER` is read-only, including the member list (which is business
  metadata, not business data) — and holds no audit or export capability.
- `CUSTOMER_PORTAL_USER` holds only the two portal read/download permissions.
  Portal visibility is further restricted to rows linked to that contact; a
  portal user has no path to internal records, members or settings.

---

## 4. Platform roles and provider support access

| Role             | Permissions                       |
| ---------------- | --------------------------------- |
| `SUPER_ADMIN`    | every `platform.*` permission (9) |
| `SUPPORT`        | **none**                          |
| `null` (default) | none                              |

`SUPPORT` staff reach tenant data only through a `SupportAccessGrant` — one
tenant, one platform user, mandatory `reason`, expires (default 24 h, hard
maximum 30 days via `MAX_SUPPORT_GRANT_HOURS`), revocable, and audited on grant,
revoke, use and denial. Even with an active grant the permission set is the
read-only `SUPPORT_TENANT_PERMISSIONS`:

`business.settings.read`, `business.branding.read`, `business.members.read`,
`contacts.read`, `items.read`, `documents.read`, `documents.download`,
`audit.read` — 8 permissions, deliberately containing **no** write permission,
no member management and no portal management. The write policy family
(`has_tenant_write_access`) has no support branch at all, so a grant cannot
become a write path even if application code were wrong.

Platform privileges are never granted by tenant membership, and a tenant owner
cannot grant themselves a platform permission: `users_guard_update` refuses
non-admin changes to `platformRole`, `email` or `status` on any `User` row.

---

## 5. Enforcement rules

**Application layer** (`apps/web/src/server/auth/authorization.ts`):

1. The actor is the authenticated session user id. Tenant id, role, prices,
   totals and statuses are read from the database — never accepted from the
   browser.
2. `authorizeTenant(userId, tenantId, permission)` resolves the membership; **no
   membership ⇒ deny** (this covers cross-tenant and forged tenant ids); a
   `PENDING` tenant is denied outright, and a `SUSPENDED` one keeps its read and
   download permissions while every write permission is refused and audited
   (`tenant.writeDenied`) — see `../architecture/security-model.md` §4.1;
   **missing permission ⇒ deny**.
3. `authorizePlatform(userId, permission)` requires an `ACTIVE` user whose
   platform role holds the permission; `authorizePlatformTenant(...)` is the
   grant-gated path for support access.
4. `resolveTenantContext` produces the tenant/user/role claims that are pushed
   into the database session; `assertWritableContext` refuses a read-only
   context on a write path.
5. Denials are audited (`authz.denied`) and surface as stable error codes
   (`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`), never as a stack trace.

**Database layer** (migration `20261018000002`):

- Five transaction-local GUCs (`app.current_tenant_id`, `app.current_user_id`,
  `app.current_tenant_role`, `app.is_platform_admin`,
  `app.is_platform_support`) are written only by
  `public.set_tenant_context(text, text, text, boolean, boolean)`, called from
  `packages/database/src/scope.ts`. The claims are **informational**: the policy
  helpers `is_platform_admin()`, `app_tenant_role(uuid)` and
  `has_support_grant(uuid)` re-read the rows through `SECURITY DEFINER`
  functions, so a forged claim cannot widen access.
- Three policy families decide visibility: `has_tenant_read_access` (members, or
  an active support grant), `has_tenant_write_access` (members only — no support
  branch), `has_tenant_admin_access` (owner/admin).
- Guard triggers answer "which transitions" where policies answer "which rows":
  `users_guard_update`, `tenant_members_guard_role_change`,
  `tenant_members_guard_delete`, `invitations_guard_update`,
  `tenant_status_guard`.
- Per-table verb grants bound what the runtime role can even attempt —
  `AuditLog`, `TenantStatusHistory` and `DocumentStatusEvent` are
  `SELECT, INSERT` only; `Permission`/`RolePermission` are `SELECT` only; there
  are **no** sequence grants, because identities are UUIDs and document counters
  are rows updated inside `allocate_document_number()`.

`User` policies (`user_select` / `user_update`) are **deliberately coarse**:
self, OR platform admin, OR a user sharing a tenant (`app_shares_tenant_with`).
That is the minimum that lets member listing, invitations and the forced-logout
flow work; the transition guards above are what keep it from being a privilege
path. Do not "tighten" these policies without re-checking those flows — and do
not treat the coarseness as a finding, it is a decision.

Page level: `getWorkspaceState(locale[, permission])` in
`apps/web/src/server/auth/workspace.ts` runs server-side on every `/app/*`
render, resolving membership and tenant status and authorizing the supplied
permission against the database; suspended tenants load no workspace screen.

---

## 6. Session lifecycle

Identity is Supabase Auth (GoTrue), adopted in Phase 04.5a; the retired Auth.js
credential tables were dropped by migration `20261017000000`.

- Credentials are submitted server-side only; the browser never holds a
  Supabase client and never sees `SUPABASE_SECRET_KEY` (`sb_secret_*`).
- Platform standing is re-read from the `User` row on every authorization, so a
  revoked, suspended or role-changed account cannot act on a cached session.
- `sessionVersion` is the revocation counter: it may only be incremented by one,
  only by the account owner or by an owner/admin of a shared workspace
  (forced logout), and never by a support grant.
- Tenant membership changes that remove access take effect on the next request
  because the membership and tenant status are resolved per call, not baked
  into a token.

---

## 7. Verification status (do not read this section as a green checkmark)

| Claim                                                     | Evidence                                                                     | Proven how                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Roles confer exactly the listed permissions               | `TENANT_ROLE_PERMISSIONS` / `PLATFORM_ROLE_PERMISSIONS` + `security.test.ts` | unit tests against a mocked Prisma (256 passing, 13 skipped pending a DB harness)                                                                            |
| Domains are disjoint                                      | asserted in `security.test.ts`                                               | unit                                                                                                                                                         |
| Deny-by-default and audited denials                       | `authorization.ts`, `phase04-security.test.ts`                               | unit                                                                                                                                                         |
| Platform writes require the named platform permission     | `phase02-provider-admin.test.ts`                                             | unit: every provider action is denied for an ordinary user and for `SUPPORT` with no grant, each refusal audited as `authz.denied`                           |
| Suspension denies writes and keeps reads                  | `tenant-lifecycle.ts` policy + `app_tenant_accepts_writes()`                 | unit (application layer) and SQL definition; **not** exercised against a live `amisibiz_app` connection until #37/#38                                        |
| Support grants are bounded, read-only, expiring, audited  | `support-access.ts`, `validations/support.ts`, unit suites                   | unit                                                                                                                                                         |
| Policies enforce cross-tenant isolation **in PostgreSQL** | migration `20261018000002`, offline clean-room battery                       | scratch cluster only — **not** proven against the live project through the app role, because `amisibiz_app` still has no password (see `docs/RUNBOOK.md` §3) |
| Code catalog == database catalog                          | intended parity test                                                         | **open** — belongs to the DB-backed integration harness                                                                                                      |

The eight required cross-tenant proofs from the Phase 1 directive therefore
remain unproven until that harness exists; the mock-based suites prove the
application's decisions, not the database's.
