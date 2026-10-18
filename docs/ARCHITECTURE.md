# AmisiBiz System Architecture

**Status:** Canonical Reference Architecture  
**Owner:** Amisi Genuine Enterprises  
**Authority:** AGENT 00 — Chief Engineering Orchestrator  
**Baseline Date:** 2026-10-18

---

## 1. System Topology

AmisiBiz is engineered as a cloud-native, multi-tenant SaaS application deployed on Vercel with serverless execution backed by Neon PostgreSQL.

```mermaid
graph TD
    Client["Client Browser / Mobile / Desktop Shell"] -->|HTTPS / Subdomain / Custom Domain| CDN["Edge Network / Vercel CDN"]
    CDN --> NextMiddleware["Next.js Middleware (Locale + Host Resolution)"]

    subgraph AppServer ["Next.js App Server (Vercel Serverless)"]
        NextMiddleware --> ServerActions["Server Actions (Mutations)"]
        NextMiddleware --> RSC["React Server Components (Reads)"]
        NextMiddleware --> ApiRoutes["API Route Handlers (Files / Sync / Webhooks)"]

        ServerActions --> AuthGuard["Authorization Gate (authorizeTenant / authorizePlatform)"]
        RSC --> AuthGuard

        AuthGuard --> ScopedContext["Database Scoped Context (packages/database)"]
        ScopedContext --> PrismaClient["Prisma Client with RLS Extension"]
    end

    subgraph DataTier ["Data & Persistence Tier"]
        PrismaClient -->|Connection Pooler (pgBouncer / Neon)| NeonDB["Neon PostgreSQL (RLS Enforced)"]
        ApiRoutes -->|Private Storage Access| ObjectStorage["Private Cloud Object Storage (Vercel Blob / S3)"]
    end

    subgraph ExternalServices ["External Services"]
        ServerActions -->|REST API| Mailtrap["Mailtrap Email (Vercel Integration)"]
        ApiRoutes -->|Webhooks / Mocks| eTIMS["KRA eTIMS Tax Compliance"]
        ApiRoutes -->|Webhooks / Mocks| DPO["DPO Pay Payment Gateway"]
        ServerActions -->|AI Generation| AmisiAI["Amisi Intelligence (GenAI LLM)"]
    end
```

---

## 2. Monorepo Package Architecture

```
AmisiBiz/
├── apps/
│   ├── web/               # Next.js 15 App Router web application
│   ├── mobile/            # Capacitor Android shell
│   └── desktop/           # Tauri Windows shell
├── packages/
│   ├── auth/              # RBAC roles, permission catalog, role-permission matrices
│   ├── database/          # Prisma client, RLS scopes (bootstrap, session, tenant)
│   ├── documents/         # Fixed-precision financial math, numbering, PDF generator
│   ├── domain/            # Pure domain validation, WCAG branding algorithms
│   ├── integrations/      # eTIMS, DPO Pay, SMS, POS hardware abstractions
│   ├── offline/           # SQLite storage, outbox queues, conflict resolver
│   ├── sync/              # Client-server sync contracts and tombstone protocols
│   ├── ui/                # UI primitives, styling tokens, and accessible components
│   └── config/            # Centralized TypeScript & ESLint configurations
└── docs/                  # Architecture, governance, operations runbook
```

---

## 3. Tenancy & Subdomain Routing

1. **Host Header Resolution:**
   - In `apps/web/src/middleware.ts`, incoming requests are inspected for subdomain routing.
   - Host format: `<slug>.<APP_BASE_DOMAIN>` (e.g. `store.amisibiz.com`).
   - Reserved hostnames: `admin`, `platform`, `api`, `www`, `app`.
   - Custom domains: Mapped via `TenantDomain` model in the database.
2. **Lifecycle State Machine:**
   - `PENDING`: Workspace provisioned by Amisi Genuine operator; normal business routes 404/deny access until activated.
   - `ACTIVE`: Fully operational.
   - `SUSPENDED`: Online and synchronization writes are denied by database guard triggers (`app_tenant_accepts_writes()`), while read-only access and historical document retrieval remain intact.

---

## 4. Authentication & Security Trust Chain

1. **Session Architecture:**
   - Native Web Crypto HMAC-SHA256 cookie (`amisibiz_session`).
   - Signed with `AUTH_SECRET` (minimum 32 characters; **fail-closed in production** — the app refuses to boot without it; no alias variables are accepted, ADR-011).
   - Contains `{ userId, sessionVersion, platformRole, exp }`.
   - Fast session re-validation checks `user.sessionVersion === payload.sessionVersion` on every request.
2. **Immediate Revocation:**
   - To revoke all sessions (e.g., password reset, suspension, compromise), increment `User.sessionVersion` in PostgreSQL. All issued tokens immediately fail validation.
3. **Password Recovery:**
   - Handled via Mailtrap HTTP API (supporting both Sandbox and Live production streams).
   - Generates single-use signed tokens embedding the user's `sessionVersion`.
   - Consumed at `/auth/callback`, establishing a temporary recovery session to complete password reset on `/[locale]/reset-password`.
4. **Runtime Database Role:**
   - The runtime connection authority is `APP_DATABASE_URL` (the scoped `amisibiz_app` role), so the live RLS policies bind at the database tier; owner-credential connections bypass RLS as table owner and are dev/preview-only (`STRICT_APP_ROLE="true"` makes the fallback a hard production error, ADR-009/011).
   - Live Neon is at 22/22 migrations with an empty live-vs-datamodel diff (2026-10-18).
5. **Storage Topology Note:**
   - `ObjectStorage` in the diagram is the **target** topology (`@vercel/blob` installed); until the provider is configured (`STORAGE_PROVIDER`), logo storage falls back to the local filesystem — non-persistent on serverless (capability #15, Phase 1/9 critical path).

---

## 5. Financial & Document Numbering Rules

1. **Currency:** `KES` default, explicit ISO currency code on every line and document.
2. **Strict Non-Float Arithmetic:** All quantities, unit prices, discounts, and tax rates are processed as string-based decimals using `@amisibiz/documents`.
3. **Atomic Numbering:**
   - Handled via `allocate_document_number()` in PostgreSQL using row locks (`SELECT ... FOR UPDATE` on `DocumentNumberSequence`).
   - Enforces unique sequences per `(tenantId, documentType, period)`.
   - Immutable snapshot frozen into `Document.snapshot` upon issuance.
