# AmisiBiz

Multi-tenant business document and mini-CRM platform by **Amisi Genuine Enterprises**.

Product branding: Amisi blue + gold. Each business can apply its own branding
(colours/logo) to the documents it issues — see
[`docs/architecture/design-system.md`](docs/architecture/design-system.md).

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript** (strict)
- **Tailwind CSS** with a semantic design-token layer
- **Auth.js (NextAuth v5)** — credentials, JWT sessions
- **Prisma 6** + PostgreSQL (Supabase)
- **Zod** validation, **Vitest** tests
- **next-intl** — English (`/en`), French (`/fr`), Swahili (`/sw`)

## Prerequisites

- Node.js 20+ (developed on Node 24)
- npm
- A PostgreSQL database (Supabase or local)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy `.env.example` to `.env.local` and fill in the values:

   ```bash
   cp .env.example .env.local
   ```

   At minimum set `DATABASE_URL`, `DIRECT_URL` and `AUTH_SECRET`
   (`openssl rand -base64 32`). Never commit `.env.local`.

   Tenant workspaces are served from `<slug>.<APP_BASE_DOMAIN>`; set
   `APP_BASE_DOMAIN` (and `NEXT_PUBLIC_APP_BASE_DOMAIN`) for hostname routing.
   Only set `TRUST_PROXY=true` behind a known reverse proxy — `X-Forwarded-Host`
   is otherwise ignored.

3. **Generate the Prisma client and apply migrations**

   ```bash
   npm run db:generate
   npm run db:migrate
   ```

4. **Seed a platform administrator (optional)**

   Set `SEED_PLATFORM_ADMIN_EMAIL` / `SEED_PLATFORM_ADMIN_PASSWORD` in
   `.env.local`, then:

   ```bash
   npm run db:seed
   ```

5. **Run the app**

   ```bash
   npm run dev
   ```

   Open http://localhost:3000 — you are redirected to your locale (default `/en`).

## Scripts

| Script               | Purpose                     |
| -------------------- | --------------------------- |
| `npm run dev`        | Start the dev server        |
| `npm run build`      | Production build            |
| `npm start`          | Run the production build    |
| `npm run lint`       | ESLint                      |
| `npm run type-check` | TypeScript (`tsc --noEmit`) |
| `npm run test`       | Vitest (watch)              |
| `npm run test:run`   | Vitest (once, for CI)       |
| `npm run format`     | Prettier write              |
| `npm run db:migrate` | Prisma migrate (dev)        |
| `npm run db:seed`    | Seed platform admin         |

## Routes

All routes are locale-prefixed (`/en/...`, `/fr/...`, `/sw/...`) by the
`next-intl` middleware.

| Route                    | Area                    | Access                            |
| ------------------------ | ----------------------- | --------------------------------- |
| `/login`, `/register`    | Authentication          | Public (redirects if signed in)   |
| `/forgot-password`       | Authentication          | Public                            |
| `/reset-password`        | Authentication          | Public (requires token)           |
| `/verify-email`          | Authentication          | Public (requires token)           |
| `/app`                   | Business workspace      | Authenticated + tenant membership |
| `/app/contacts`          | CRM (foundation)        | Authenticated + tenant membership |
| `/app/items`             | Catalogue (foundation)  | Authenticated + tenant membership |
| `/app/documents`         | Documents (foundation)  | Authenticated + tenant membership |
| `/app/settings/branding` | Tenant branding         | Authenticated + tenant membership |
| `/admin`                 | Platform administration | Platform admin permission         |
| `/admin/tenants`         | Platform administration | Platform admin permission         |
| `/admin/tenants/new`     | Provision a tenant      | Platform admin (`tenants.create`) |
| `/admin/tenants/[id]`    | Tenant lifecycle        | Platform admin permission         |
| `/api/health`            | Health check            | Public (no secrets exposed)       |

Protected routes render controlled access states until their module is
implemented in a later phase. Authentication and platform authorization are
real (server-side) — there is no fake auth.

## Tenant lifecycle

New tenants are provisioned **`PENDING`** and become usable only after a platform
administrator **activates** them. Suspension (`ACTIVE → SUSPENDED`) requires a
reason, **blocks all workspace access (read and write)**, and **preserves all
data**; reactivation restores access. Every transition is atomic (status-guarded)
and append-only audited. See
[`docs/architecture/security-model.md`](docs/architecture/security-model.md) §4.1.

## Project structure

```
src/
  app/[locale]/        routes (locale-aware)
  components/ui/       reusable UI kit (button, form fields, table, dialog…)
  components/layout/   shared shells: auth, workspace, admin
  components/branding/ tenant theming wrapper
  lib/auth/            permissions, session, tokens
  lib/tenancy/         hostname / slug utilities
  lib/validation/      shared Zod utilities
  lib/errors.ts        typed ActionResult / error conventions
  server/auth/         server-side authorization service
  server/services/     provisioning and other domain services
  server/actions/      Server Actions
```
