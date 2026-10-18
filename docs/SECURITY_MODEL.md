# AmisiBiz Security Model & Threat Architecture

**Status:** Canonical Security Architecture  
**Owner:** Amisi Genuine Enterprises  
**Authority:** AGENT 00 — Chief Engineering Orchestrator  
**Applicability:** All web applications, API endpoints, and background services.

---

## 1. Trust Boundaries

```
[Untrusted Client: Web Browser / Mobile / Attacker]
       │
       ▼ (Boundary A)
[Edge Middleware: Subdomain Host Resolution + Locale Prefixing]
       │
       ▼ (Boundary B)
[Server Actions & Route Handlers: Input Validation (Zod) + Authentication Check]
       │
       ▼ (Boundary C)
[Authorization Layer: authorizeTenant / authorizePlatform (RBAC Check)]
       │
       ▼ (Boundary D)
[Domain Services: Business Invariants, Transaction Scope]
       │
       ▼ (Boundary E)
[PostgreSQL Database: Row-Level Security (RLS) + Security Definer Functions]
```

1. **Boundary A (Edge Middleware):**
   - Validates hostname against reserved subdomains.
   - Ignores untrusted proxy headers unless `TRUST_PROXY="true"`.
2. **Boundary B (Server Actions & Route Handlers):**
   - Cryptographically verifies session token cookie (`amisibiz_session`).
   - Parses input strictly with Zod schemas.
   - Never trusts client-submitted tenant IDs, user IDs, or role assertions.
3. **Boundary C (Authorization Layer):**
   - Deny-by-default RBAC check against the explicit permission catalog — code authority: **57 keys** in `@amisibiz/auth`; the DB catalog reaches exact parity through migration `20261030000000_h1_permission_catalog_reseed` (offline-proven 33/33; live application owner-gated, see §6).
   - Cross-checks tenant membership active status and suspension gates.
   - Emits `AUTH_DENIED` audit events upon unauthorized attempts.
4. **Boundary D (Domain Services):**
   - Enforces transactional scoping via `packages/database`.
   - Prevents cross-tenant entity references (e.g., assigning a contact from tenant A to a quotation in tenant B).
5. **Boundary E (PostgreSQL RLS):**
   - Defense-in-depth barrier preventing any data leakage even in the event of an application logic defect.

---

## 2. Authentication Standard

- **Password Hashing:** `bcryptjs` with cost factor 12.
- **Session Tokens:** Web Crypto HMAC-SHA256, expiration 7 days (`SESSION_MAX_AGE_SECONDS`), signed with `AUTH_SECRET` (minimum 32 characters).
- **Session Cookies:** `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`.
- **Instant Revocation:** Verified via `User.sessionVersion`. Incrementing `sessionVersion` invalidates all issued session tokens immediately.
- **Password Reset:** Signed single-use tokens expiring in 1 hour; delivered via Mailtrap API. Tokens embed `sessionVersion` and are invalidated upon password update.
- **Rate Limiting:** Distributed token bucket rate limiting via Redis/Upstash (with in-memory fallback for local development) on login, registration, and password recovery endpoints.

---

## 3. Role-Based Access Control (RBAC)

### Platform Roles

- `SUPER_ADMIN`: Full administrative control over all tenants, provider settings, and platform audit logs.
- `SUPPORT`: Read-only tenant inspection granted strictly via time-boxed `SupportAccessGrant` with mandatory reason.

### Tenant Roles

- `TENANT_OWNER`: Full control of business workspace, branding, team management, and billing.
- `TENANT_ADMIN`: Day-to-day administrative authority, user invitations, and catalogue settings.
- `SALES`: Quotations, contacts, leads, deals, orders.
- `FINANCE`: Invoicing, payments, tax settings, financial reporting.
- `OPERATIONS`: Delivery notes, inventory adjustments, dispatch.
- `VIEWER`: Read-only access to issued documents.
- `CUSTOMER_PORTAL_USER`: Restricted customer access to download own issued documents.

---

## 4. Tenant Suspension Semantics

When a tenant is placed into `SUSPENDED` status by an Amisi Genuine operator:

1. **Writes Denied:** All online write actions and offline sync pushes are rejected by database triggers (`app_tenant_accepts_writes()`).
2. **Reads & Downloads Preserved:** Existing members and portal customers retain read-only access to historical documents, invoices, and receipts.
3. **Data Integrity:** No rows, files, or audit logs are deleted.

---

## 5. Audit Logging Architecture

Every privileged action, authentication event, status change, and security denial must be logged to the immutable `AuditLog` table with:

- `tenantId` (nullable for platform-level actions)
- `userId` (actor)
- `action` (standardized constant from `AUDIT_ACTIONS`)
- `resource` & `resourceId`
- `ipAddress` & `userAgent`
- Sanitized `metadata` (with all emails, passwords, and tokens masked)

---

## 6. Current Security Posture & Known Gaps (updated 2026-10-18, AGENT 01 pass)

**In force:**

- RLS is live on Neon (22/22 migrations applied; live-vs-datamodel diff empty); the Subscription tables ship with tenant-scoped SELECT / platform-admin writes, and history is append-only admin-only (migration `20261029000000`, R5 reform). Migration 23 (`20261030000000_h1_permission_catalog_reseed`) is authored and proven offline at 33/33; live application awaits owner go-ahead.
- **RLS binds the application only when it connects as `amisibiz_app`** via `APP_DATABASE_URL`; owner-credential connections bypass as table owner (non-FORCE policies). Production must set `APP_DATABASE_URL` (+ `STRICT_APP_ROLE="true"` to refuse owner fallback).
- Fail-closed production env gates: no `AUTH_SECRET` (≥32 chars, no aliases) or `NEXT_PUBLIC_APP_URL` → the app refuses to boot rather than guess (ADR-011).
- **HTTP security headers** applied to every route via `next.config.mjs` from the typed `src/lib/security/headers.ts` module: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-XSS-Protection: 0`, HSTS (2 years, includeSubDomains, preload), `X-DNS-Prefetch-Control: off`, and a `Permissions-Policy` disabling camera/microphone/geolocation/payment/usb/interest-cohort. Asserted by `tests/agent01-security-hardening.test.ts`.
- **Tenant identity is never client-selectable:** middleware resolves the host (forwarded host only when `TRUST_PROXY="true"`), rejects reserved subdomains with 404, and sets or **strips** `x-tenant-subdomain` server-side so a client-injected value cannot reach downstream code. Forged-tenantId denials and cross-tenant write refusal are tested (same suite).
- Suspension semantics proven by tests: reads and already-issued portal downloads preserved, every write permission refused and audited (`app_tenant_accepts_writes()` gate). No scheduled jobs or webhooks exist yet, so no job revocation path is required until those subsystems land.
- Verification executed: RLS harness **33/33** on the completed 23-migration chain (throwaway cluster); client-bundle secret scan clean; CI verify + security jobs (real Postgres).

**Open gaps (sequenced in `docs/ROADMAP.md`):**

1. **H1 live application** — migration 23 brings any DB (fresh 53-key chain or live Neon at 42) to the 57-key/122-row parity idempotently; applying it to live Neon needs the owner's explicit go-ahead. Its section 0 replaces `Permission_domain_matches_prefix` with an equivalent-strength explicit-membership CHECK (five catalog keys lack the `platform.` prefix; the prefix rule made exact parity unreachable). CI's hardcoded `Permission` count of 42 must be raised to 57 in the same window.
2. **No CSP** — deliberately deferred by the headers module: App Router nonce-based inline scripts make a static CSP either breaking or `unsafe-inline`; a future CSP must be generated in middleware (owner decision).
3. **Data retention/deletion** — no retention schedule or tenant-deletion runbook exists; the current stance is by-design: suspension never deletes data or financial records, and hard deletion requires an explicit owner-approved procedure (not yet defined).
4. Error tracking is a deliberate no-SaaS boundary (`lib/error-tracking.ts`); a hosted option needs an owner decision.
5. Self-serve `/register` auto-provisioning conflicts with provider-controlled onboarding (PRD §3.2; Phase 2).
6. Private object storage provider not configured for documents/PDFs — logos now have a Vercel Blob path in flight (owner work); document storage remains dev filesystem fallback (capability #15).
