# AmisiBiz Architectural Decision Records (ADRs)

**Authority:** AGENT 00 — Chief Engineering Orchestrator  
**Status:** Canonical Decision Log

---

### ADR-001: Next.js 15 App Router & Server Actions

- **Context:** The application requires responsive multi-tenant routing, server-rendered views for performance, and secure mutation channels.
- **Decision:** Adopt Next.js 15 App Router with React Server Components (RSC) and Server Actions.
- **Consequences:** Eliminates unnecessary client-side API boilerplate; enables direct server-to-database transactions while keeping the browser bundle lightweight.

---

### ADR-002: Neon PostgreSQL as Sole Application Database

- **Context:** An earlier design explored Supabase Auth and database services, creating configuration drift and operational fragmentation.
- **Decision:** Standardize exclusively on Neon PostgreSQL as the single database authority via Prisma ORM. Completely remove all Supabase dependencies and client SDKs. _(Executed 2026-10-18: atomic revert `608a0f4` after v0-agent commits reintroduced Supabase.)_
- **Consequences:** The app reaches Neon through its pooled endpoint (`DATABASE_URL`, `channel_binding=require`) and migrations through the unpooled endpoint (`DIRECT_URL`). `@amisibiz/database` also auto-detects the platform-injected Neon alias keys (ADR-009); runtime authority remains `APP_DATABASE_URL` (ADR-011).

---

### ADR-003: Native Web Crypto HMAC Sessions

- **Context:** External auth providers (Auth.js, GoTrue, Clerk) introduce external network latency, third-party lock-in, and complex session coordination.
- **Decision:** Implement native password hashing (bcrypt cost 12) with Web Crypto HMAC-SHA256 signed `amisibiz_session` cookies and `sessionVersion` instant revocation.
- **Consequences:** Zero third-party auth runtime dependencies, microsecond token verification, instant revocation on password change or suspension.

---

### ADR-004: Two-Tier Defense (Service Authorization + PostgreSQL RLS)

- **Context:** Multi-tenant SaaS platforms risk catastrophic data leakage if an application query omits `where: { tenantId }`.
- **Decision:** Implement a dual-layer security model:
  1. Application service layer gates every request with `authorizeTenant(userId, tenantId, permission)`.
  2. Database layer enforces PostgreSQL Row-Level Security (RLS) policies under the runtime `amisibiz_app` role.
- **Consequences:** Accidental code bugs cannot cause cross-tenant data leakage.

---

### ADR-005: Fixed-Decimal Financial Arithmetic in Kenya Shillings (KES)

- **Context:** Floating-point rounding errors lead to compliance failures, taxation discrepancy, and accounting errors.
- **Decision:** Use Kenya Shillings (`KES`) as default currency with string-based fixed decimals (`@amisibiz/documents`). Float math is strictly prohibited.
- **Consequences:** Precise compliance with Kenya Revenue Authority (KRA) eTIMS calculation standards.

---

### ADR-006: Informational Subscription Plans & Operator Lifecycle

- **Context:** Business suspension due to automated billing webhooks disrupts critical East African SME operations.
- **Decision:** Subscription plans are informational. Workspace activation and suspension are strictly controlled by authorized Amisi Genuine operators with mandatory audit reasoning. Suspension preserves historical read access and downloads.
- **Consequences:** Eliminates accidental automated lockouts; enforces human accountability.

---

### ADR-007: Mailtrap Transactional Email via Vercel Integration

- **Context:** Account verification, password recovery, and owner invitations require a reliable transactional email transport on Vercel without vendor lock-in.
- **Decision:** Integrate Mailtrap via native HTTP API, automatically detecting Vercel integration environment variables (`API_KEY`, `USE_SANDBOX`, `INBOX_ID`).
- **Consequences:** Frictionless switching between Sandbox (testing) and Live streams without installing heavy third-party SDKs.

---

### ADR-008: Offline-First Synchronizer Architecture

- **Context:** East African field agents, sales representatives, and retail counters experience frequent internet dropouts.
- **Decision:** Build an offline SQLite storage and outbox queue package (`@amisibiz/offline`) with vector revisions, deterministic conflict resolution, and tombstone deletion.
- **Consequences:** Field operations continue uninterrupted during network outages; synchronizes cleanly when online.

---

### ADR-009: Neon Injected-Key Alias Cascade with Owner-Credential Caveats (2026-10-18, #86)

- **Context:** Neon's Vercel integration injects credentials under a zoo of keys (`POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `DATABASE_URL_UNPOOLED`, …) while the app expects canonical `DATABASE_URL`/`DIRECT_URL`; hardcoded expectations break platform-managed deploys.
- **Decision:** `@amisibiz/database` resolves the first non-empty key from fixed preference orders — pooled: `DATABASE_URL[_2]` > `POSTGRES_PRISMA_URL[_2]` > `POSTGRES_URL[_2]`; unpooled: `DIRECT_URL` > `DATABASE_URL_UNPOOLED[_2]` > `POSTGRES_URL_NON_POOLING[_2]`. Empty injected keys are treated as absent; diagnostics name the source key, never the value.
- **Consequences:** Owner/administrator URL fallbacks are RLS-inert and dev/preview-only; production runtime still requires `APP_DATABASE_URL`, and `STRICT_APP_ROLE="true"` refuses owner fallback in production (ADR-011). Prisma CLI reads canonical `env()` directly (injections do not reach it).

### ADR-010: Migration Shells Retired, Not Edited; C1 Closed via Completion Migration + Authorized Live Reconciliation (2026-10-18, #85)

- **Context:** Migrations 20261024000000–20261028000000 were comment-only shells ("Applied via schema sync") — a fresh deploy silently omitted `User.passwordHash`, `Subscription*`, 17 branding columns, 4 audit columns (Agent 7 C1, NO-GO). Live Neon additionally had the Agent 7 drift SQL applied out-of-band (drift-shape Subscription tables, no enum/RLS; tables empty).
- **Decision:** Never edit applied migrations. The shells are superseded by ONE new migration, `20261029000000_c1_completion_subscription_reform` (R5 reform: enum status, camelCase, planId RESTRICT, changedBy UUID FK, CHECKs, RLS + narrowed grants), proven offline (fresh deploy 22/22, empty diff, SCHEMA-IDENTICAL reconciliation replica by pg_dump) and applied to live Neon under explicit owner authorization, with migration 22 recorded via `prisma migrate resolve --applied`.
- **Consequences:** Live-vs-datamodel diff is empty; the migration chain builds a fresh DB identical to live. Live-database probes/migrations always require owner authorization; the RLS harness only ever runs against a fresh `TEST_DATABASE_URL` database (it re-runs `migrate deploy` and would fail on a reconciled/live DB by design).

### ADR-011: Fail-Closed Production Environment Gates + Scoped Runtime Role (2026-10-18)

- **Context:** A deployed app that silently guesses secrets or origins signs sessions with worthless keys; a superuser runtime connection bypasses every RLS policy.
- **Decision:** `getAuthSecret()` accepts only an explicit `AUTH_SECRET` (≥32 chars) in production — no `NEXTAUTH_SECRET`/`JWT_SECRET` aliases, never derived from DB credentials — and `getAppUrl()` refuses to guess the production origin (`NEXT_PUBLIC_APP_URL`). Vercel is the confirmed web host (owner, 2026-10-18). Runtime database authority is `APP_DATABASE_URL` (the least-privilege `amisibiz_app` role) so the live RLS policies actually bind; `STRICT_APP_ROLE="true"` makes owner-credential fallback a hard production error.
- **Consequences:** Missing production env fails fast with a named variable instead of misbehaving silently. Owner-side actions pending: set `AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, database keys in Vercel Production scope and redeploy; rotate the Neon owner password (it transited chat in plaintext).
