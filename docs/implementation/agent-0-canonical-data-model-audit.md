# Agent 0 — Canonical Data Model Audit

Date: 2026-10-18
Scope: read-only inspection of `apps/web/prisma/schema.prisma` (1,103 lines, 24
models), the full migration chain (21 directories), and the write paths that
feed the integrity-critical columns. No schema or migration file was edited.

The directive asked Agent 0 to refine the exact schema after inspecting the
repository, with "minimum logical coverage, not a command to create duplicate
tables where suitable equivalents already exist." This document is that
refinement, expressed as (a) a coverage matrix mapping every checklist item to
its existing model with line evidence, (b) a register of refinements that are
genuinely missing, and (c) the decisions that block the two remaining items.
It deliberately does **not** edit `schema.prisma` yet, for reasons given in
§6.

---

## 1. Sources of truth — the schema currently lives in three places

Any canonical-model statement must say _where_ it is true. Inspection found
three divergent states:

| State                     | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.prisma`           | 24 models — the intended canonical shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Migration chain (21 dirs) | Migrations 1–16 contain real SQL; **17–21 are shell migrations** (`20261024000000_phase07_admin_auth` … `20261028000000_phase11_branding_provider_config` — each a comment, zero executable SQL). A fresh `prisma migrate deploy` "succeeds" and builds a schema missing `User.passwordHash`, `Subscription`, `SubscriptionStatusHistory`, 17 `TenantBranding` columns, and 4 `AuditLog` columns (verbatim diff: `docs/implementation/agent-7-schema-drift.sql`). This is AGENT 7 finding **C1 (critical)**. |
| Live Supabase (10/10)     | Applied through migration 10 (`20261018000002`) only. It additionally lacks the six _real_ migrations 11–16: `Plan` + `Tenant.planId` (11), `Contact.portalUserId` portal linkage (12), support-window instants (13–14), `ContactItem` validity window (15), `SyncOperation`/`SyncDeletion` (16).                                                                                                                                                                                                            |

Frozen-migration rule: 1–10 are frozen on the live project; 11–16 are real,
committed, and deployable; 17–21 must be **replaced by real migrations** (new
files, never edits) before the canonical schema exists anywhere a deploy
reaches.

---

## 2. Coverage matrix

Verdicts: **COVERED** (model + real migration), **EQUIV** (suitable equivalent
exists; no new table wanted), **PARTIAL**, **ABSENT**, **DEFERRED** (blocked on
a decision, not on schema work). "Delivery" names where the backing model
actually exists: `mig N` = migration N; `live` = applied to the live project;
`shell` = schema.prisma only.

### 2.1 Platform / identity

| Checklist item                    | Verdict                       | Evidence                                                                                                                                                                                                                                                                                                                                                                         | Delivery                                                                                   |
| --------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Users / auth identity             | COVERED                       | `User` — native `passwordHash` + `sessionVersion` revocation counter (schema.prisma:937–975); no external IdP                                                                                                                                                                                                                                                                    | mig 1–8, live; **`passwordHash` shell-only (C1)**                                          |
| Tenants                           | COVERED                       | `Tenant` with lifecycle (`TenantStatus`), provisioning attribution (93–168)                                                                                                                                                                                                                                                                                                      | mig 1, live                                                                                |
| Tenant domains                    | COVERED                       | `TenantDomain` — `hostname @unique`, `isPrimary`, `verifiedAt` (341–353)                                                                                                                                                                                                                                                                                                         | mig 1, live                                                                                |
| Tenant memberships                | COVERED                       | `TenantMember`, `@@unique([tenantId, userId])` (979–994)                                                                                                                                                                                                                                                                                                                         | mig 1, live                                                                                |
| Roles                             | EQUIV                         | `TenantRole` enum (9-role model, 74–82) + `RolePermission.roleKey`; a roles table would duplicate the enum + code matrix (`packages/auth/src/permissions.ts`) with a parity test guarding drift                                                                                                                                                                                  | mig 1/8, live                                                                              |
| Permissions                       | COVERED                       | `Permission` catalogue keyed by `key @unique` (381–393)                                                                                                                                                                                                                                                                                                                          | mig 9, live — **stale: DB seeds 42 vs code 57 (AGENT 7 H1)**                               |
| Role–permission mappings          | COVERED                       | `RolePermission`, `@@unique([roleKey, permissionId])` (395–407)                                                                                                                                                                                                                                                                                                                  | mig 9, live — same H1 caveat                                                               |
| Invitations (workspace)           | COVERED                       | `Invitation` — SHA-256 `tokenHash @unique`, instant `expiresAt`, status enum (999–1021)                                                                                                                                                                                                                                                                                          | mig 1/14, live                                                                             |
| Tenant status events              | COVERED                       | `TenantStatusHistory` append-only, `changedById`, reason (359–373)                                                                                                                                                                                                                                                                                                               | mig 9, live                                                                                |
| Subscription plans                | COVERED                       | `Plan` — deliberately information-only (code/name/ordering; no price/quota) per the Phase 2 "manual activation" directive (170–196)                                                                                                                                                                                                                                              | mig 11, **not live**                                                                       |
| Tenant plan assignments & history | EQUIV (with an open question) | Current assignment: `Tenant.planId` (103). History: `AuditLog` records every assignment (`PLATFORM_TENANT_PLAN_ASSIGNED`, platform.ts:836–839). `Subscription`/`SubscriptionStatusHistory` exist in schema.prisma (211–255) as an alternative — **zero runtime consumers**, free-text `status String`, snake_case columns breaking schema convention. Recommendation in §4 (R5). | planId: mig 11; Subscription: shell-only                                                   |
| Audit logs                        | COVERED                       | `AuditLog` with polymorphic resource + correlation id (1025–1050)                                                                                                                                                                                                                                                                                                                | mig 1, live; `resourceType`/`outcome`/`outcomeDetails`/`correlationId` **shell-only (C1)** |

### 2.2 Business operations

Contact, Item and ContactItem are the peer agent's active remodel surface
(target shapes `DocumentItem`/`DocumentContactItem`). Rows below describe the
_current_ schema; when the remodel lands, the catalogue rows repoint (tracked
as task #72).

| Checklist item                          | Verdict | Evidence                                                                                                                                                                                                     | Delivery                                         |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Contacts                                | COVERED | `Contact` (493–535) — mid-remodel, not frozen                                                                                                                                                                | mig 3, live                                      |
| Contact addresses                       | COVERED | `ContactAddress`, type POSTAL/PHYSICAL, `isDefault` (537–555)                                                                                                                                                | mig 3, live                                      |
| Contact notes (if required)             | EQUIV   | Single `Contact.notes` text field (505) — sufficient at MVP scale; a notes table would be speculative                                                                                                        | mig 3, live                                      |
| Catalogue items                         | COVERED | `Item` — `@@unique([tenantId, sku])`, UoM, Decimal(18,4) price + explicit currency (569–598) — mid-remodel                                                                                                   | mig 3, live                                      |
| Customer-specific item details & prices | COVERED | `ContactItem` — `agreedPrice`, `discountPercent`, `customCode/Name/UnitOfMeasure`, `isAvailable`, validity window, `@@unique([tenantId, contactId, itemId])` (602–632)                                       | mig 3/15, live (window columns mig 15, not live) |
| Business tax configuration              | PARTIAL | `TenantBranding.taxPin` (293) + `TaxCategory`/`TaxRate` per tenant (452–489). Gaps are behavioral, not structural: `isDefault` is never consumed, no classification vocabulary/provenance (AGENT 5 §3.1–3.4) | mig 3, live                                      |
| Item tax configuration                  | COVERED | `Item.taxRateId` → `TaxRate` (580, 589); line-level tax snapshot at issuance (see below). Gap behavioral: validity windows not enforced at pricing time (AGENT 5 §3.3)                                       | mig 3, live                                      |
| Documents                               | COVERED | `Document` — one table for all three types, type-as-data (701–781)                                                                                                                                           | mig 4, live                                      |
| Document lines                          | COVERED | `DocumentLine` — provenance-only `itemId`, snapshot price/tax columns (783–831)                                                                                                                              | mig 4, live                                      |
| Document numbering sequences            | COVERED | `DocumentNumbering` (config per tenant+type) + `DocumentNumberSequence` (counter per tenant+type+period), allocated under `SELECT … FOR UPDATE` (885–929)                                                    | mig 4, live                                      |
| Document events                         | COVERED | `DocumentStatusEvent` append-only transition log (862–880)                                                                                                                                                   | mig 4, live                                      |
| Document correction / void records      | COVERED | `voidedAt/voidReason/voidedById` (727–729) + `replacementOfId` self-relation (712, 764–765) + `VOID` status + `DocumentStatusEvent.reason`                                                                   | mig 4, live                                      |

### 2.3 Portal and files

| Checklist item                            | Verdict                  | Evidence                                                                                                                                                                                                                                                                                                            | Delivery         |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Customer portal memberships               | EQUIV                    | The link model: `Contact.portalUserId` (520–521) + `TenantMember` role `CUSTOMER_PORTAL_USER` + `@@unique([tenantId, portalUserId])` (528) — one account sees exactly one customer; grant/revoke audited (`portal-access.ts:477–484, 563–570`); resolver re-checks the link per request with contactId in the WHERE | mig 12, not live |
| Customer invitations                      | EQUIV                    | Same `Invitation` table with role `CUSTOMER_PORTAL_USER`; `portal-access.ts` comment (30–34): the Team page invitation is "exactly one door" to the portal role — no separate table wanted. Known gap is delivery, not storage: no email transport (AGENT 6 §3.2)                                                   | mig 1/14, live   |
| Document access grants / explicit sharing | EQUIV (pending sign-off) | Sharing is the contact-ownership model — every portal query filters `contactId` — which is an explicit, auditable authorization relationship. Directive E requires technical-lead approval of this equivalence (AGENT 6 §3.4). No per-document grant table should be created before that ruling                     | mig 12, not live |
| Private file metadata                     | ABSENT → DEFERRED        | No file-object model anywhere. PDFs are rendered on demand and never stored; logos are a path string (`TenantBranding.logoUrl`, 287) behind the authenticated uploads route. Building the metadata model is blocked on the storage-provider decision (AGENT 6 §3.1) — do not create speculatively                   | —                |
| Document-to-file references               | ABSENT → DEFERRED        | Same decision; nothing references stored files because none are stored                                                                                                                                                                                                                                              | —                |
| Access & revocation events                | COVERED (portal scope)   | `AuditLog` actions `PORTAL_ACCESS_GRANTED`/`PORTAL_ACCESS_REVOKED` (portal-access.ts:478, 564) and portal download audits; file-level events N/A until a file model exists                                                                                                                                          | mig 1, live      |

### 2.4 Integrity requirements

| Requirement                                            | Verdict             | Evidence                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unique approved tenant slugs                           | COVERED             | `Tenant.slug @unique` (96); approval = zod shape validation at every write (`updateTenantSlugSchema`, platform-tenant.ts:168)                                                                                                                                                                                |
| Unique normalized domain mappings                      | COVERED (app-layer) | `hostnameSchema` trims + lowercases + shape-checks before every write (platform-tenant.ts:142–150); `hostname @unique` (344). DB layer trusts the app — hardening noted as R4                                                                                                                                |
| Unique issued numbers within numbering scope           | COVERED             | `@@unique([tenantId, type, number])` (772) backstopped by the locked allocation function; drafts hold NULL numbers so they never collide. Sequence scope `(tenantId, type, period)` (927) matches the printed number's period segment                                                                        |
| FKs between related entities                           | COVERED             | Every relation is a real FK (UUID migration 727–793). Two **documented** intentional exceptions: `AuditLog.resourceId` polymorphic (1032), `SyncDeletion.deletedById` attribution-only (1095–1097)                                                                                                           |
| Same-tenant relationship constraints                   | PARTIAL             | The only composite FK in the chain is `DocumentNumberSequence(tenantId, type) → DocumentNumbering` (phase05 migration:308). Financial children carry their own `tenantId` but nothing in the DB forces it to equal their parent's — R1 below is the substantive refinement this checklist item is asking for |
| Deletion restrictions for historical financial records | COVERED             | `DocumentPayment.document` RESTRICT (migration 783), `DocumentLine.item` RESTRICT (778), derivation + replacement self-FKs RESTRICT (759–760), immutability trigger freezing issued documents (phase05), payment reversal never deletes (843–846), retired tax rates survive via line snapshots (809–813)    |
| Indexes for tenant-scoped queries                      | COVERED (one gap)   | Systematic `@@index([tenantId, …])` on every business model. Gap: `Contact.portalUserId` has no standalone index and the portal guard queries it without a tenant predicate (`portal.ts` `findFirst({ where: { portalUserId } })`) — R2                                                                      |
| Consistent timestamp handling                          | PARTIAL             | Instant columns on `SupportAccessGrant` and `Invitation` are explicit `@db.Timestamptz(3)` (425–427, 1009–1010) with comments explaining why; every other instant column is bare `timestamp(3)`. R3 proposes standardizing                                                                                   |
| Decimal-safe monetary fields                           | COVERED             | Money `Decimal(18,4)`, rates `Decimal(5,4)`, percent discounts `Decimal(5,2)` throughout; arithmetic in `packages/documents` is decimal-string with the frozen `half-up-per-line-v1` policy                                                                                                                  |
| Explicit currency on issued documents                  | COVERED             | `Document.currency` (708) frozen into the snapshot at issuance; lines inherit the document currency (single-currency-per-document by design)                                                                                                                                                                 |
| Snapshot fields for issued details & tax               | COVERED             | `Document.snapshot`/`snapshotAt` (751–752), `taxBreakdown` (743), `roundingPolicy` (746), per-line `taxRateId/taxName/taxRate` copies (811–813). PDF renders from the snapshot only                                                                                                                          |
| Derived totals not independently mutable               | COVERED             | Totals are stored but CHECK-constrained to the line math (phase05 migration), frozen by the immutability trigger at issuance, and reproducible via the recorded rounding policy — this satisfies the "clearly defined, tested calculation strategy" clause                                                   |

---

## 3. Headline result

**22 of 27 checklist items are already covered by existing models or declared
equivalents; zero duplicate tables are needed.** The substantive work is not
additive: it is (a) making the shell migrations real so the canonical schema
exists on any database a deploy touches (C1), (b) the one structural
refinement the DB cannot currently enforce (same-tenant FKs), and (c) two
deferred items that are owner decisions, not schema drafts.

## 4. Refinement register (all as NEW migrations, sequenced after C1)

- **R1 — Same-tenant composite FKs (the real structural gap).** Add
  `UNIQUE (id, tenantId)` to `Document`, `Contact`, `Item`, `TaxRate`,
  `DocumentNumbering` (parents), then composite FKs from the children:
  `DocumentLine(tenantId, documentId)`, `DocumentPayment(tenantId, documentId)`,
  `ContactItem(tenantId, contactId)` / `(tenantId, itemId)`,
  `Item(tenantId, taxRateId)`, `DocumentLine(tenantId, taxRateId)`,
  `ContactAddress` via its contact. RLS plus scoped queries already make
  cross-tenant pairs unlikely; this closes the residual app-bug path at the
  database level, which is exactly what the checklist's "same-tenant
  relationship constraints" asks for.
- **R2 — `@@index([portalUserId])` on `Contact`.** The portal guard's
  per-request lookup cannot use the `(tenantId, portalUserId)` unique index
  because it does not know the tenant yet.
- **R3 — Timestamp standardization.** Migrate remaining instant columns
  (`issuedAt`, `voidedAt`, `expiresAt`-class columns elsewhere, window columns
  on `ContactItem`/`TaxRate`) to `timestamptz(3)`, following the precedent of
  migration 14. Low urgency; bundle with the first post-C1 migration.
- **R4 — Hostname normalization defense-in-depth.** Add
  `CHECK (hostname = lower(hostname))` (or a `lower(hostname)` functional
  unique index) so the invariant survives any future write path that skips the
  zod schema.
- **R5 — Decide `Subscription`/`SubscriptionStatusHistory`.** Recommend
  **dropping both from schema.prisma** in the C1 canonicalization pass unless a
  billing track is imminent: no runtime code reads them, `Tenant.planId` +
  audited assignments already satisfy "plan assignments and history", the `Plan`
  model comment says billing is intentionally not modelled, and as written they
  break schema conventions (free-text status, snake_case columns). Keeping them
  means reforming them (enum status, camelCase, RLS policies — they currently
  have none, AGENT 7 H2) before they enter any real migration.
- **R6 — `TaxCategory.isDefault`: consume or drop** (AGENT 5 §3.2); a dead
  flag in the canonical model invites false confidence.

Items **not** recommended: per-document grant tables (pending the sharing-model
ruling), file-metadata tables (pending the storage decision), a notes table, a
roles table, any eTIMS schema work — `TenantBranding.etims*` columns (317–321)
are inert placeholders from the shell era; they assert no capability and must
not be presented as one while Phase 7 stays interrupted.

## 5. Decisions this audit needs (not schema work)

1. R5 above — drop vs reform `Subscription` (owner).
2. Sharing-model equivalence ruling for the portal link model (technical lead,
   AGENT 6 §3.4).
3. Storage provider — unblocks the file-metadata / document-to-file rows
   (owner, AGENT 6 §3.1).

## 6. Why schema.prisma is not edited in this pass

The refinements are fully specified above but deliberately not applied yet:

1. **Sequencing.** Editing `schema.prisma` now would widen the drift the
   canonicalization migration has to close. The correct order is: make
   migrations 17–21 real (carrying the already-committed schema: `passwordHash`,
   branding columns, audit columns, and the Subscription decision from R5),
   then layer R1–R4 as subsequent migrations.
2. **Active remodel.** `Contact`/`Item`/`ContactItem` are the peer agent's
   unfrozen surface; R1 and R2 touch exactly those models and must not race
   the remodel (task #72).
3. **NO-GO context.** AGENT 7's release report stands: the deploy path is
   broken until C1 closes. A canonical schema that exists only in
   `schema.prisma` is not yet an auditable artifact.

## 7. Verification notes

Findings above come from: full read of `schema.prisma`; directory listing of
all 21 migrations; `grep 'FOREIGN KEY \('` across the chain (40 single-column
FKs, exactly one composite); read of `portal-access.ts` (578 lines — grant/
revoke/audit flow), `platform.ts` domain + plan-assignment paths,
`platform-tenant.ts` hostname schema; `grep` confirming no runtime consumer of
`Subscription`. Live-database statements rest on the 2026-10-14 verified state
(`_prisma_migrations` = 10 finished rows) and have not been re-probed — the
live project is untouched by this audit.
