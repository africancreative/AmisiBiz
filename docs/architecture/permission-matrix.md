# AmisiBiz — Authorization & Permission Matrix

- **Status:** Implemented (Phase 02 — Auth/RBAC; extended in Phase 03 — Tenant Lifecycle)
- **Source of truth:** `src/lib/auth/permissions.ts`
- **Enforcement:** `src/server/auth/authorization.ts`

> Roles confer **only** the permissions listed here. No permission is granted
> merely because a role's name implies authority. Access is **denied by default**
> when a membership, role or permission is missing.

---

## 1. Two separate security domains

| Domain       | Enum           | Who                          | Grants access to                 |
| ------------ | -------------- | ---------------------------- | -------------------------------- |
| **Platform** | `PlatformRole` | Amisi Genuine internal staff | Platform administration only     |
| **Tenant**   | `TenantRole`   | Customer workspace members   | That tenant's business data only |

The domains are **disjoint**: a `platform.*` permission is never granted to a
tenant role, and a platform role never grants access to tenant business data.
Both invariants are asserted in `tests/security.test.ts`.

### Platform roles

| Role               | Permissions                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `PLATFORM_ADMIN`   | `platform.tenants.read`, `platform.tenants.create`, `platform.tenants.activate`, `platform.tenants.suspend` |
| `PLATFORM_SUPPORT` | **none** — disabled until a defined support permission set exists                                           |
| `USER`             | none (default for all accounts)                                                                             |

> Lifecycle mapping: `platform.tenants.create` provisions a `PENDING` tenant;
> `platform.tenants.activate` activates a `PENDING` tenant and reactivates a
> `SUSPENDED` one; `platform.tenants.suspend` suspends an `ACTIVE` tenant and
> requires a reason. All four are audited.

### Tenant roles

| Permission                 | OWNER | ADMIN | DOC_MGR | SALES | VIEWER |
| -------------------------- | :---: | :---: | :-----: | :---: | :----: |
| `business.settings.read`   |   ✓   |   ✓   |    ✓    |   ✓   |   ✓    |
| `business.settings.update` |   ✓   |   ✓   |         |       |        |
| `business.members.read`    |   ✓   |   ✓   |         |       |   ✓    |
| `business.members.manage`  |   ✓   |       |         |       |        |
| `contacts.read`            |   ✓   |   ✓   |    ✓    |   ✓   |   ✓    |
| `contacts.create`          |   ✓   |   ✓   |         |   ✓   |        |
| `contacts.update`          |   ✓   |   ✓   |         |   ✓   |        |
| `contacts.delete`          |   ✓   |   ✓   |         |       |        |
| `items.read`               |   ✓   |   ✓   |    ✓    |   ✓   |   ✓    |
| `items.create`             |   ✓   |   ✓   |         |   ✓   |        |
| `items.update`             |   ✓   |   ✓   |         |   ✓   |        |
| `items.delete`             |   ✓   |   ✓   |         |       |        |
| `documents.read`           |   ✓   |   ✓   |    ✓    |   ✓   |   ✓    |
| `documents.create`         |   ✓   |   ✓   |    ✓    |   ✓   |        |
| `documents.update_draft`   |   ✓   |   ✓   |    ✓    |   ✓   |        |
| `documents.issue`          |   ✓   |   ✓   |    ✓    |   ✓   |        |
| `documents.void`           |   ✓   |   ✓   |    ✓    |       |        |
| `documents.download`       |   ✓   |   ✓   |    ✓    |   ✓   |   ✓    |

**Design rationale**

- Only `BUSINESS_OWNER` may manage members: the owner decides who belongs to the
  workspace. `BUSINESS_ADMIN` runs day-to-day operations and settings.
- `DOCUMENT_MANAGER` reads business context and manages documents end-to-end.
- `SALES_STAFF` manages contacts/items and issues sales documents, but cannot
  delete records or void documents (sensitive, irreversible actions).
- `VIEWER` is read-only over explicitly permitted information.

---

## 2. Enforcement rules (`src/server/auth/authorization.ts`)

1. The actor is the **authenticated session user id**; tenant id and role are
   always read from the database — never from the browser.
2. `authorizeTenant(userId, tenantId, permission)`:
   - resolves the membership; **no membership ⇒ deny** (covers cross-tenant and
     forged tenant ids);
   - **only `ACTIVE` tenants are operational** — `PENDING` and `SUSPENDED`
     tenants are denied every tenant operation (see the suspension policy in
     `security-model.md`);
   - **missing permission ⇒ deny**;
   - denials are written to `AuditLog` (`authz.denied`).
3. `authorizePlatform(userId, permission)`:
   - requires an `ACTIVE` user with a platform role that holds the permission;
   - denials are audited.
4. Delegated-administration guards (`TENANT_ROLE_RANK`) additionally prevent a
   member from acting on a peer/superior or assigning a role ≥ their own.

---

## 3. Session lifecycle

- JWT sessions expire after **8 hours**; rotated at most every 15 minutes.
- The `session` callback re-reads the user on every request and validates
  `status === ACTIVE` and `sessionVersion` — bumping `sessionVersion`
  (`revokeUserSessions`) immediately invalidates outstanding sessions.
- Role changes and member removal revoke the affected user's sessions.
