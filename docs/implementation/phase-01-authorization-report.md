# Phase 1 directive — authorization, RBAC catalog and RLS: report

- **Date:** 2026-10-14
- **Directive:** the constitution's Phase 1 pack — core identity, roles,
  permissions and PostgreSQL row-level security, delivered **before** any
  business feature work. Design record:
  [`phase-01-security-design.md`](phase-01-security-design.md).
- **Owner decision governing this report:** _"Keep forward"_ — the live project
  stays at the Phase 1 schema with zero business data, the change is consistent
  and checksum-clean, and the security layer is inert until deliberately
  switched on. Remaining work as the owner stated it: #35 scoped context →
  the operator step (strong `amisibiz_app` password, out of band) → live
  verification probes **with the owner's go-ahead**.
- **Status:** tasks #31–#35 and #40 complete. **#36–#39 open.** This phase is
  committed in `f0dfe59` (owner approval, 2026-10-14); the push decision and the
  live verification remain the owner's (#30 closed, #38 open).

---

## 1. What the directive asked for, and where it landed

| Requirement                                                                                                                                                | Where it lives                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenants, domains, profiles, memberships, platform roles, permissions, tenant status history, audit events                                                  | `prisma/schema.prisma` + migrations 8–10 (`Tenant`, `TenantDomain`, `User`, `TenantMember`, `PlatformRole`, `Permission`, `RolePermission`, `SupportAccessGrant`, `TenantStatusHistory`, `AuditLog`)                                                                                             |
| Nine roles: `platform_super_admin`, `platform_support`, `tenant_owner`, `tenant_admin`, `sales`, `finance`, `operations`, `viewer`, `customer_portal_user` | `packages/auth/src/roles.ts` (7 tenant + 2 platform, plus the implicit `null` platform role) and the `TenantRole`/`PlatformRole` enums in migration 8                                                                                                                                            |
| Explicit permissions                                                                                                                                       | `packages/auth/src/permissions.ts` — 38 permissions (5 platform, 33 tenant) with domain/area/description metadata, mirrored into `Permission`/`RolePermission` by migration 9                                                                                                                    |
| Enforce on the server **and** with PostgreSQL RLS; never rely on hidden buttons or client-side role values                                                 | `apps/web/src/server/auth/authorization.ts` (deny-by-default) + migration 10 policies, guard triggers and per-table grants; `packages/database/src/scope.ts` for the context                                                                                                                     |
| Separate platform administration from tenant membership; owners can never grant themselves platform permissions                                            | disjoint domains asserted in `tests/security.test.ts`; `users_guard_update` trigger refuses non-admin changes to `platformRole`/`email`/`status`; ranks in both layers agree                                                                                                                     |
| Provider support access through a separately authorized and audited mechanism, not unrestricted access                                                     | `SupportAccessGrant` + `apps/web/src/server/services/support-access.ts` + `authorizePlatformTenant`/`assertWritableContext`; `SUPPORT` holds zero permissions by role, an active grant confers the 8 read-only `SUPPORT_TENANT_PERMISSIONS`, and `has_tenant_write_access` has no support branch |
| Migrations, generated types, authorization helpers, permission matrix, tests, setup documentation                                                          | migrations 8–10; `@prisma/client` types; `authorization.ts` + `scope.ts`; `docs/architecture/permission-matrix.md`; 9 test files; `docs/RUNBOOK.md` + `.env.example`                                                                                                                             |

## 2. Delivered this phase

**Schema (migrations 8–10 — applied live, checksum-clean, now frozen)**

- `20261018000000_uuid_identity_and_role_alignment`: UUID primary keys
  (cuid → uuid remap with FK re-keying) and the tenant/platform role alignment.
- `20261018000001_rbac_catalog_support_access_and_status_history`: the permission
  catalog tables, `SupportAccessGrant`, `TenantStatusHistory`.
- `20261018000002_rls_enforcement_storage_and_grants`: three policy families
  (`has_tenant_read_access`, `has_tenant_write_access`, `has_tenant_admin_access`),
  `SECURITY DEFINER` helpers, five transaction-local GUCs behind
  `public.set_tenant_context(text, text, text, boolean, boolean)`, guard triggers
  (`users_guard_update`, `tenant_members_guard_role_change`,
  `tenant_members_guard_delete`, `invitations_guard_update`,
  `tenant_status_guard`), the private `tenant-branding` bucket with path-scoped
  `storage.objects` policies, and the grant remediation — the blanket
  `ALTER DEFAULT PRIVILEGES` river from migration 2 is revoked and replaced with
  exact per-table verbs (`AuditLog`/`TenantStatusHistory`/`DocumentStatusEvent`
  `SELECT, INSERT`; `Permission`/`RolePermission` `SELECT`; `anon`/
  `authenticated` stripped; **no** sequence grants, since identities are UUIDs
  and document counters are rows inside `allocate_document_number()`).

**Application**

- `packages/database`: `client.ts` (`APP_DATABASE_URL` resolution; production
  refuses the owner-role fallback), `scope.ts` (`enterScope` / `runInScope` /
  `runScoped`, nested-transaction reuse, fail-closed `ScopeNotSetError`),
  `prisma.ts` (scoped transaction wrapper that **rejects** per-transaction
  `isolationLevel`/`maxWait`/`timeout` rather than silently dropping them),
  `rls-probe.ts` (`connectionBypassesRowLevelSecurity`,
  `assertRowLevelSecurityActive`).
- `apps/web`: `server/auth/authorization.ts` (`resolveTenantContext`,
  `authorizeTenant`, `assertWritableContext`, `authorizePlatform`,
  `authorizePlatformTenant`), `server/services/support-access.ts` +
  `server/actions/support.ts` + `lib/validations/support.ts` (reason required,
  default 24 h, hard cap 30 d, revocable), `lib/auth/user-lookup.ts`
  (`app_find_user_id_by_email()` under a bootstrap scope), `lib/audit`
  (sanitise-before-serialise, raw parameterised append).

**Verification**

- 9 test files, **204 passing / 13 skipped** (the DB-backed
  `integration-security.test.ts` skips without `TEST_DATABASE_URL`).
- Harness aligned to production shapes so security tests assert behaviour rather
  than id parsing: a full-model `mockDelegate()` (a missing model can no longer
  mask a behavioural failure), session/scope establishment the way every
  production entry point does, UUID fixtures throughout (so `z.string().uuid()`
  failures surface as `VALIDATION_ERROR` instead of faking a `FORBIDDEN` pass),
  and audit assertions read from `$executeRaw` bindings via `auditsFor()`.
- Issuance tests corrected to the matrix: `SALES` may
  `documents.quotation.issue` and must not hold `documents.invoice.issue`.

**A real defect found and fixed.** `src/lib/audit/index.ts` sanitised metadata
and then serialised **the raw payload** — so any supplied `password`, `token` or
`secret` key would have been written into the audit trail, which is precisely
what `sanitize()` exists to prevent. Fixed to serialise the sanitised value, and
locked by a test that asserts both the surviving key set and the serialised row;
re-introducing the old line makes that test fail (verified by deliberately
reverting it once).

**Configuration and operator surface hardened**

- `prisma/scripts/setup-app-role.sql` **rewritten to grant nothing**. The
  previous version granted a broad verb set and re-issued
  `ALTER DEFAULT PRIVILEGES … GRANT … TO amisibiz_app`, which would have
  re-opened exactly the river migration 10 closed. It is now §1 = the operator
  password step, §2–§9 = read-only drift checks (role attributes, session
  defaults, no-schema-creation, default-privilege river, table-privilege drift,
  RLS-enabled, policy counts, `set_tenant_context` EXECUTE), §11 = the
  connection-string template.
- `prisma/scripts/assert-rls.mts` + `pnpm db:assert-rls`: resolves the runtime
  URL, prints only the _source name_ (never a string), reports whether the role
  bypasses RLS and whether an empty context reads zero tenants. Exit `0`
  enforced · `1` not enforced · `2` misconfigured/unreachable.
- `apps/web/.env.example`: documented `APP_DATABASE_URL` block; `client.ts`'s
  warning corrected to point at the script that actually exists.

## 3. Verification actually performed

| Check                                      | Result                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format`                              | Green                                                                                                                                                                                                                                                                                                                |
| `pnpm lint`                                | 8/8 packages, no warnings                                                                                                                                                                                                                                                                                            |
| `pnpm type-check`                          | 8/8 packages. **Fixed this session:** `TS18048 'row' is possibly 'undefined'` × 5 in `tests/security.test.ts` — `expect(row).toBeDefined()` is not a type guard, so both audit tests now fail loudly with an explicit `if (!row) throw …` instead of a non-null assertion                                            |
| `pnpm test:run`                            | **204 passed, 13 skipped** (9 files)                                                                                                                                                                                                                                                                                 |
| `pnpm build`                               | Green — compiled, 54 static pages                                                                                                                                                                                                                                                                                    |
| Client-bundle secret scan                  | Clean — no `sb_secret_*` value and no `user:password@host` connection string under `apps/web/.next/static`                                                                                                                                                                                                           |
| Migrations 8–10 against the live project   | Applied 2026-10-14; `prisma migrate status` up to date with **no checksum drift** (checked read-only earlier in this cycle — not re-run now, since any live call needs the owner's go-ahead); live data at apply time was 1 user and zero tenants/memberships/documents, so the UUID remap re-keyed no business rows |
| Offline clean-room chain (scratch cluster) | Migrations 1–7 → fixture → 8–10, `phase01-migration-checks.sql` PASS, behavioral RLS battery PASS, `migrate diff` empty                                                                                                                                                                                              |

**Not run, and therefore not claimed:**

- `pnpm db:assert-rls` and `verify-supabase-auth.mts` against the live project —
  live probes require the owner's explicit go-ahead.
- Any execution of the 13 DB-backed integration tests (skipped: no
  `TEST_DATABASE_URL` in this environment, no CI Postgres service).
- The behavioral RLS battery is reproducible only from local scratch files; the
  committed repository cannot re-run it yet. That is a finding, not a pass —
  committing it is part of #37.

## 4. Honest position on the eight required proofs

Cross-tenant isolation, viewer-cannot-issue, portal-cannot-see-internal,
no-self-elevation, tenant-id-manipulation, anonymous access, bundle secrets and
storage isolation are **implemented** and asserted at the application layer, and
the policy/trigger/grant layer that should enforce them in PostgreSQL exists and
passed the offline battery. They are **not** yet proven in a way the repository
can reproduce, and RLS does not govern the running application at all until
`amisibiz_app` has a password and `APP_DATABASE_URL` is published
(`docs/RUNBOOK.md` §3). `docs/architecture/security-model.md` §13.6 records the
per-proof status.

This is why the directive's gate — _"do not begin business feature development
until the core authorization and RLS tests pass"_ — still holds, and why Phase 05
tasks #11–#15 remain closed.

## 5. Decisions recorded (so they are not mistaken for oversights)

1. **`user_select` / `user_update` policies are deliberately coarse** (self OR
   platform admin OR `app_shares_tenant_with("id")`). Row visibility for member
   listing, invitations and forced logout needs it; the `users_guard_update`
   trigger is what narrows every transition. Tightening the policy without
   re-checking those flows would break features, not improve safety.
2. **`setup-app-role.sql` grants nothing.** Migrations own privileges; a
   hand-run script that re-grants would silently undo migration 10.
3. **`scopedTransaction` rejects `$transaction` options** instead of ignoring
   them, because `isolationLevel`/`maxWait`/`timeout` cannot be honoured under a
   single-connection RLS context; app code passes none.
4. **`amisibiz_app` is created password-less on purpose.** A committed
   placeholder password would be worse than no password.
5. **Branding stays on the filesystem** (owner carve-out, 2026-10-14) even though
   migration 10 ships the bucket and its policies — adoption is #36, and today's
   storage isolation claim is schema-only.
6. **No commit was made during this phase.** Foundation + Phase 1 changes sat in
   the working tree for the owner to review; the owner approved the commit on
   2026-10-14 (`f0dfe59`). `.gitignore` now also covers `.tmp/` and
   `.kilo/` so scratch logs (which can carry hostnames) cannot be staged by
   accident.

## 6. Next, in order

1. **#38 operator step** — `RUNBOOK.md` §3, then `pnpm db:assert-rls`.
2. **Live verification probes** — only with the owner's go-ahead.
3. **#37** DB-backed harness: the eight proofs as `amisibiz_app`, code↔DB catalog
   parity, CI Postgres service, committed battery.
4. **#36** Supabase Storage adoption for logos + cross-tenant policy tests.
5. **#39 remainder** — any doc drift the above uncovers.
6. **04.5c → 04.5d → 04.5e → Phase 05**, gated on #37 passing.
