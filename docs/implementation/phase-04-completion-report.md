# Phase 04 — Tenant branding, contacts CRM and catalogue: completion report

- **Date:** 2026-10-14
- **Brief:** PHASE 04 sections A–F (branding, contacts CRM, items and services,
  customer-specific catalogue, data security, acceptance)
- **Verification commands and their actual output are in section 5–6; nothing in
  this report is asserted without the command that produced it.**

---

## 1. Features implemented

### A — Tenant branding

`TenantBranding` carries display name, registered name, logo, primary /
secondary / accent colours, contact email and phone, postal and physical
address, website, tax PIN, currency, default document footer, payment
instructions and document layout.

- Colour input is validated as `#rrggbb`, lower-cased on write, and the
  primary/secondary pair must meet WCAG 2.1 AA 4.5:1. `src/lib/branding/contrast.ts`
  is imported by both the form (live warning) and the Server Action (authoritative
  rejection), so the browser can advise but never decide. An unparsable colour
  counts as failing, never as passing.
- Logo upload accepts **PNG, JPEG and WebP only** — SVG is excluded because it
  can carry script. The file is classified from its own bytes: magic signature
  first, then pixel dimensions parsed out of the PNG IHDR, the JPEG SOF segment
  or the WebP VP8X/VP8L/VP8 header. An unreadable header rejects the upload
  instead of skipping the size check. Declared MIME type, file name and extension
  are all treated as untrusted labels; the stored extension comes from the
  verified type and the file name is 32 random hex bytes.
- Storage is a controlled directory (`uploads/tenants/<tenantId>/logo/`, mode
  `0640`) and serving is an authorized route, not a public asset path. User
  content is never injected as HTML or CSS: branding reaches the workspace as
  three CSS custom properties used by tenant document chrome only.
- The form shows a live document preview built from the saved palette. The
  platform console, security indicators and system messages never read branding
  values.

### B — Contacts CRM

`Contact` + `ContactAddress` with paginated, searchable list (first/last name,
company, phone, email), create/edit, individual vs business identity, addresses,
tax PIN, notes, per-customer catalogue, document history and an
outstanding-balance summary.

- The individual/business identity rule lives in one `superRefine` shared by the
  create and update schemas, and is only enforced when the caller touches a
  name-bearing field, so a phone-only edit cannot fail on data the user did not
  edit.
- Balance is aggregated from documents whose status is `ISSUED`, `OVERDUE` or
  `PARTIALLY_PAID`, returned as a decimal **string** with the currency travelling
  beside it.
- Archiving is soft. There is no contact hard-delete path: `archiveContactAction`
  flips `status`/`archivedAt` and touches no address and no document row.

### C — Items and services

`Item` with name, SKU, description, unit of measure (controlled enum), unit
price, currency, tax category/rate and active flag, plus `TaxCategory` and
`TaxRate` as an explicit tax configuration model — nothing is assumed taxable at
a common rate. Money is `numeric(18,4)`, tax rate is a `numeric(5,4)` fraction
CHECK-bounded to 0–1; values cross the action boundary as decimal strings and
become `Prisma.Decimal` on write, so no authoritative total is computed in binary
floating point. SKU uniqueness is per tenant (`@@unique([tenantId, sku])`), and
the migration CHECK rejects blank SKUs, negative prices and non-KES currency.

### D — Customer-specific catalogue

`ContactItem` keyed by `(contactId, itemId)` with customer code, description,
agreed price, discount percentage (`numeric(5,2)`, 0–100 CHECK) and availability.
It is a separate table from `Item`: writing an agreed price issues no `Item`
update, so one customer's price can never rewrite the default for others. The
picker refuses an archived contact or an inactive item, and the delete path
removes only the assignment.

### E — Data security

- Every read and write re-derives the tenant from `authorizeTenant(session.user.id,
tenantId, permission)`; a browser-supplied tenant id is used only as a lookup
  key for membership, never as the write scope.
- `updateMany`/`deleteMany` carry the tenant inside their `where` clause and fail
  closed when `count === 0`.
- Mass assignment is blocked twice: the Zod object schemas strip unknown keys, and
  each action builds its Prisma payload field-by-field (`toContactUpdateData`,
  `toItemUpdateData`, `toContactItemUpdateData`, `toBrandingPatch`) instead of
  spreading.
- Query parameters are bounded (`pageSize` 1–100, `page` ≥ 1, `sortBy`/`sortOrder`
  from enums), so `?sortBy=email; DROP TABLE "Contact"` is a validation error, not
  an `orderBy`.
- Audit rows record field **names**, ids and counts — never an address, tax PIN,
  email, price or the original uploaded file name.

### F — Acceptance

A business can configure branding, manage contacts, create products/services and
assign customer-specific items and prices; all data is tenant-scoped; contact and
catalogue writes never rewrite issued documents (proved by both the app-layer
tests and migration check 12).

---

## 2. Files and modules changed

New: `src/lib/branding/contrast.ts`, `src/lib/format/money.ts`,
`src/lib/validations/document.ts`, `src/server/actions/_shared.ts`,
`src/components/ui/confirm-dialog.tsx`,
`prisma/migrations/20261014000000_phase04_branding_contacts_and_catalogue/migration.sql`,
`prisma/scripts/phase04-migration-checks.sql`,
`tests/phase04-security.test.ts`, `tests/phase04-logo-storage.test.ts`.

Modified (48 files, +8695 / −4267): branding/contact/item/document Server Actions
and their validation modules; `src/app/api/branding/logo/route.ts` and
`src/app/uploads/tenants/[...path]/route.ts`; the contacts, contact-detail, items
and branding pages plus their client components and dialogs; `src/lib/audit`,
`src/lib/validation/common.ts`, `src/lib/utils` (`parsePageParam`),
`tests/prisma-mock.ts` (Phase 04 delegates), the two repaired earlier migrations,
`prisma/scripts/rls-policies.sql`, `.gitignore`, `tailwind.config.ts`,
`docs/implementation/phase-checklist.md`.

---

## 3. Migrations added

| Migration                                                | Purpose                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261014000000_phase04_branding_contacts_and_catalogue` | Branding columns + colour/logo CHECKs, `TaxCategory`, `TaxRate`, `Contact`, `ContactAddress`, `Item`, `ContactItem`, document totals, tenant-scoped indexes/unique constraints, single-tenant link triggers, RLS policies + grants for `amisibiz_app` |
| `20261013000000_init` (repaired)                         | UTF-8 BOM stripped — it previously broke `psql -f` and `migrate deploy` on the very first step                                                                                                                                                        |
| `20261013000001_rls_policies_and_constraints` (repaired) | `CREATE EXTENSION pgcrypto`, quoted camelCase policy columns, transaction-local `set_config(..., true)` instead of a session-scoped GUC over a pooled connection                                                                                      |

No migration has ever been applied to a shared AmisiBiz database — see 6.1.

---

## 4. Security and authorization controls applied

`contacts.*`, `items.*`, `business.settings.*` and `documents.read` permission
gates on every action; deny-by-default RBAC (an unknown role or permission
denies); tenant membership + `ACTIVE` status re-checked on every protected
operation including the private file server; `AUTHZ_DENIED` audit rows for
cross-tenant and insufficient-role attempts; session-derived identity only
(`requireAuth()` / `auth()`, never a posted user id); no secret, private storage
URL or customer PII in client bundles, action errors or audit metadata; uploads
restricted by type/size/dimension with content-based classification; serving
responses are `private, no-store` + `nosniff` + sandboxed CSP + `no-referrer`.
The `authorizeTenant` / `authorizePlatform` pattern was preserved everywhere and
no role-list check was reintroduced.

---

## 5. Tests executed — actual results

```
$ pnpm test:run
 ↓ tests/integration-security.test.ts (12 tests | 12 skipped)
 ✓ tests/security-utils.test.ts (5 tests) 6ms
 ✓ tests/workspace-guard.test.ts (7 tests) 12ms
 ✓ tests/tenancy.test.ts (13 tests) 11ms
 ✓ tests/phase04-logo-storage.test.ts (28 tests) 58ms
 ✓ tests/phase04-security.test.ts (78 tests) 67ms
 ✓ tests/security.test.ts (38 tests) 283ms

 Test Files  6 passed | 1 skipped (7)
      Tests  169 passed | 12 skipped (181)
```

106 tests are new for this phase. `tests/phase04-security.test.ts` covers
cross-tenant read/write attempts against contacts, items, tax rates, customer
catalogue, branding and documents; forged and malformed tenant ids; privilege
escalation for all five `TenantRole`s plus `SUSPENDED`/`PENDING` tenants;
mass-assignment payloads; decimal handling (`0.1 + 0.2 = 0.3`, rejects `-100`,
`1.23456`, `1,200.00`, `1e3`, `""`); soft-archive non-destruction of addresses
and documents; colour/CSS/`javascript:`/`data:`/protocol-relative payloads; PII
absence in audit metadata; query-parameter bounds; and 20 actions redirecting
unauthenticated callers. `tests/phase04-logo-storage.test.ts` covers both file
routes: unauthenticated 401, non-member 403, forged-tenant 403 before any disk
access, SVG-bytes-declared-as-PNG rejection, empty and >5 MB files, oversized and
unreadable dimensions, extension derived from the verified type, random stored
name, `0640` mode, and — on the serving side — 15 traversal/malformed-shape
attempts all 404 with `readFile` never called.

**The tests were mutation-checked, not just written until green.** Each control
below was deliberately broken and the suite re-run:

| Deliberate break                                      | Result                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `where: { id, tenantId }` → `where: { id }`           | `updates a contact with a tenant-pinned where clause` failed                |
| field-by-field update mapping → spread + loose schema | the mass-assignment assertion failed                                        |
| serving route: membership check removed               | `never serves another tenant's folder` and the suspended-tenant case failed |
| upload route: magic-byte gate disabled                | both content-mismatch tests failed                                          |

`tests/integration-security.test.ts` stays skipped: it needs a real database
(12 DB-backed isolation tests are gated on `DATABASE_URL` reaching a Postgres
instance, which this environment does not provide).

---

## 6. Build, type-check, lint and migration evidence

```
$ pnpm format   → prettier, all files rewritten/clean
$ pnpm type-check  → $ tsc --noEmit                      (no output, exit 0)
$ pnpm lint        → $ eslint .                           (no output, exit 0)
$ pnpm build       → exit=0
   ✓ Compiled successfully in 3.0s
   ✓ Generating static pages (57/57)
   ƒ /api/branding/logo            ƒ /uploads/tenants/[...path]   (both dynamic)
```

Migration evidence (throwaway local cluster; `initdb -A trust`, port 55499,
created and destroyed inside this session — the project database was never
touched):

```
20261013000000_init                                  exit=0
20261013000001_rls_policies_and_constraints          exit=0
20261014000000_phase04_branding_contacts_and_catalogue exit=0

$ prisma migrate diff --from-url <clean-applied-db> --to-schema-datamodel prisma/schema.prisma --script
-- This is an empty migration.          (zero drift between the SQL and the schema)

$ psql -f prisma/scripts/phase04-migration-checks.sql     exit=0
19 labelled results, 12 expected constraint/RLS rejections, including:
 1. rate stored exactly as a fraction            → 0.1600
 6. negative unit price rejected                 → Item_unitPrice_check
 7. cross-tenant taxRateId rejected              → Item.taxRateId does not belong to this tenant
 9. cross-tenant ContactItem rejected            → ContactItem.itemId does not belong to this tenant
10. default price untouched by a customer price  → default 100.0000 / agreed 80.0000
12. document keeps its contact after archive     → 1
13a. app role sees only its tenant               → 1
13b. with no tenant context the app role sees nothing → 0
14. write tagged with another tenant rejected    → row-level security policy violation
```

---

## 7. Outstanding defects, limitations and decisions

1. **No shared database has ever run these migrations.** Neither git-ignored
   credential set authenticated from this machine, so applying them to the real
   environment is unverified and remains a release-blocking step. Evidence above
   comes from a scratch cluster plus `migrate diff`, and is the honest maximum
   available offline.
2. **RLS is defined but inert.** The policies read `app.current_tenant_id`, which
   no application code sets yet, and the app connects as the table owner rather
   than `amisibiz_app`. The application layer is the control actually in force;
   scratch check 13 proves the policies behave correctly once a per-request
   tenant context exists and the least-privileged role is used (Phase 08).
3. **Uploads live on the server filesystem.** That does not survive a stateless
   serverless deploy; Phase 06/08 should move logos to provider storage behind
   the same authorization contract. Files are mode `0640` and served only after
   membership + path-shape checks in the meantime.
4. **Currency is KES-only** by explicit `SUPPORTED_CURRENCIES = ["KES"]`; a
   non-KES write is a validation error, not a silent accept.
5. **No `/app/items/[id]` detail route.** The previously decorative "View item"
   control was deleted rather than left pointing at a route that does not exist.
6. **`Document` stores header fields only** — no line items. The balance summary
   is correct for what exists; line items and PDF rendering are Phase 06.
7. **No E2E layer exists.** `playwright` is not a dependency and there is no
   config or `e2e/` directory, so the old checklist line "E2E CRUD journey green"
   was never reachable. The Phase 04 journeys are covered at the action/route
   layer instead; introducing Playwright needs its own approved task.
8. **Contact de-duplication is limited** to a per-tenant case-insensitive email
   uniqueness rule; fuzzy/phone dedupe and CSV import/export (mentioned in the
   superseded one-line checklist entry) are not built and are not part of the
   Phase 04 brief.
9. **Two parser defects were found by writing the tests, then fixed:** JPEG
   dimension reading took the segment length as the height (a valid 640×480 JPEG
   logo was rejected as oversized), and lossy-WebP dimensions were read one byte
   early with no start-code check. The `phase04-migration-checks.sql` step 14 was
   also changed to use a savepoint so the expected RLS rejection no longer
   cascades "aborted transaction" noise.
10. **Decision:** branding contrast is enforced server-side as a hard rejection
    for the primary/secondary pair while the form only warns, so a client that
    skips the UI cannot store an unreadable palette.

---

## 8. Next phase that can safely begin

**Phase 06 — Documents & PDF generation.** Its prerequisite catalogue shipped
inside Phase 04, so Phase 05 is narrowed to optional extras and is not a
blocker. Phase 06 should add document line items (completing the balance summary
that already reads `Document.total`), render PDFs from tenant branding, and move
logo storage to the provider. Two Phase 04 carry-over items must not be dropped:
activating RLS (per-request `set_config`, connecting as `amisibiz_app`) and
running `prisma migrate deploy` against a real database.
