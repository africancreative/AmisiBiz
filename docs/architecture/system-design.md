# AmisiBiz — System Design

- **Status:** Phase 00 **target** design (historical). For the **as-built**
  system read `system-overview.md` and `data-model.md`. This document predates
  the Supabase→Neon migration and the native HMAC auth stack, so its stack
  (Auth.js/Supabase), data-access paths and early route map are the _original
  design of record_, not the current implementation.
- **Audience:** Engineering
- **Companion docs:** `repository-audit.md`, `security-model.md`, `../implementation/phase-checklist.md`

This document defines the target architecture and **module boundaries**. It is deliberately implementation-light; phases fill in the details. Existing architecture (Next.js App Router + Server Actions + Prisma/PostgreSQL + Auth.js + next-intl) is **preserved** — no alternative framework, CMS or database is introduced.

---

## 1. Architecture overview

```
Browser
  │  (HTTPS, locale-prefixed routes)
  ▼
Next.js Edge/Node middleware ── next-intl routing + Auth.js session gate
  │
  ▼
App Router (Server Components + Client Components)
  │   § reads → lib/query helpers (tenant-scoped)
  │   § writes → Server Actions ("use server") / Route Handlers
  ▼
Domain layer (src/server/services/**)  ── business rules, RBAC, transactions
  ▼
Data access (Prisma Client singleton) ── parameterised queries only
  ▼
Supabase PostgreSQL  (pooled DATABASE_URL / direct DIRECT_URL for migrations)
        Supabase Storage (documents)      Resend/SMTP (email)      PDF renderer
```

**Layering rule (enforce by review + lint boundary later):**

```
app/ (routing, UI)                → may import components, server/actions, lib
server/actions/ (transport)       → validates input, authorises, calls services
server/services/ (domain)         → only place with business rules + multi-step tx
lib/ (infrastructure)             → prisma, auth, i18n, pdf, storage, utils, validations
prisma/ (schema, migrations, seed)
```

- Server Actions and Route Handlers are **thin**: validate (Zod) → authorise (tenant + RBAC) → call a service → map result to a safe `ActionResult`.
- Services never read cookies/headers directly; identity and tenant context are passed in explicitly (testable).
- Only `lib/db/prisma.ts` constructs a `PrismaClient`.

---

## 2. Module boundaries

All business modules are **tenant-scoped**. Every service entry point takes `{ actorUserId, tenantId }` and asserts membership/role via the auth module.

### M1. Authentication (`src/lib/auth/**`, `src/server/actions/auth.ts`)

- Responsibility: credentials, sessions, registration, password reset, email verification, OAuth (later), sign-in/out auditing.
- Owns: `User`, `Account`, `Session`, `VerificationToken`.
- Exposes: `auth()`, `requireAuth()`, `registerAction`, `forgotPasswordAction`, `resetPasswordAction`.
- Depends on: audit logging, email.

### M2. Platform administration (`src/server/services/platform/**`, `src/server/actions/platform/**`)

- Responsibility: cross-tenant operations for `SUPER_ADMIN`/`SUPPORT` — tenant lifecycle, suspend/activate, plan assignment, global audit view.
- Owns: platform-level views over `Tenant`, `User`, `AuditLog`.
- Rule: **platform scopes bypass tenant isolation deliberately and must log every action**; access restricted by `SystemRole`.
- Depends on: audit logging, tenants.

### M3. Tenants & membership (`src/lib/tenant/**`, `src/server/actions/tenant.ts`)

- Responsibility: tenant CRUD, membership, roles, invitations, active-tenant selection.
- Owns: `Tenant`, `TenantMember`, `Invitation`.
- Exposes: `requireTenantAccess`, `getPrimaryMembership`, `inviteMemberAction`, `updateMemberRoleAction`, `removeMemberAction`, `acceptInvitationAction`.

### M4. Business settings (`src/server/services/settings/**`)

- Responsibility: per-tenant configuration — currency, timezone, locale, tax rates, document numbering, branding, feature flags.
- Owns: new `TenantSetting`/`NumberSequence` models.
- Rule: replaces hardcoded assumptions (trial length, defaults) with configuration.

### M5. Contacts (`src/server/services/contacts/**`)

- Responsibility: customers/suppliers/partners with tenant isolation, dedupe, soft-delete.
- Owns: `Contact` (+ relations).

### M6. Catalogue (`src/server/services/catalogue/**`)

- Responsibility: products/services, pricing, units, tax linkage.
- Owns: `Product`, `PriceList`, `Unit`.

### M7. Documents (`src/server/services/documents/**`)

- Responsibility: document metadata + storage abstraction (Supabase Storage), signed URLs, virus/type/size validation.
- Owns: `Document` (metadata only; binaries in object storage).
- Rule: never expose service-role keys or public buckets to the client.

### M8. PDF generation (`src/lib/pdf/**`)

- Responsibility: deterministic, tenant-branded PDF rendering for invoices/quotes/statements.
- Rule: pure function from a DTO → bytes; no DB access; snapshot data at generation time.

### M9. Audit logging (`src/lib/audit/**`)

- Responsibility: central append-only audit writer + query helpers; called by every module.
- Owns: `AuditLog`.
- Rule: never log secrets; minimise PII; include actor, tenant, action, resource, before/after diff where safe.

### Cross-cutting

- **Validation:** `src/lib/validations/**` (Zod) — one schema per action input.
- **Errors:** map domain errors (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION`) to safe client messages; log full detail server-side only.
- **i18n:** `messages/{en,fr,sw}`; no hardcoded user-facing strings.
- **Storage/Email/PDF:** adapters behind interfaces so providers can change without touching domain code.

---

## 3. Multi-tenancy model

- Single database, shared schema, **row-level tenant scoping by `tenantId`**.
- Tenant context is resolved server-side from the authenticated user's membership — **never** trusted from the request body.
- Two isolation layers (defence in depth):
  1. `requireTenantAccess(userId, tenantId, roles)` in every service/action.
  2. Optional Prisma Client Extensions to auto-inject `tenantId` filters (to be introduced in a later phase; must not be relied on alone).
- Platform-admin operations are the only exception and are explicitly gated by `SystemRole`.
- Active tenant: replace the current `isDefault` heuristic with an explicit selection (cookie/session field validated against membership), plus a partial unique index enforcing one default per user.

---

## 4. Route & endpoint map (target)

| Area     | Route                                                                                                                 | Access                     |
| -------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Public   | `/[locale]/login`, `/register`, `/forgot-password`, `/reset-password`                                                 | unauthenticated            |
| App      | `/[locale]/dashboard`, `/team`, `/settings/*`                                                                         | tenant member              |
| Modules  | `/[locale]/invoices`, `/crm`, `/inventory`, `/hr`, `/payroll`, `/purchasing`, `/accounting`, `/reports`, `/documents` | tenant member (role-gated) |
| Platform | `/[locale]/platform/*`                                                                                                | `SUPER_ADMIN`/`SUPPORT`    |
| API      | `/api/auth/[...nextauth]`, `/api/health`, `/api/webhooks/*`, `/api/files/*`                                           | mixed                      |

- No business logic in Route Handlers beyond transport concerns; prefer Server Actions for mutations.

---

## 5. Non-functional requirements

- **Security:** see `security-model.md`. Server-side authorization is mandatory on every mutation/query.
- **Reliability:** health endpoint; DB via pooled connection; graceful degradation when email/PDF providers fail.
- **Observability:** structured logging with request/actor/tenant correlation; audit log for all privileged actions; error tracking (Sentry/provider TBD).
- **Performance:** avoid per-request DB round-trips in session validation where safe; index all tenant-scoped foreign keys.
- **Accessibility/i18n:** WCAG-conscious components; all strings externalised.

---

## 6. Technology decisions (recorded)

| Decision                                 | Rationale                             | Reversible?                                    |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| Keep Next.js App Router + Server Actions | Existing, secure-by-default mutations | No (core)                                      |
| Keep Prisma + PostgreSQL (Supabase)      | Existing schema/migrations            | No (core)                                      |
| Keep Auth.js v5 (JWT sessions)           | Existing; DB-checked status           | Yes                                            |
| `next-intl` 3.26.5                       | 3.27.0 absent from registry           | Yes (v4 is breaking)                           |
| Middleware Node runtime                  | Prisma requires it                    | Yes (if session check moves out of middleware) |
| `exactOptionalPropertyTypes` on          | Stronger safety; explicit handling    | Yes (would reduce friction)                    |
