# AGENT 02 — CRM, Sales & Commerce: Design Spec

Status: DESIGN LOCKED 2026-10-18 at HEAD `d79c520` (owner all-clear: full AGENT 02 including Contact/Item/Document work; schema ownership held for this window).
Basis: full seam inspection (schema 505–947, `packages/documents`, `src/server/services/documents/*`, `src/server/actions/*`, RLS migrations, sync layer, portal, tests).

## 0. Governing decisions

- **Orders are `Document` rows of a new type `ORDER` — not a new entity.** The existing engine (lines, discounts, tax snapshots, `half-up-per-line-v1` rounding, numbering via `allocate_document_number()`, frozen `snapshot` on issue, derived payment statuses, append-only `DocumentStatusEvent`, idempotency keys, immutability triggers) is exactly what module D demands; duplicating it as an `Order` table would fork every guarantee. Extend the type, never the machinery.
- **Quotation → order → invoice/delivery** reuses `sourceDocumentId` derivation: acceptance converts a QUOTATION to a DRAFT ORDER (`convertQuotationToOrder` mirrors `convertQuotationToInvoice`); an ORDER issues INVOICEs and DELIVERY_NOTEs against it. The `one_invoice_per_source` partial index stays for quotation-sourced invoices; order-sourced invoices are one per order too (same index shape, extended).
- **"Paid" is derived, never clicked.** ORDER payment state uses the same `deriveInvoiceStatus` (DRAFT→ISSUED→PARTIALLY_PAID/PAID/OVERDUE transitions). A refund is `DocumentPayment.reversedAt` (append-only reversal, already the verified pattern) — no invented REFUNDED status; the UI labels "refunded balance" from reversal data. Cancellation of an unfulfilled order = CANCELLED transition with reason; VOID reserved for issued-order correction path like invoices.
- **Inventory is OUT of approved scope → documented boundary, no fake stock.** No `StockLevel` table, no availability numbers anywhere. Products/pages show price + "Request a quote" capture; fulfilment truth is DELIVERY_NOTE lines (`deliveredQuantity` accumulation on source lines, existing verified mechanism). This is recorded in §7 and in the final report.
- **Tenant resolution for public surfaces never uses paths.** `/s/[token]` is a *resource* route, not tenant routing: the token resolves a `ShareLink` row server-side, which carries the `tenantId`. The approved subdomain model (middleware `x-tenant-subdomain`, reserved-subdomain 404) remains the only tenant-addressing scheme for the app itself.
- **Public unauthenticated data access goes through SECURITY DEFINER functions** (`app_public_*`, following the `app_find_user_id_by_email` precedent), each returning a minimized `jsonb` payload and enforcing tenant isolation inside the function. No RLS context exists for anonymous readers; nothing anonymous may read raw tables.
- **Marketing campaigns are AGENT 04 territory.** This phase carries campaign *data plumbing only*: UTM strings on `ShareLink`/`Lead` and `Contact.sourceCampaign` text. No Campaign table.
- **No cron/reminder jobs.** Lead "overdue" and task "due" are computed from timestamps at read time; nothing is claimed to be sent.
- **Never automatic dedupe.** Duplicate detection scores candidates (exact normalized email/phone = strong; name-only = ambiguous) and returns them for human review; merge is an explicit two-step (preview → apply) action.

## 1. Data model (migration 24: `20261031000000_agent02_crm_commerce`)

Single forward migration. All new tenant tables: `ENABLE ROW LEVEL SECURITY`, the 4-policy DO-loop (`app_read/insert/update/delete_<T>` with `has_tenant_read_access`/`has_tenant_write_access`), explicit `GRANT` (default privileges no longer exist), append to the anon/authenticated revoke list successor. FORCE RLS is not used anywhere (owner-bypass acknowledged — `amisibiz_app` connection remains the owner-gated deployment item).

### 1.1 New enums

`LeadSource { WEB_FORM, REFERRAL, SOCIAL, CAMPAIGN, WALK_IN, PHONE, EMAIL, IMPORT, OTHER }`; `LeadStatus { NEW, CONTACTED, QUALIFIED, CONVERTED, LOST }` (CONVERTED/LOST terminal); `LeadPriority { LOW, MEDIUM, HIGH }`; `Contact.source` reuses the `LeadSource` enum (same capture-channel vocabulary for leads and customers); `ContactChannel { PHONE, WHATSAPP, SMS, EMAIL, PORTAL, OTHER }`; `TaskPriority = LeadPriority` (shared enum); `ShareLinkKind { PRODUCT, LEAD_FORM, ORDER_STATUS }`; `ActivityEventType` is a **String** (open vocabulary, e.g. `LEAD_CREATED`, `ORDER_CREATED`, `MERGE_APPLIED`), NOT an enum, so future agents don't migrate enums for every event.

### 1.2 Contact extensions (additive columns)

`source LeadSource?`, `sourceDetail String?`, `sourceCampaign String?` (UTM campaign text), `preferredChannel ContactChannel?`, `marketingConsent Boolean @default(false)`, `marketingConsentAt DateTime?`, `supersededById String?` (self FK, `onDelete: SetNull`, merge survivor pointer) + index. Tags: new `Tag` (tenantId, name; `@@unique([tenantId, lower(name)])` via functional unique on a generated/lowered index) + `ContactTag` (contactId, tagId, `@@unique([contactId, tagId])`). Contact is sync-exposed → already has `revision` + bump trigger; new columns ride along (pull already selects changed rows by revision; registry field whitelists must be extended — see §5.6).

### 1.3 Catalogue (Item extensions + new tables)

- `ItemStatus` gains `ARCHIVED` (ALTER TYPE + CHECK unchanged since column is the enum).
- `CatalogueCategory` (tenantId, name, parentId self-FK SetNull, `@@unique([tenantId, name])`) + `Item.categoryId` FK SetNull.
- `ItemImage` (tenantId, itemId, position, blobUrl, alt, `@@unique([tenantId, itemId, position])`); images stored through the owner's Vercel Blob seam (`lib/logo-storage.ts` pattern, `BLOB_READ_WRITE_TOKEN` fail-closed); no fake storage.
- `ProductVariant` (tenantId, itemId, name, sku?, unitPrice Decimal(18,4), currency default KES, taxRateId? SetNull, status ACTIVE/INACTIVE, position); `@@unique([tenantId, sku])` when sku set (partial unique). `DocumentLine.variantId?` provenance FK Restrict (snapshot columns remain the print authority).

### 1.4 Leads & pipeline

- `Pipeline` (tenantId, name, isDefault, archivedAt) — one default per tenant enforced by partial unique `(tenantId) WHERE isDefault AND archivedAt IS NULL`.
- `PipelineStage` (pipelineId, tenantId, name, position, isWin, isLost) — position unique per pipeline; win/loss terminal markers for metrics.
- `Lead` (tenantId, status, priority default MEDIUM, pipelineStageId? SetNull, assignedToUserId? SetNull, firstName/lastName/companyName/email/phone, description, currency, estimatedValue Decimal(18,4)?, source LeadSource, sourceDetail?, utmSource/utmMedium/utmCampaign?, contactId? SetNull (existing-customer link), lostReason?, lostAt?, convertedAt?, convertedContactId?, convertedDocumentId? (the quotation/order conversion produced), idempotencyKey?, externalId?, revision Int + bump trigger). Constraints: `@@unique([tenantId, idempotencyKey])` (partial, when non-null), `@@unique([tenantId, source, externalId])` (partial) — this is the "prevent duplicate leads from retries" rule; indexes on (tenantId,status), (tenantId,createdAt), (tenantId,email), (tenantId,phone).
- Every stage change appends an ActivityEvent; conversion reparents: create-or-reuse Contact (never silent: the action returns detected duplicates and the operator picks), Lead→CONVERTED, optional DRAFT QUOTATION or ORDER created in the same transaction under `documents.*`/`documents.order.*` permissions.

### 1.5 Tasks

`Task` (tenantId, title, notes?, dueAt?, completedAt?, priority, assigneeId? SetNull, leadId? SetNull, contactId? SetNull, documentId? SetNull, revision + bump trigger). CHECK: at least one of leadId/contactId/documentId required (a task always belongs to something). Overdue = `dueAt < now AND completedAt IS NULL` computed at read.

### 1.6 Unified activity timeline (module F)

`ActivityEvent` (tenantId, eventType String, occurredAt default now, actorId? SetNull, leadId?, contactId?, documentId?, taskId?, shareLinkId? — all SetNull FKs; payload Json?; `source String?` + `sourceKey String?` for retry-dedup with `@@unique([tenantId, source, sourceKey])` partial). Append-only: SELECT+INSERT grants only; BEFORE UPDATE/DELETE raise trigger mirroring `document_status_event_is_append_only`. Timeline queries union by participant (contact 360 = contact + its leads + documents + tasks + events referencing them) — the table itself is the unified record; writes happen in exactly one place per mutation path (§5 services), so no duplicates on retry by construction + sourceKey uniqueness.

### 1.7 Share links (modules C/E)

`ShareLink` (tenantId, kind, token `@@unique` (26-char base62, `gen` server-side, never client-supplied), itemId? SetNull, documentId? SetNull, active default true, expiresAt?, message?, utmSource/utmMedium/utmCampaign, createdAt/updatedAt; partial uniques per kind: (tenantId,itemId) WHERE PRODUCT AND active, (tenantId,documentId) WHERE ORDER_STATUS AND active). `viewCount Int @default(0)` bumped by the public resolver function (retry double-count tolerated and documented — no client-supplied attribution).

### 1.8 Document/ORDER extension

- `ALTER TYPE "DocumentType" ADD VALUE 'ORDER'`; no new `DocumentStatus` values needed (ORDER uses DRAFT, ISSUED, PARTIALLY_PAID, PAID, OVERDUE, CANCELLED, VOID — all pre-existing enum labels).
- Drop + recreate `document_status_matches_type` CHECK: ORDER ∈ {DRAFT, ISSUED, PARTIALLY_PAID, PAID, OVERDUE, CANCELLED, VOID}. `document_void_only_applies_to_invoices` becomes void-applies-to {INVOICE, ORDER}.
- Source-document CHECK: DELIVERY_NOTE source ∈ {INVOICE, ORDER}; INVOICE source ∈ {QUOTATION, ORDER}; QUOTATION source NULL. Extend `document_one_invoice_per_source` to `document_one_derived_invoice_per_source` same shape (still one invoice per source, any source kind).
- `allocate_document_number` / `peek_document_number` / `document_number_period`: add `ORDER` prefix default case (mirror existing `CASE p_type`). `DocumentNumbering` rows remain per (tenant,type), lazily defaulted — no backfill needed.
- Lifecycle `packages/documents/src/lifecycle.ts` TRANSITIONS add ORDER: DRAFT→[ISSUED]; ISSUED→[PARTIALLY_PAID, PAID, OVERDUE, CANCELLED, VOID]; PARTIALLY_PAID→[PAID, OVERDUE, ISSUED, CANCELLED, VOID]; PAID→[PARTIALLY_PAID, VOID]; OVERDUE→[PARTIALLY_PAID, PAID, VOID]; OVERDUE/… terminal CANCELLED/VOID. `series.ts` DOCUMENT_TYPES + DEFAULT_DOCUMENT_SERIES; `numbering.ts` DEFAULT_DOCUMENT_NUMBERING (compiler-forced); `pdf-writer.ts` per-type heading/layout for ORDER (no "tax invoice" claims — constitution).

### 1.9 Permission catalog delta (57 → 74)

`documents.order.create/update_draft/issue/void` (`documents.order.*`), `leads.read/create/update/delete/convert`, `pipelines.read/manage`, `tasks.read/manage`, `activities.read`, `share_links.read/manage`, `data.import` = 17 new keys, total 74. Matrix additions (exact, asserted in-migration): OWNER/ADMIN all 17; SALES 14 = leads×5, pipelines.read, tasks×2, activities.read, share_links×2, orders create/update_draft/issue (no void); FINANCE 6 = leads.read, tasks.read, activities.read, orders.create, orders.issue, orders.void; OPERATIONS 7 = leads.read, tasks×2, activities.read, share_links.read, orders.create, orders.update_draft; VIEWER 5 = leads.read, pipelines.read, tasks.read, activities.read, share_links.read; PORTAL/SUPPORT/SUPER_ADMIN 0 new. Migration 24 upserts the 17 keys + rows with exact-count asserts (idempotent `ON CONFLICT DO NOTHING` pattern from migration 23). CI's hardcoded 42→ becomes 74 — still owner-gated, flagged again.

## 2. Server layer (Phase 2) — files & functions

Conventions (verified): `authorizeTenant(userId, tenantId, PERMISSIONS.X)` → `TenantAuthzContext` + `enterScope`; actions return `ActionResult`, never throw; `authorizationFailure`/`invalidInput` from `_shared.ts`; payloads Zod-validated, any `id/tenantId/status/revision` stripped from create payloads; trusted `rowId` via options arg.

- `services/leads/{service.ts,conversion.ts,dedupe.ts}`: createLead (idempotency first, dup candidates scored, ActivityEvent LEAD_CREATED), updateLead/stage move/assign/lose, `convertLead` (contact reuse-or-create, optional DRAFT quotation/order, atomic tx), `findDuplicateLeads`.
- `services/pipeline/service.ts`: pipeline+stage CRUD; delete guarded when leads reference stages (Restrict).
- `services/tasks/service.ts`: create/update/complete/reopen (ActivityEvent per mutation).
- `services/activities/service.ts`: `appendActivity(authz, input)` single writer + `getTimeline(authz, {contactId?|leadId?}, cursor)` unified read.
- `services/contacts/{merge.ts,import.ts}`: `previewContactMerge(authz,{losers[],survivor})` returns a full reparent plan + conflicts; `applyContactMerge` executes it in one tx — reparents Lead/Document/ContactItem/Address/Task/ShareLink refs, sets `supersededById`+ARCHIVED on losers (never hard delete), writes ActivityEvent MERGE_APPLIED with sourceKey (retry-safe). Import: parse → Zod per-row → preview (valid/invalid/duplicate-flagged) → commit-on-confirm (rows created via `createContactAction` path so auth/audit run once).
- `services/catalogue/service.ts`: category/variant/image CRUD, item ARCHIVE/RESTORE, image upload through Blob seam (`requireBlobToken` fail-closed; no token → honest error, never silent local writes).
- `services/share/service.ts`: create/revoke/list ShareLink; token gen (`crypto.randomBytes` base62 ≥24); public resolvers call new SECURITY DEFINER functions `app_public_share_link_resolve(token)`, `app_public_product_view(token)`, `app_public_order_status(token)`, `app_public_lead_capture(jsonb)` (validates inside; returns `{leadId, duplicateSuspects[]}`; idempotency honored; writes ActivityEvent with sourceKey = idempotencyKey).
- `services/documents/service.ts` additions: `convertQuotationToOrder`, order issue (uses existing issueDocument for type ORDER), `createInvoiceFromOrder`, `createDeliveryNoteFromDocument` already generalized once CHECK allows ORDER source; `recordPayment`/`reversePayment` reused unchanged (derivation identical for ORDER).
- Actions: `lead.ts`, `pipeline.ts`, `task.ts`, `activity.ts`, `share-link.ts`, `contact-merge.ts` (+ extend `contact.ts` with import/export/merge actions, `item.ts` with archive/variant/category/image actions, `document.ts` with ORDER entries in the three permission maps + convertOrder/invoiceFromOrder actions). API: `app/api/public/share/[token]/route.ts` (GET resolve), `app/api/public/leads/route.ts` (POST capture), portal PDF route pattern unchanged; new `app/api/orders/[documentId]/pdf` reuses the generic document PDF route (type-agnostic already).

## 3. UI (Phase 3, English primary)

Pattern (verified): async server page → `getWorkspaceState(locale, PERMISSIONS.X)` → props → co-located `*-client.tsx`. Locale routing stays `[locale]`; public share pages live at `/s/[token]` **outside** `[locale]` (no tenant in path; content English + next-intl fallback) — decision recorded: public commerce pages are not tenant-app routes.

Tenant app: `/app/leads` (pipeline kanban board + list fallback, new-lead form, conversion dialog with duplicate review), `/app/leads/[id]` (lead 360 + tasks + timeline), `/app/contacts/[id]` extended to customer-360 (profile chips: tags/source/consent/preferred channel; unified timeline; merge entry point with preview dialog; import/export panel with validation preview table), `/app/items` extended (category filter+tree, archive/restore, variants + images uploader), `/app/items/[id]` product detail + share-link manager, `/app/documents` extended for ORDER (new/create/edit/issue same shells, type-aware labels), order detail adds payments panel (record/reverse reuse), `/app/settings/pipelines` (pipeline/stage editor). Portal: existing document list shows ORDER automatically; add per-order status view. Public: `/s/[token]` product page (name, images, variants with explicit currency, "Request a quote" form — accessible labels, error summaries, mobile-first), LEAD_FORM page (capture form), ORDER_STATUS page (number, status, currency+total, delivery progress from derived data; nothing else).

## 4. Currency & pricing rules (module D/F invariants)

Currency explicit on every price surface (Lead.currency default from TenantSettings? — no hidden default: forms require selection, items/variants carry their own); documents refuse mixed-currency lines? Existing engine already keys totals per document currency with minor-unit 4dp decimals and `half-up-per-line-v1` recorded per document; ORDER inherits unchanged. Historical integrity: snapshot columns + immutability triggers already cover ORDER (verified constraint family) — tests re-prove for the new type rather than trusting it.

## 5. Offline/sync posture

`SUPPORTED_SYNC_ENTITIES` stays `contact, item, customer_price` this pass. Lead/Task carry `revision`+trigger so they *can* be added without another schema pass; adding them to the registry is the natural follow-up (push handlers must re-key into the same actions). Contact registry field whitelist must include the new columns or offline clients silently drop them — extend `registry.ts` select field lists in Phase 2 (small, tested).

## 6. Test matrix (10 required areas → files)

1. Enquiry→order journey: `agent02-commerce-journey.test.ts` (share link → capture → lead → convert → quotation → order → issue → payment recorded → invoice/delivery derived; state machine rejects skips).
2. Lead conversion & duplicates: `agent02-leads.test.ts` (idempotent capture, dedupe scoring, merge preview/apply, ambiguous-match never auto-merges).
3. Pricing/discounts/tax on orders: extend `phase04-customer-pricing`-style cases onto ORDER via `agent02-commerce-journey` + package calc parity.
4. Currency validation: forms + engine reject missing/mismatched currency (`agent02-leads`/journey cases).
5. Historical order integrity: post-issue mutation refused, snapshot authority, reversal recomputes derived status (journey file; mirror of phase05 immutability proofs).
6. Tenant isolation: dynamic RLS table test auto-covers new tables; + explicit forged-tenantId action cases + public-function cross-tenant cases (`agent02-isolation.test.ts`).
7. Role permissions: matrix parity test (dynamic), per-role refusal cases incl. VIEWER writes, SUPPORT none.
8. Invalid/repeated payment events: duplicate record idempotency, overpayment rejected by CHECK family (existing), reversal → derived status back, payment button click ≠ paid (`agent02-payments.test.ts`).
9. Product link security: token entropy/expiry/revocation, viewCount only via function, payload minimization assertions, guessing attacks return 404 (`agent02-sharelinks.test.ts`).
10. Mobile + a11y forms: RTL render of public capture + lead forms asserting labels, `aria-invalid`, error summary, single-column layout classes (`agent02-ui.test.tsx` if harness exists, else component-level honest partial + documented gap).

Harness convention: `tests/auth-mock.ts` + `prisma-mock.ts`; RLS proofs stay in `integration-security.test.ts` (skipped without TEST_DATABASE_URL). Offline throwaway-cluster verification of migration 24: `pg_ctl -p 55499`, `migrate deploy` full 24-chain, `migrate diff` datamodel vs fresh DB empty, ORDER CHECK/lifecycle spot probes. No live Neon apply without owner go.

## 7. Integration boundaries (stated, not pretended)

Inventory: none — availability language limited to "Request a quote"; delivery truth = DELIVERY_NOTE. Payments: no gateway, no webhooks; "verified payment status" = staff-recorded `DocumentPayment` with reference (constitution: never fabricate confirmation); capture API marks leads NEW — nothing auto-confirmed. Email/SMS to leads: Mailtrap seam exists for auth mail only; lead notifications NOT claimed this phase. Storage: images ride Vercel Blob seam, fail-closed without `BLOB_READ_WRITE_TOKEN`. Rate limiting/abuse on public capture: documented open gap (no edge limiter exists). Campaign attribution: UTM strings only; campaign entities = AGENT 04.

## 8. Execution order

Phase 1 (task #102) migration 24 + schema.prisma + packages/documents type extension + permissions.ts/matrix + migration 24 offline verification. Phase 2 (#103) services/actions/API per §2. Phase 3 (#104) UI per §3. Phase 4 (#105) tests §6 + full gates + `agent-02-crm-commerce-report.md`. Gates each phase: format (owner's 4 in-flight files stay untouched/failing), type-check, lint, test:run, build, check:bundles, audit. Live DB items (migration 23+24 apply, CI count 42→74, APP_DATABASE_URL) remain owner-gated and re-listed in the report.
