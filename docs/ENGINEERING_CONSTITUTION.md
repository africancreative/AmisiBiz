# AmisiBiz Engineering Constitution

**Status:** Canonical & Enforced  
**Owner:** Amisi Genuine Enterprises  
**Authority:** AGENT 00 — Chief Engineering Orchestrator  
**Applicability:** All agents, engineers, modules, and sub-systems across the repository.

---

## 1. Prime Directives

1. **Protect Working Code:** This is an existing, functional multi-tenant application. No agent may wipe, scaffold duplicate applications, or replace working subsystems without empirical defect proof.
2. **Neon PostgreSQL Authority:** The primary database is Neon PostgreSQL managed exclusively via Prisma. Supabase or alternative database engines must never be reintroduced as primary application stores.
3. **Defense in Depth & Tenant Isolation:** Every data mutation and read path must enforce tenant boundaries at both the application service layer and the PostgreSQL database layer (Row-Level Security / Scoped Contexts). No request-supplied `tenantId` is ever trusted without cryptographic session validation and membership verification.
4. **Deny by Default:** Absence of an explicit permission grant means access is denied. All privileged actions must be gated by the verified RBAC catalog and audited via the append-only `AuditLog`.
5. **No Blind Secrets:** Secrets, API keys, and connection credentials must never be committed to git, logged to stdout/stderr, or exposed in client bundles. All client bundles are verified via CI security scans.
6. **Financial Precision:** Currency is Kenya Shillings (`KES`) by default. Floating-point numbers are strictly forbidden for money and accounting math. All financial representations must use string-based fixed decimals (`Decimal` / `@amisibiz/documents`).
7. **Idempotent Deployments:** Schema migrations are strictly forward-only, frozen once applied, and validated via `prisma migrate diff`. Destructive database operations (`DROP`, `TRUNCATE`, unconstrained `DELETE`) are prohibited without explicit human authorization.
8. **Verifiable Quality:** No code change is complete without automated test coverage, zero TypeScript compilation errors (`tsc --noEmit`), and clean lint checks. Claims of completion without executed proofs are violations of engineering integrity.

---

## 2. Technology Stack Standards

| Layer              | Standard                                 | Strict Enforcement Rules                                                         |
| :----------------- | :--------------------------------------- | :------------------------------------------------------------------------------- |
| **Monorepo**       | pnpm `11.18.0` + Turborepo               | pnpm workspaces only; no ad-hoc global package installations.                    |
| **Framework**      | Next.js 15 (App Router)                  | Server Components default; `"use client"` only for interactive leaves.           |
| **Language**       | TypeScript 5.8                           | Strict mode: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. No `any`. |
| **Styling**        | Tailwind CSS 3.4 + `@amisibiz/ui`        | Accessible WCAG AA compliance, responsive layouts, consistent design tokens.     |
| **Database**       | Neon PostgreSQL via Prisma 6.19          | Single schema authority in `apps/web/prisma/schema.prisma`.                      |
| **Auth**           | Native Web Crypto HMAC SHA-256           | HttpOnly, Secure, Lax `amisibiz_session` cookies; `sessionVersion` invalidation. |
| **Email**          | Mailtrap (HTTP API / Vercel Integration) | Auto-switching Sandbox/Live; localized HTML & plain text fallback.               |
| **Offline Engine** | SQLite + Outbox (`@amisibiz/offline`)    | Deterministic sync protocol, vector conflict resolution, tombstone deletion.     |
| **Testing**        | Vitest 3                                 | Unit, contract, and RLS integration suites.                                      |

---

## 3. Architecture Boundary Rules

1. **Shared Packages (`packages/*`):**
   - `@amisibiz/auth`: Authority for roles, permission matrix, and session contracts.
   - `@amisibiz/database`: Authority for database client, scoping contexts, and RLS assertions.
   - `@amisibiz/documents`: Authority for financial math, period numbering, and PDF rendering contracts.
   - `@amisibiz/domain`: Pure business rules, validation schemas, and domain interfaces.
   - `@amisibiz/integrations`: Gateway contracts and hardware/third-party abstractions.
   - `@amisibiz/offline`: SQLite offline storage, client queue, and synchronizer.
   - `@amisibiz/ui`: Shared primitive components.
2. **Web Application (`apps/web`):**
   - All server actions live in `src/server/actions/*` and invoke authorized services.
   - All server services live in `src/server/services/*` and operate under scoped database contexts.
   - API routes are strictly dedicated to machine-to-machine integrations, webhooks, health checks, and binary document streaming.

---

## 4. Multi-Tenant Tenancy Model

1. **Subdomain Resolution:**
   - Format: `<tenant-slug>.<APP_BASE_DOMAIN>` (e.g., `acme.amisibiz.com`).
   - Host header resolution is validated against reserved subdomains (`admin`, `platform`, `api`, `www`, `app`).
   - `X-Forwarded-Host` is untrusted unless `TRUST_PROXY="true"`.
2. **Workspace Status Gate:**
   - `PENDING`: Provisioned by platform operator, inaccessible for general tenant operations.
   - `ACTIVE`: Normal read and write operations permitted.
   - `SUSPENDED`: Online and synchronization writes denied; historical document reads, audits, and portal downloads preserved.
3. **Role Hierarchy:**
   - Platform: `SUPER_ADMIN` > `SUPPORT`.
   - Tenant: `TENANT_OWNER` > `TENANT_ADMIN` > (`SALES` / `FINANCE` / `OPERATIONS`) > `VIEWER` > `CUSTOMER_PORTAL_USER`.

---

## 5. Engineering Delivery Workflow

1. **Inspect Before Modifying:** Check code, schema, and tests before implementing changes.
2. **Never Break Shared Contracts:** Schema changes require coordinated migration planning.
3. **Automated Verification:** Every milestone must pass:
   - `pnpm format:check` (Prettier formatting clean)
   - `pnpm type-check` (0 errors across every workspace)
   - `pnpm lint` (0 errors)
   - `pnpm test:run` (all unit and contract tests green)
   - `pnpm build` (clean static generation and dynamic route registration)
   - `pnpm check:bundles` (no secrets or server-only environment variables in client bundles)
   - `pnpm audit --prod` (no new production dependency vulnerabilities beyond the accepted baseline)
4. **Migration Verification:** Before merge, a schema change must show: `prisma migrate status` clean against a live or simulated chain (every migration applied), and `prisma migrate diff` from the migration chain to the Prisma schema returning an empty diff. Live-database probes and migrations require the owner's explicit authorization.
5. **Honest Completion Claims:** A test, deployment, integration, or app-store submission may never be claimed as succeeded unless it actually did. Partial work is reported as partial, with named blockers.
