# AmisiBiz Database Design & Schema Specification

**Database Engine:** PostgreSQL 16 (Neon Serverless)  
**ORM / Schema Authority:** Prisma 6.19 (`apps/web/prisma/schema.prisma`)  
**Authority:** AGENT 00 — Chief Engineering Orchestrator  
**Status:** Canonical Design

---

## 1. Core Principles

1. **UUID Primary Keys:** All primary keys are UUIDs (`@default(dbgenerated("gen_random_uuid()")) @db.Uuid`). Client-generated UUIDs are supported on offline sync paths.
2. **Tenant Scoping:** Every business entity includes a `tenantId UUID` foreign key with cascade deletion on tenant destruction.
3. **Immutability of Issued Records:** Documents in `ISSUED` status store their exact financial calculation and snapshot in a dedicated JSON/text `snapshot` column.
4. **Zero-Float Money:** All money amounts, quantities, and rates are stored as fixed decimals or formatted decimal strings.

---

## 2. Canonical Model Catalog

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PLATFORM & IDENTITY                             │
├─────────────────────┬──────────────────────┬───────────────────────────┤
│ User                │ PlatformRole (Enum)  │ AuditLog                  │
│ Tenant              │ TenantStatusHistory  │ SupportAccessGrant        │
│ TenantDomain        │ Plan                 │ Subscription              │
│ SubscriptionStatusHistory                  │ SubscriptionStatus (Enum) │
├─────────────────────┴──────────────────────┴───────────────────────────┤
│                             TENANT RBAC                                │
├─────────────────────┬──────────────────────┬───────────────────────────┤
│ TenantMember        │ Permission           │ RolePermission            │
├─────────────────────┴──────────────────────┴───────────────────────────┤
│                       CRM & PRODUCT CATALOGUE                          │
├─────────────────────┬──────────────────────┬───────────────────────────┤
│ Contact             │ ContactAddress       │ ContactItem               │
│ Item                │ ItemCategory         │ TaxCategory / TaxRate     │
├─────────────────────┴──────────────────────┴───────────────────────────┤
│                        DOCUMENTS & NUMBERING                           │
├─────────────────────┬──────────────────────┬───────────────────────────┤
│ Document            │ DocumentLine         │ DocumentPayment           │
│ DocumentStatusEvent │ DocumentNumbering    │ DocumentNumberSequence    │
├─────────────────────┴──────────────────────┴───────────────────────────┤
│                            OFFLINE SYNC                                │
├─────────────────────┬──────────────────────┬───────────────────────────┤
│ SyncOperation       │ SyncDeletion         │                           │
└─────────────────────┴──────────────────────┴───────────────────────────┘
```

---

## 3. Schema Details by Domain

### Platform & Tenancy

- **`Tenant`**: Core tenant container with `slug` (unique), `name`, `status` (`PENDING`, `ACTIVE`, `SUSPENDED`), `planId`, `branding` (colors/logo), and activity timestamps (`lastActivityAt`, `lastSyncAt`).
- **`TenantDomain`**: Custom domains and verified hostnames.
- **`TenantStatusHistory`**: Immutable log of lifecycle transitions with mandatory operator reason.
- **`Plan`**: Informational subscription plan definitions.

### Users & Permissions

- **`User`**: Native credentials (`passwordHash`), `email` (unique), `status`, `sessionVersion` (revocation counter), and `platformRole` (`SUPER_ADMIN`, `SUPPORT`, or null).
- **`TenantMember`**: Binds a user to a tenant with a `TenantRole` (`TENANT_OWNER`, `TENANT_ADMIN`, `SALES`, `FINANCE`, `OPERATIONS`, `VIEWER`, `CUSTOMER_PORTAL_USER`).
- **`Permission` & `RolePermission`**: Fine-grained catalog. Code authority: **57 permission keys** in `@amisibiz/auth`; the DB seed currently carries 42 — the reseed to the code matrix is tracked as H1 (#87) and verified by parity tests.
- **`SupportAccessGrant`**: Time-boxed read-only support access for platform operators.
- **`Subscription`** _(live since migration `20261029000000`, R5 reform)_: One per tenant (unique `tenantId`), `status SubscriptionStatus` enum (`ACTIVE/PAUSED/TRIAL/CANCELLED/ARCHIVED`), camelCase period columns with CHECK-ordered ranges, `planId NOT NULL` with **ON DELETE RESTRICT** (the legacy SET NULL draft collided with NOT NULL). RLS: tenant-scoped SELECT, platform-admin writes, no DELETE. **`SubscriptionStatusHistory`**: append-only changelog, `changedBy UUID` FK → User (SET NULL), platform-admin SELECT/INSERT only. Schema-only today — consumer code is future scope.

### CRM & Catalogue

- **`Contact`**: B2B and B2C customer profiles with phone, email, notes, tax PIN, and linked `portalUserId`.
- **`ContactAddress`**: Multiple addresses per contact (PHYSICAL, BILLING, DELIVERY).
- **`ContactItem`**: Customer-specific tiered pricing overriding catalogue standard pricing.
- **`Item`**: Product catalogue with SKU, barcode, unit of measure, unit price, and linked `taxCategoryId`.
- **`TaxCategory` & `TaxRate`**: Configurable tax definitions (e.g. 16% standard VAT, 0% exempt).

### Documents & Payments

- **`Document`**: Quotation, Invoice, Delivery Note. Contains atomic `documentNumber`, currency (`KES`), issue date, due date, status, notes, total net/tax/gross, and JSON snapshot.
- **`DocumentLine`**: Line item detail with item reference, quantity, unit price, discount, and tax rate.
- **`DocumentPayment`**: Payment record against an invoice, deriving `PAID` or `PARTIALLY_PAID` document status.
- **`DocumentNumbering` & `DocumentNumberSequence`**: Manages atomic numbering sequences with calendar/fiscal period resets.

### Synchronization

- **`SyncOperation`**: Stores offline change operations and outcome statuses.
- **`SyncDeletion`**: Tombstone records ensuring hard deletes propagate reliably to offline clients.

---

## 4. Connection Pooling & Migrations

- **Runtime Connection:** Neon **pooled endpoint** via `DATABASE_URL` (`channel_binding=require`). `@amisibiz/database` also accepts the platform-injected Neon alias keys in a fixed preference order (ADR-009); production runtime authority is `APP_DATABASE_URL` (the scoped `amisibiz_app` role — this is what makes the RLS policies bind).
- **Migration Connection:** Neon **unpooled endpoint** via `DIRECT_URL` (unpooled aliases stand in when set, per ADR-009).
- **Migrations:** All 22 migrations in `apps/web/prisma/migrations/` are applied sequentially (live Neon verified up to date, 2026-10-18), validated with `prisma migrate diff` (live-vs-datamodel: empty), and frozen once applied — drift between the shell-era record and live was closed by the completion migration + owner-authorized reconciliation (ADR-010).
