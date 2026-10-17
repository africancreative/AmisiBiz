# AmisiBiz — Data Model (as-built)

- **Status:** As-built reference. Derived directly from
  `apps/web/prisma/schema.prisma` (1102 lines) and `apps/web/prisma/migrations/`
  at `main` @ `ddcdec9`, 2026-10-17.
- **Source of truth:** the Prisma schema and the SQL migrations. If this document
  and the schema disagree, the schema wins — update this document.
- **Companion docs:** `system-overview.md`, `security-model.md`,
  `../implementation/agent-work-plan.md`, `../implementation/acceptance-matrix.md`.
- **Coverage:** 29 models, 15 enums, 20 migrations.

> Identity note: the schema header and the `User` model comments still say
> `User.id` equals the **Supabase Auth** user UUID, and
> `TenantBranding.logoUrl` mentions Supabase storage. These comments are
> **stale**: identity is now native (`User.passwordHash` + `sessionVersion`),
> and Supabase was removed in commit `2fff426`. Comment-only drift, no schema
> change (see `agent-work-plan.md` §4).

---

## 1. Conventions

| Convention            | Rule                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Primary keys          | `String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid` on every model                                        |
| Timestamps            | `createdAt @default(now())`, `updatedAt @updatedAt` (append-only tables omit `updatedAt`)                              |
| Money & quantities    | `Decimal @db.Decimal(18, 4)` stored in **major units with 4dp** (never floats)                                         |
| Percentages / rates   | `Decimal @db.Decimal(5, 4)` (e.g. `0.1600`) or `@db.Decimal(5, 2)` for discount percents                               |
| Tenant scoping        | Business tables carry `tenantId @db.Uuid` and an index starting with `tenantId`                                        |
| Offline revisions     | `revision Int @default(1)` on mutable business rows; bumped by the `amisibiz_bump_revision` trigger                    |
| Referential integrity | `onDelete: Cascade` within a tenant; `SetNull` for cross-cutting actor FKs; `Restrict` where history must survive      |
| Append-only history   | `TenantStatusHistory`, `SubscriptionStatusHistory`, `DocumentStatusEvent`, `AuditLog`, `SyncOperation`, `SyncDeletion` |
| Row-level security    | Enabled per table; policies read transaction-local `app.*` GUCs set by `set_tenant_context(...)`                       |

### 1.1 Actor / lifecycle foreign keys

Lifecycle and attribution columns are stored as scalar UUIDs **and** modelled as
named relations to `User` with `onDelete: SetNull` (e.g.
`Tenant.activatedById`, `Document.issuedById`, `AuditLog.userId`). Named
relations (`TenantCreatedBy`, `DocumentDerivation`, `DocumentReplacement`, …)
disambiguate the multiple `User`/`Document` relations on the same model.

### 1.2 Polymorphic references

`AuditLog.resourceType` + `resourceId` are **intentionally not** a foreign key —
audit rows must survive deletion of the referenced business record.

---

## 2. Enums (15)

| Enum                   | Values                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TenantStatus`         | `PENDING`, `ACTIVE`, `SUSPENDED`                                                                                                                   |
| `PlanStatus`           | `ACTIVE`, `ARCHIVED`                                                                                                                               |
| `UserStatus`           | `ACTIVE`, `INACTIVE`, `INVITED`, `SUSPENDED`                                                                                                       |
| `PlatformRole`         | `SUPER_ADMIN`, `SUPPORT`                                                                                                                           |
| `TenantRole`           | `TENANT_OWNER`, `TENANT_ADMIN`, `SALES`, `FINANCE`, `OPERATIONS`, `VIEWER`, `CUSTOMER_PORTAL_USER`                                                 |
| `InvitationStatus`     | `PENDING`, `ACCEPTED`, `EXPIRED`, `REVOKED`                                                                                                        |
| `ContactType`          | `INDIVIDUAL`, `BUSINESS`                                                                                                                           |
| `ContactStatus`        | `ACTIVE`, `ARCHIVED`                                                                                                                               |
| `ItemType`             | `PRODUCT`, `SERVICE`                                                                                                                               |
| `ItemStatus`           | `ACTIVE`, `INACTIVE`                                                                                                                               |
| `DocumentType`         | `QUOTATION`, `INVOICE`, `DELIVERY_NOTE`                                                                                                            |
| `DocumentStatus`       | `DRAFT`, `ISSUED`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `CANCELLED`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `VOID`, `PARTIALLY_DELIVERED`, `DELIVERED` |
| `PaymentMethod`        | `CASH`, `BANK_TRANSFER`, `MOBILE_MONEY`, `CARD`, `CHEQUE`, `OTHER`                                                                                 |
| `DocumentDiscountType` | `PERCENT`, `AMOUNT`                                                                                                                                |
| `DocumentPeriodStyle`  | `NONE`, `CALENDAR_YEAR`, `FINANCIAL_YEAR`                                                                                                          |

> `DocumentStatus` is one enum spanning three document types; the valid subset
> per type is enforced in the domain layer (`@amisibiz/documents`), not by the
> database. `Subscription.status` is a **`String`**, not an enum (see §6 gaps).

---

## 3. Entity catalogue

### 3.1 Identity and authentication

**`User`** — one row per human identity (staff, tenant member, portal customer).

- Key fields: `email @unique`, `name?`, `emailVerified?`, `image?`,
  `platformRole PlatformRole?`, `status UserStatus @default(ACTIVE)`,
  `passwordHash String?` (bcrypt), `sessionVersion Int @default(0)`.
- `sessionVersion` is the revocation counter: bumping it invalidates every
  issued session cookie for that user.
- Relations: `tenantMemberships`, `portalContacts` (`ContactPortalAccess`),
  `auditLogs`, and the lifecycle/document actor relations.
- Indexes: `email`, `platformRole`, `sessionVersion`.

> Identity mapping requirement: a user is (a) a platform actor when
> `platformRole` is set, and/or (b) a tenant actor through `TenantMember`, and/or
> (c) a portal actor through `Contact.portalUserId`. There is no separate
> "auth provider" table — this _is_ the identity map now.

### 3.2 Tenancy

**`Tenant`** — a customer business workspace.

- Identity: `slug @unique`, `name`, `logoUrl?`, `country?`, `currency` (`KES`),
  `timezone` (`UTC`), `locale` (`en`).
- Lifecycle: `status @default(PENDING)`, `activatedAt?`, `activatedById?`,
  `suspendedAt?`, `suspendedById?`, `suspensionReason?`.
- Plan: `planId?` → `Plan` (explicitly **informational, never an entitlement**).
- Sync telemetry: `lastActivityAt?`, `lastSyncAt?`, `lastSyncErrorCode?`.
- Relations: `members`, `invitations`, `settings`, `branding`, `domains`,
  `contacts`, `items`, `contactItems`, `taxCategories`, `taxRates`,
  `documents`, `documentLines`, `documentPayments`, `documentStatusEvents`,
  `documentNumberings`, `documentSequences`, `subscriptions`, `statusHistory`,
  `supportGrants`, `auditLogs`, `syncOperations`, `syncDeletions`.

**`TenantDomain`** — approved hostnames for a tenant.

- `hostname @unique` (global uniqueness), `isPrimary`, `verifiedAt?`,
  `@@index([tenantId])`. Supports custom domains per tenant.

**`TenantSettings`** — currently a **near-empty table**: `tenantId @unique`,
timestamps only. Settings live on `Tenant` and `TenantBranding`. Either populate
or drop (see §6).

**`TenantBranding`** — per-tenant document/appearance configuration.

- Colours: `primaryColor`/`secondaryColor`/`accentColor`/`primaryForeground`
  (hex, with defaults), `logoUrl?`.
- Document identity: `displayName?`, `registeredName?`, `contactEmail?`,
  `contactPhone?`, `postalAddress?`, `physicalAddress?`, `website?`, `taxPin?`,
  `currency` (`KES`), `defaultFooter?`, `paymentInstructions?`.
- Templates: `documentLayout`, `invoiceTemplate` + `invoiceCustomizations Json?`,
  `quotationTemplate` + `quotationCustomizations Json?`, `deliveryNoteTemplate` +
  `deliveryNoteCustomizations Json?`.
- Numbering prefs: `documentNumberingPrefix`, `documentNumberingPadding`,
  `documentPeriodStyle`, `fiscalStartMonth`.
- Integration flags: `etimsCompatible`, `etimsDocumentType?`, `etimsSerialNumber?`,
  `etimsLastSync?`, `cloudinaryPresetName?`, `dpoIntegrationStatus?`,
  `mailtrapFromEmail?`.
- `tenantId @unique`.

**`TenantStatusHistory`** — append-only lifecycle trail.

- `fromStatus TenantStatus?`, `toStatus TenantStatus`, `changedById?`, `reason?`,
  `createdAt`. Index `@@index([tenantId, createdAt])`.

### 3.3 Membership, roles, permissions, invitations

**`TenantMember`** — the join between `User` and `Tenant`.

- `role TenantRole @default(VIEWER)`, `isDefault Boolean @default(false)` (the
  tenant selected at login), `joinedAt`, `@@unique([tenantId, userId])`.
- `CUSTOMER_PORTAL_USER` members are granted **portal-only** access; internal
  records are denied regardless of tenant.

**`Permission`** — the permission catalogue.

- `key @unique` (e.g. `contacts.read`, `platform.tenants.activate`),
  `domain` (`platform` | `tenant`), `area` (e.g. `documents.invoice`),
  `description`.
- Seeded from the code catalogue in `@amisibiz/auth`; a parity test asserts
  code ⇄ database equality.

**`RolePermission`** — role → permission grant.

- `roleKey` (enum member name, e.g. `TENANT_ADMIN`, `SUPER_ADMIN`), `domain`,
  `permissionId` → `Permission`, `@@unique([roleKey, permissionId])`.
- Role matrices are code-defined and seeded; direct DB edits are drift.

**`Invitation`** — pending membership offer.

- `tenantId`, `email`, `role @default(VIEWER)`,
  `tokenHash @unique` (**SHA-256 of the token** — the raw token is never stored),
  `status @default(PENDING)`, `invitedBy` (userId), `expiresAt`, `acceptedAt?`,
  `@@unique([tenantId, email])`.

**`SupportAccessGrant`** — time-boxed, read-only provider access to one tenant.

- `tenantId`, `platformUserId`, `grantedById?`, `reason` (required, non-empty),
  `expiresAt @db.Timestamptz(3)`, `revokedAt?`, `createdAt`.
- Indexed on `(platformUserId, tenantId)`. Grants never enable writes.

### 3.4 Plans and subscriptions

**`Plan`** — catalogue entry.

- `code @unique`, `name`, `description`, `status PlanStatus @default(ACTIVE)`,
  `sortOrder`, `@@index([status, sortOrder])`.

**`Subscription`** — one per tenant (enforced by `@@unique([tenantId])`).

- `planId` → `Plan`, `status String` (ACTIVE/PAUSED/TRIAL/CANCELLED/ARCHIVED),
  `current_period_start/end?`, `trial_start/end?`,
  `cancel_at_period_end`, `canceled_at?`.

**`SubscriptionStatusHistory`** — append-only change log with
`from_status?`, `to_status`, `changed_by?`, `reason?`.

> `Tenant.planId` (informational label) and `Subscription.planId`
> (billing record) coexist. Entitlements are **not** enforced anywhere yet.

### 3.5 Contacts and addresses

**`Contact`** — tenant customer/supplier record.

- `type ContactType`, `status ContactStatus @default(ACTIVE)`,
  `firstName?`/`lastName?`/`companyName?`, `email?`, `phone?`, `mobile?`,
  `taxPin?`, `notes?`, `archivedAt?`, `revision`.
- **Portal link:** `portalUserId?` → `User` (`ContactPortalAccess`),
  `@@unique([tenantId, portalUserId])`. This is the customer-portal membership
  (no separate model).
- Indexes cover `(tenantId, status)`, `(tenantId, email)`, `(tenantId, phone)`,
  `(tenantId, companyName)`, `(tenantId, createdAt)`.

**`ContactAddress`** — `contactId`, `type` (`POSTAL` | `PHYSICAL`), `line1`,
`line2?`, `city?`, `state?`, `postalCode?`, `country?`, `isDefault`.

### 3.6 Catalogue and customer-specific pricing

**`Item`** — catalogue product/service.

- `type ItemType`, `status ItemStatus`, `name`, `sku?`, `description?`,
  `unitOfMeasure` (`each`), `unitPrice Decimal(18,4)`, `currency` (`KES`),
  `taxRateId?`, `revision`. `@@unique([tenantId, sku])`.

**`ContactItem`** — per-customer price override / agreement.

- `contactId`, `itemId`, `customCode?`, `customName?`, `customUnitOfMeasure?`,
  `agreedPrice Decimal(18,4)`, `discountPercent Decimal(5,2)`,
  `isAvailable`, `validFrom?`/`validUntil?`, `revision`.
- `@@unique([tenantId, contactId, itemId])`.

### 3.7 Tax

**`TaxCategory`** — `tenantId`, `name`, `description?`, `isDefault`,
`@@unique([tenantId, name])`.
**`TaxRate`** — `categoryId`, `name`, `rate Decimal(5,4)`, `effectiveFrom`,
`effectiveTo?`, `isActive`, `@@unique([tenantId, categoryId, name, effectiveFrom])`.
Referenced by `Item.taxRateId` and `DocumentLine.taxRateId`.

### 3.8 Documents, lines, payments, events, numbering

**`Document`** — a quotation, invoice or delivery note.

- `type DocumentType`, `status DocumentStatus @default(DRAFT)`, `number?`
  (assigned on issue), `currency`.
- Party & derivation: `contactId?` (`SetNull`),
  `sourceDocumentId?` (`DocumentDerivation`, `Restrict`),
  `replacementOfId?` (`DocumentReplacement`, `Restrict`).
- Idempotency: `idempotencyKey?`, `@@unique([tenantId, idempotencyKey])`,
  `@@unique([tenantId, type, number])`.
- Lifecycle: `issueDate`, `dueDate?`, `expiryDate?`, `deliveryDate?`,
  `deliveryNote?`, `issuedAt?`/`issuedById?`, `voidedAt?`/`voidReason?`/`voidedById?`.
- Money: `subtotal`, `totalDiscount`, `taxableBase`, `taxTotal`, `total`
  (all `Decimal(18,4)`), `taxBreakdown Json?`, `roundingPolicy`
  (`half-up-per-line-v1`).
- **Immutable issued snapshot:** `snapshot Json?` + `snapshotAt?` freeze the
  rendered document; edits after issue are refused at the DB level.
- `revision`. Indexed by `(tenantId, status)`, `(tenantId, type, status)`,
  `(tenantId, issuedAt)`, `(tenantId, dueDate)`, `(tenantId, contactId)`.

**`DocumentLine`** — `documentId`, `position` (`@@unique([tenantId, documentId, position])`),
`itemId?` (`Restrict`), `sourceLineId?` (`DeliveryAgainst`, `Restrict`),
`description`, `itemCode?`, `quantity`, `unitPrice`, `discountType?`,
`discountPercent`, `discountAmount`, `lineTotal`, `lineDiscount`, `lineNet`,
`lineTax`, `taxRateId?`, `taxName?`, `taxRate`, `deliveredQuantity`.

**`DocumentPayment`** — `documentId` (`Restrict`), `amount`, `occurredOn`,
`method PaymentMethod`, `reference?`, `note?`, `reversedAt?`,
`reversedBy?`→`User`. Derived `Document.status` (`PARTIALLY_PAID`/`PAID`) is
computed from these.

**`DocumentStatusEvent`** — append-only `fromStatus?`, `toStatus`, `reason?`,
`actorId?`, `createdAt`.

**`DocumentNumbering`** — per `(tenantId, type)` config: `prefix`, `padding`,
`separator`, `periodStyle`, `fiscalStartMonth`. `@@unique([tenantId, type])`.

**`DocumentNumberSequence`** — per `(tenantId, type, period)` counter
(`nextValue`), FK to `DocumentNumbering` on the composite key. Allocated
atomically by a DB function.

### 3.9 Audit

**`AuditLog`** — append-only, write-protected.

- `tenantId?` (null = system), `userId?`, `action`, `resource?`,
  `resourceType?` + `resourceId?` (polymorphic), `outcome?`,
  `outcomeDetails?`, `correlationId?`, `metadata Json?`, `ipAddress?`,
  `userAgent?`, `createdAt`.
- Descending index `AuditLog_tenantId_createdAt_idx` for tenant history.

### 3.10 Offline sync

**`SyncOperation`** — server-side record of a client operation;
`clientId`, `operationId`, `entity`, `entityId`, `outcome`, `revision?`,
`reason?`, `conflictId?`, `@@unique([clientId, operationId])` (idempotency).

**`SyncDeletion`** — tombstone feed: `entity`, `entityId`, `revision`,
`deletedAt`, `deletedById?`, `@@unique([tenantId, entity, entityId])`.

---

## 4. Coverage against the required MVP data model

| Required topic                              | Implementation                                                                                                      | Status                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Users & auth identity mapping               | `User` (`passwordHash`, `sessionVersion`, `platformRole`)                                                           | ✅                             |
| Tenants & approved tenant domains           | `Tenant`, `TenantDomain`                                                                                            | ✅                             |
| Tenant memberships                          | `TenantMember`                                                                                                      | ✅                             |
| Roles & permissions                         | `PlatformRole`/`TenantRole` + `Permission` + `RolePermission`                                                       | ✅                             |
| Invitations                                 | `Invitation` (+ `tokenHash`)                                                                                        | ✅                             |
| Subscription plans & tenant assignments     | `Plan`, `Subscription`, `SubscriptionStatusHistory`, `Tenant.planId`                                                | ⚠️ no entitlement enforcement  |
| Tenant activation/suspension history        | `TenantStatusHistory` (+ `Tenant` lifecycle columns)                                                                | ✅                             |
| Audit logs                                  | `AuditLog` (append-only)                                                                                            | ✅                             |
| Contacts & addresses                        | `Contact`, `ContactAddress`                                                                                         | ✅                             |
| Catalogue items & customer-specific pricing | `Item`, `ContactItem`                                                                                               | ✅                             |
| Tax configurations                          | `TaxCategory`, `TaxRate`                                                                                            | ✅                             |
| Documents, lines, sequences, events         | `Document`, `DocumentLine`, `DocumentNumbering`, `DocumentNumberSequence`, `DocumentStatusEvent`, `DocumentPayment` | ✅                             |
| Customer portal memberships & access grants | `Contact.portalUserId` + `TenantMember.role = CUSTOMER_PORTAL_USER`; provider grants via `SupportAccessGrant`       | ⚠️ no dedicated portal model   |
| Private file metadata & storage references  | `Tenant.logoUrl` / `TenantBranding.logoUrl` + `/uploads` route + `storage.objects` policies                         | ❌ no File/blob metadata table |
| Tenant settings                             | `TenantSettings` (empty) + `Tenant`/`TenantBranding`                                                                | ⚠️ effectively unused          |

---

## 5. Minimum schema changes for the MVP

These are the _smallest_ changes that close the required-model gaps. Each is a
candidate backup/verify migration, not yet authorised.

1. **File / document-storage metadata** — add a `StoredFile` model
   (`id`, `tenantId`, `ownerUserId?`, `bucket`, `objectKey @unique`, `mimeType`,
   `byteSize`, `checksum`, `purpose` (LOGO/ATTACHMENT), `createdAt`,
   `deletedAt?`) and reference it from branding/attachments instead of raw URLs.
   _Decision required:_ external object store (Cloudinary/S3) vs Neon-hosted
   assets. Aligns with the spec's "private file metadata and document storage
   references".
2. **`Subscription.status` → enum** (`SubscriptionStatus`) instead of `String`,
   to stop typos and enable a proper state machine.
3. **Entitlements** — decide whether `Plan` carries feature limits. If yes, add
   `PlanFeature`/limits and enforce them at `authorizeTenant`. If no, state
   explicitly that plans are labels only (current behaviour).
4. **`TenantSettings`** — either populate with real settings or remove the model
   before it becomes load-bearing.
5. **Optional: `CustomerPortalMembership`** — a dedicated join (with its own
   status/expiry and audit) instead of overloading `Contact.portalUserId`, if
   portal access is to be granted/revoked independently of a contact record.

## 6. Known inconsistencies / debt

- `Subscription.status` is a `String` while all sibling statuses are enums.
- `TenantSettings` exists but holds nothing meaningful.
- `Tenant.planId` (label) and `Subscription.planId` (record) can diverge.
- Stale comments name Supabase for identity/storage (`schema.prisma` header,
  `User`, `TenantBranding.logoUrl`).
- `Contact.documents` is annotated "Future: document history" although a
  `Document.contactId` relation already exists.

## 7. Decisions requiring explicit owner approval

1. Object storage backend and whether a `StoredFile` metadata table is required.
2. Whether `Plan`/`Subscription` are billing-enforced or informational.
3. Whether portal access should be a first-class model or remain `Contact`-linked.
4. Whether `TenantSettings` is kept, populated, or dropped.
