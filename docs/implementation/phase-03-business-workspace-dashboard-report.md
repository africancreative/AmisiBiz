# Phase 03 brief — business workspace dashboard, CRM, items and customer catalogue

- **Date:** 2026-10-15
- **Brief:** the owner's **PHASE 3: BUSINESS WORKSPACE, CRM AND ITEMS** directive —
  tenant dashboard, CRM contacts, a manually managed item catalogue, the
  customer-specific catalogue, line-snapshot data integrity, offline repository
  ports, tests and documentation.
- **Naming:** the checklist slot is **Phase 03 brief** (`phase-checklist.md`),
  deliberately distinct from "Phase 03 — Tenant lifecycle". The CRM, item and
  customer-catalogue surfaces were built inside Phase 04; this report records that
  body of work plus the small Phase-3 delta added here (customer unit and validity
  window). It is the file the checklist entry references.
- **Status word:** a **build-and-verify record, not a completion claim.** Every
  gate number below was produced on this tree with the command quoted in §7. The
  behavioural tests exercise the application layer against a mock Prisma client;
  nothing here is a claim about the live Supabase project.
- **Standing security context, unchanged by this phase:** RLS is still **inert in
  the deployed app**. The controls that actually hold are the application-layer
  authorization checks and tenant-pinned `WHERE` clauses; the database foreign
  keys and the `catalogue_assignment_is_single_tenant()` trigger are the
  defence-in-depth that activates with RLS.

---

## 1. What the brief asked, and where it lives

| Brief clause                                                                                                   | Where it lives                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Dashboard: overview, recent documents, outstanding, counts                                                     | `getDashboardOverviewAction`, `/[locale]/app`                                              |
| Quick document creation, account status/branding, empty states                                                 | `/[locale]/app` overview + `/[locale]/app/settings/branding`                               |
| CRM contacts: person/business, type, phone/email, address, KRA PIN, notes, archive, timestamps                 | `Contact`/`ContactAddress` models, `contact` actions, `/[locale]/app/contacts`             |
| CRM: search, pagination, create/view/edit/archive                                                              | `getContactsAction` query + `contact-dialog`/`contact-detail-client`                       |
| Notes hidden from portal users                                                                                 | portal resolver selects `{ id }` only (`server/services/documents/portal.ts`)              |
| Items: SKU/code, name/description, unit, price, currency, tax category, active/archive                         | `Item` model, `item` actions, `/[locale]/app/items`                                        |
| Exact monetary arithmetic + domain & server validation                                                         | `@amisibiz/documents/decimal`, `moneySchema`, `lib/validations/item.ts`                    |
| Customer catalogue: code, description, price, discount, unit, validity                                         | `ContactItem` model + `lib/validations/contact-item.ts` + `contact-item-dialog`            |
| Single-tenant relationship, FK + authorization                                                                 | FK pair + `catalogue_assignment_is_single_tenant()` trigger + action re-authorization      |
| Line snapshot: copy item details, never recompute old docs                                                     | `buildDocumentLineSnapshot` (`@amisibiz/documents`) + the frozen columns on `DocumentLine` |
| Repository ports for future SQLite offline operation                                                           | `@amisibiz/domain/repositories` (`Contact`/`Item`/`ContactItem`)                           |
| Tests: cross-tenant, required, invalid prices, catalogue integrity, permissions, search, pagination, archiving | `tests/phase04-security.test.ts`, `tests/phase03-dashboard-catalogue.test.ts`              |
| Documentation                                                                                                  | this report; `phase-checklist.md` §"Phase 03 brief"                                        |

---

## 2. The dashboard

`getDashboardOverviewAction` is tenant-scoped and authorized under
`documents.read`. It returns grouped counts (contacts by status, items by
type/status, documents by type/status), a recent-documents feed, and the
outstanding-invoice figure as an **exact decimal string** — never a float. The
overview page renders stat cards, the recent feed, the outstanding card, the
account/branding card, quick actions and explicit empty states, with en/fr/sw
catalogues.

Outstanding is defined as **invoiced-not-yet-settled**. Payment netting (partial
payments) landed with the Phase 05 document engine; the dashboard figure is the
sum of invoice totals minus recorded payments, computed in the shared decimal
layer.

---

## 3. CRM and items

Contacts carry business or person identity, a type, phone/mobile/email, one or
more addresses, an optional KRA PIN (`taxPin`), internal `notes`, archive status
and timestamps. Items carry a type (product/service), an optional SKU unique per
tenant, a unit of measure, an exact-decimal unit price, a currency (KES), a
configurable tax category (`taxRateId`) and active/archive status.

Both modules expose search, pagination, create, view, edit and archive through
typed Server Actions that re-authorize on every call and pin every query to the
caller's tenant.

**Portal isolation.** The customer portal resolves a document by matching the
signed-in identity to a `Contact`, selecting **only the contact `id`**. No
contact `notes`, `taxPin` or other internal field is reachable from a portal
route, so internal notes are not exposed to customer portal users.

---

## 4. Customer-specific catalogue and the Phase-3 delta

`ContactItem` links one contact and one item **within the same tenant**. The
brief's full term list is code, description, price, discount, unit and validity
dates. The first four arrived with Phase 04; this session added the last two:

- `customUnitOfMeasure` — a customer-specific unit of measure.
- `validFrom` / `validUntil` — the agreement's validity window, either bound open.

The window is **inclusive at both ends**, a one-sided window is valid, and an
absent window never expires. The rule is enforced in three places:

1. **Validation** — `createContactItemSchema` / `updateContactItemSchema` reject
   an inverted pair; `contactItemFormSchema` mirrors it for the dialog. An update
   that changes only one bound is checked against the stored value in the action,
   which the schema alone cannot see.
2. **Action** — the create/update Server Actions write the fields through an
   explicit allow-list mapper; the identity (tenant/contact/item) is
   structurally unreachable from an update payload.
3. **Store** — the migration adds a `ContactItem_validity_window_check` CHECK so
   an inverted pair cannot be persisted even if the application layer is bypassed.

**Single-tenant integrity** is unchanged and still guarded three ways: the
foreign-key pair, the `catalogue_assignment_is_single_tenant()` trigger, and the
action re-authorizing the contact and item before the write.

### Migration

`apps/web/prisma/migrations/20261022000000_phase03_contact_item_units_and_validity/migration.sql`
adds the three nullable columns and the CHECK constraint. Every column is
nullable, so existing rows keep their meaning and no document is rewritten. Like
the Phase 05 portal-linkage migration, it is **authored and Prisma-client
regenerated, but not applied to the live project** (owner-gated).

---

## 5. Line-snapshot data integrity

The rule the brief states — _copy item details and price into the document line;
do not recompute old documents from the current catalogue_ — is implemented as a
**pure function** and as frozen columns:

- `buildDocumentLineSnapshot` (`packages/documents/src/catalogue-line.ts`) copies
  the item's description, code, unit and price and applies a customer override
  only when it exists, is available **and is in force on the line's date**. An
  unavailable or out-of-window agreement falls back to the catalogue; the chosen
  source is reported in `priceSource`. All arithmetic is exact decimal-string.
- The Phase 05 line service validates item/tax ownership and freezes the copied
  columns onto `DocumentLine` inside the draft-write transaction. `DocumentLine.itemId`
  is provenance only — the printed line never reads the live catalogue.

This session extended the override so the two new customer terms participate:
`customUnitOfMeasure` is copied onto the line, and a bounded agreement is applied
only inside its window (and never when no date is supplied to verify it).

---

## 6. Offline repository ports

`@amisibiz/domain/repositories` defines contract-only ports for `Contact`,
`Item` and `ContactItem` with their query/record shapes. `ContactItem.upsert`
carries `tenantId` so the server can re-check it on replay, and the port
documents that an offline adapter must apply the same single-tenant rule locally.
The Phase 03 test suite ships a **non-Prisma, in-memory implementation of all
three ports**, which proves the seam is real rather than a naming exercise — the
same bodies that will back a SQLite adapter.

---

## 7. Tests and gates

Run from the repository root on this tree:

- `pnpm format:check` — **clean**.
- `pnpm turbo run lint` — **clean** (one pre-existing `no-img-element` warning in
  `tenant-branding-panel.tsx`, unrelated to this phase).
- `pnpm turbo run type-check` — **clean** across all packages.
- `pnpm turbo run test:run` — **398 passed / 26 skipped** (424) across 15 files.
  `tests/phase03-dashboard-catalogue.test.ts` is **35 tests** (was 23; +12 here):
  dashboard authorization/scoping/arithmetic, snapshot immutability, exact decimal
  maths, an in-memory implementation of all three ports, and — added here — the
  customer unit, the validity window (in-force, before, after, bounded-without-date,
  open-ended) and the validation rules. `tests/phase04-security.test.ts` (79
  tests) covers cross-tenant reads/writes, required fields, invalid prices,
  permissions, search, pagination and archiving for the CRM/item/contact-item
  actions, plus the action-level check that a one-sided edit cannot invert the
  stored validity window.
- `pnpm --filter @amisibiz/web build` — **succeeds**; the route table includes the
  dashboard, contacts, items, documents and both PDF routes.

---

## 8. Honest limits

- **Not browser-exercised.** The dashboard, CRM, item and customer-catalogue
  screens are build- and type-clean but have not been driven in a browser against
  real data in this phase.
- **The new migration is not applied.** `20261022000000` is authored and
  clean-room parseable, but the columns do not exist in the live database until
  the owner applies it. Until then, code that writes the new fields against the
  live project would fail; the mock-backed tests do not depend on the live schema.
- **The snapshot builder is the canonical path, not yet the wired one.** The
  issuing actions freeze payload values after ownership validation; wiring
  `buildDocumentLineSnapshot` directly into the line-creation transaction is a
  Phase 05 follow-up.
- **RLS stays inert**, so all isolation claims are application-layer plus a
  throwaway database.
- **Currency is KES-only**; the customer catalogue inherits that boundary.

---

## 9. Dependencies

Phase 04 (CRM, item catalogue and customer catalogue) — the surfaces this brief
audits were built there. Phase 05 (document engine) supplies the frozen line and
the payment netting the dashboard's outstanding figure uses.
