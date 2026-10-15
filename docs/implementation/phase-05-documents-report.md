# Phase 05 — Quotations, invoices and delivery notes: status report

- **Date:** 2026-10-15
- **Brief:** the owner's **PHASE 4: QUOTATIONS, INVOICES AND DELIVERY NOTES**
  directive (shared document engine, quotations, invoices, delivery notes,
  numbering and issuance, corrections, branded A4 PDFs, customer-portal access,
  tax configuration, eTIMS boundary, acceptance criteria).
- **Naming:** this checklist slot is **Phase 05 — Documents & PDF generation**;
  the directive called it Phase 4. `phase-checklist.md` §"Phase 05" carries the
  reconciliation. This report is the file that section references.
- **Status word:** this is a **build-and-verify record, not a completion claim.**
  The repository gates are green on this tree and are quoted with the command
  that produced each number (§6). The line-by-line conformance audit against every
  clause of the directive (task #55) was **stopped by the owner** before it
  finished, so the requirement-by-requirement table in §5 records what is provably
  there and what is **not yet proven**. §7 lists the functional gaps that remain
  open in the product, not just in the evidence.
- **Standing security context, unchanged by this phase:** RLS is still **inert in
  the deployed app** (`amisibiz_app` has no password; task #38 is open and its
  runbook is `../administration/rls-activation-operator-procedure.md`). Nothing
  here was verified against the live Supabase project, and no document feature is
  described as live-enforced.

---

## 1. Gate and owner decisions this phase runs under

1. **The directive opened the business-feature gate** (owner decision, 2026-10-15:
   _"Directive opens the gate"_). The constitution's rule — _"Do not begin business
   feature development until the core authorization and RLS tests pass"_ — is met
   on the repository half (the DB-backed harness and both batteries exist as
   tracked files and pass, #37a/#37b), and the owner chose to proceed rather than
   wait on the operational half. **That does not close #37 or #38**: #37 still
   needs an actual CI run (or the owner accepting the local rehearsal), and #38
   still needs the operator password step. Every "authorization works" statement
   below is a statement about the application layer plus a throwaway database.
2. **The parked engine was resurrected and repaired** (owner decision:
   _"Resurrect and repair it"_). The business tree that had been parked on
   `wip/phase05-business-features` (`0a67b69`) was brought back into the working
   tree, the 10 type errors were fixed, and the document detail client that never
   existed was written rather than stubbed.
3. **Nothing in this phase is committed yet except documentation.** The business
   tree — 52 changed files (+11,295 / −386) plus the new
   `document-detail-client.tsx` — sits in the working tree awaiting the owner's
   commit decision. This report and the status/checklist/RUNBOOK updates are the
   first commit.

---

## 2. What is in the tree, by layer

### Schema (already deployed to the live project, except migration 12)

`Document`, `DocumentLine`, `DocumentPayment`, `DocumentStatusEvent`,
`DocumentNumbering`, `DocumentNumberSequence` arrive with migration
`20261015000000` (numbers tenant-scoped unique, issue snapshots, totals-identity
CHECKs, a status-matches-type CHECK, `idempotencyKey`, `allocate_document_number()`
and `peek_document_number()` counting per tenant/type/period under `FOR UPDATE`).
Enforcement is trigger-side, not code-side:
`document_is_immutable_after_issue`, `document_line_is_immutable_after_issue`,
`document_payment_is_append_only`, `document_status_event_is_append_only`,
`document_references_belong_to_tenant`, and the same-tenant guards on
line/payment/status-event.

**Migration 12** (`20261020000000_phase05_portal_linkage`) adds
`Contact.portalUserId` — a nullable `SET NULL` FK to `User` plus
`@@unique([tenantId, portalUserId])` — so a portal login maps to at most one
customer identity per tenant. It is authored, clean-room verified, **not applied to
the live project** (owner-gated).

### Shared engine — `@amisibiz/documents` (pure, no Prisma, no Next)

| File              | Role                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `decimal.ts`      | `add/subtract/multiply/compare/sum` on decimal **strings**, returning `null` rather than a silent wrong answer                              |
| `money.ts`        | `roundDecimalString(value, places)` half-up with no float step, `formatMoney`, `formatPercent`, the currency table (currently **KES only**) |
| `calculations.ts` | `MONEY_SCALE = 4` and `DOCUMENT_ROUNDING_POLICY = "half-up-per-line-v1"`; line → subtotal → discount → per-rate tax → total, all as strings |
| `lifecycle.ts`    | the per-type transition table, `assertTransition`, `isEditable`, `isConvertibleQuotation`, `deriveInvoiceStatus`, `deriveDeliveryStatus`    |
| `numbering.ts`    | period resolution (calendar/fiscal), `composeDocumentNumber`, `previewDocumentNumber` (never consumes a counter)                            |
| `snapshot.ts`     | `composeDocumentSnapshot` / `readDocumentSnapshot` — the frozen record the PDF and the print path read from                                 |
| `pdf-writer.ts`   | dependency-free A4 writer: paginates long line tables, repeats the header row, numbers every page, paints tenant colours and logo           |

### Server services — `apps/web/src/server/services/documents/**`

`createDraft`, `updateDraft`, `issueDocument`, `voidInvoice`,
`recordQuotationDecision`, `convertQuotationToInvoice`,
`createDeliveryNoteFromDocument`, `recordDelivery`, `recordPayment`,
`reversePayment`, `createReplacementDraft`, `getDocumentWithLines`, plus
`numbering.ts` (DB allocation), `logo.ts`, `render.ts`, `portal.ts`,
`lines.ts`, `calculations.ts`, `errors.ts`, `snapshot.ts`.

`issueDocument` is the six-step sequence the directive asked for, in one
`prisma.$transaction`: re-check access through the `TenantAuthzContext` the caller
was authorized into → require a customer and re-verify every line's `contactId` /
`itemId` / `taxRateId` belongs to the tenant (`resolveLines`) → **recalculate** the
totals from the stored lines rather than trusting them → freeze customer, item,
tax and branding facts into the snapshot → allocate the number and write document,
lines, snapshot, status event and audit row atomically → leave the DB triggers to
make any later alteration impossible.

### Actions, validation, routes

- `apps/web/src/server/actions/document.ts` — the read surface
  (`getDocumentsAction`, `getDocumentAction`, `getDocumentDetailAction`) and one
  action per operation. The permission for a write is chosen from the document's
  **stored type** (`authorizeByDocumentType`), never from a type the browser sent.
- `apps/web/src/lib/validations/document-write.ts` — Zod-only input shapes;
  `taxRateId` and `contactId` are UUIDs that the service then re-checks against the
  authorized tenant, so a schema-valid body is still not a trusted body.
- `GET /api/documents/[documentId]/pdf` (`documents.download`) and
  `GET /api/portal/documents/[documentId]/pdf` (`portal.documents.*`, scoped by
  `contactId` in the `WHERE` clause so another customer's document is a 404, not a
  403). Both read the frozen snapshot; both audit the download.

### UI and i18n

`/[locale]/app/documents` (list, sortable on the six fields the server accepts),
`…/documents/new` (draft creation with per-line validation),
`…/documents/[id]` (detail: lines, totals with the per-rate breakdown, paid and
outstanding, customer, dates, notes/terms, payments with reason-gated reversal,
delivery acknowledgements, status history, and the lifecycle actions plus PDF
preview/download). The shared `documentEnums` message namespace (type, status,
payment method, discount type, period style, layout) is complete in **en, fr and
sw**.

---

## 3. Money rules as implemented

- Every amount on an authoritative path is a decimal **string**
  (`numeric(18,4)` columns, `Prisma.Decimal` in Prisma, `decimalStringSchema(4)` at
  the boundary). No `Number()` or `parseFloat` appears in a calculation: a
  comparison that needs numeric semantics uses `compareDecimalStrings`.
  `deriveInvoiceStatus` compares strings for exactly that reason.
- Prices, totals, discounts, taxes and the currency are read from the database —
  the client sends quantities, unit prices by reference and a `taxRateId`; the
  engine recalculates and the issued snapshot freezes the result.
- Payments are rows, not status edits. `recordPayment` inserts, then derives the
  status from `total` vs `paid` vs the due date; `reversePayment` requires a reason
  and re-derives. A browser cannot set `PAID`.
- Delivery facts stay separate: a delivery note carries acknowledged quantities and
  its own lifecycle, moving the `deliveredQuantity` counters on the source lines —
  it does not touch payments.

---

## 4. Numbering and immutability

Numbers come from `allocate_document_number()` (Postgres, `SELECT … FOR UPDATE` on
the sequence row, per tenant + type + period), so two issuances in the same tenant
cannot take the same number; exceeding a configured period limit surfaces as its
own error rather than a truncated string. `peek_document_number()` exists for the
"next number" preview and does not consume a counter.

Issued documents are frozen twice: the engine refuses to write to a non-DRAFT
document (`assertDraft`, `isEditable`), and `document_is_immutable_after_issue` /
`document_line_is_immutable_after_issue` refuse the UPDATE/DELETE at the database
even for code that forgot. Corrections are explicit operations: **void** (invoices
only, reason required, audited) and **create replacement draft** (a new document
that references the one it corrects); there is no in-place edit path.

---

## 5. Acceptance criteria: proven vs not proven

| Directive criterion                                                               | State                                      | What it rests on                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact arithmetic, no binary floats                                                | **Proven in tests**                        | `Phase 5 exact arithmetic` cases incl. `0.1 + 0.2`, percentage discount + tax, overpaid balance floored at zero                                                                                                                     |
| Rounding policy is explicit and recorded                                          | **Proven in code**                         | `half-up-per-line-v1` written into the snapshot; `roundDecimalString` exercised directly                                                                                                                                            |
| Concurrent numbering cannot duplicate                                             | **Proven at the database layer only**      | `allocate_document_number()` + `prisma/scripts/phase05-numbering-concurrency.sql`; **not** exercised by the vitest suite (mocked Prisma) and **not** run against the live project                                                   |
| Quotation → invoice conversion preserves customer, currency, descriptions, prices | **Proven in tests**                        | `Phase 5 quotation conversion`: refuses a non-accepted quote, copies lines into a DRAFT invoice, returns the existing invoice on a retry instead of duplicating                                                                     |
| Issued snapshots are immutable                                                    | **Proven by schema + tests**               | triggers §4; `Phase 5 corrections and guards`, `Phase 5 immutable snapshot`                                                                                                                                                         |
| Controlled correction / void / replacement                                        | **Proven in tests**                        | void only for invoices from a voidable status; replacement-draft action; reason required                                                                                                                                            |
| Payment state is derived, never asserted                                          | **Proven in tests**                        | `derive PARTIALLY_PAID from recorded payments, never from the caller`; `refuses a payment on a draft or a void invoice`                                                                                                             |
| PDFs render the frozen snapshot, not live rows                                    | **Proven in code, not visually**           | every PDF path reads `readDocumentSnapshot`; a draft yields 409 rather than a blank page; bytes asserted as `%PDF-1.4` … `%%EOF` and deterministic                                                                                  |
| Authorization on every document operation                                         | **Proven at the app layer; DB half inert** | permission chosen from the stored type; `Phase 5 staff document download authorization` / `…customer-portal download authorization` cases; the RLS that would enforce this independently is **#38, not active** in the deployed app |
| Cross-tenant document access is refused                                           | **Proven in tests**                        | the route cases above plus the 26-case RLS harness on a throwaway database                                                                                                                                                          |
| Professional A4, multi-page, page-numbered output                                 | **Written, not verified by rendering**     | `pdf-writer.ts` implements pagination, repeated headers, page numbering; **no test renders a long document** and no PDF was opened or printed (§7)                                                                                  |
| Explicit tax configuration                                                        | **Engine + schema yes; product no**        | the engine and DB accept a tenant-scoped `taxRateId`; **there is no action that lists tax rates and no picker in the create form**, so documents created through the UI are untaxed (§7)                                            |
| eTIMS adapter boundary                                                            | **Boundary is a rule, not code**           | the PDF contract and preview component state that an AmisiBiz document is never a KRA/eTIMS tax invoice; **no eTIMS adapter module exists**, which is the intended state for this phase (eTIMS is a separate integration)           |

---

## 6. Verification actually performed (2026-10-15, this tree)

Every number below is the output of the command beside it, run against the working
tree described in §1.3.

| Command                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                                                                            | `All matched files use Prettier code style!`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm turbo run lint type-check test:run build --force`                                                                                        | **18/18 tasks successful**, 0 errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ↳ `lint`                                                                                                                                       | 0 errors; **1 pre-existing warning** — `no-img-element` in `components/platform/tenant-branding-panel.tsx:402`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ↳ `type-check`                                                                                                                                 | green, all workspaces (the 10 errors that made the parked tree red are gone; `tsc --listFiles` confirms all three document client files are in the program)                                                                                                                                                                                                                                                                                                                                                                                   |
| ↳ `test:run`                                                                                                                                   | **337 passed / 26 skipped (363)**, Test Files **12 passed / 1 skipped**. The 26 skips are `integration-security.test.ts`, which self-skips without `TEST_DATABASE_URL`                                                                                                                                                                                                                                                                                                                                                                        |
| ↳ the document suite                                                                                                                           | `tests/phase05-documents.test.ts` — **46 tests**, listed by area in §5                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ↳ `build`                                                                                                                                      | green (exit 0); `/[locale]/app/documents`, `…/new`, `…/[id]`, `/api/documents/[documentId]/pdf` and `/api/portal/documents/[documentId]/pdf` are all in `app-path-routes-manifest.json`                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm check:bundles`                                                                                                                           | clean — **205 files / 5.5 MB** scanned across `.next/static` + `.next/server` for `sb_secret_*`, service-role markers, passworded Postgres URLs and JWT secret material                                                                                                                                                                                                                                                                                                                                                                       |
| `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55499/p4_report_harness npx vitest run tests/integration-security.test.ts` (fresh database) | **26 passed / 26** as `amisibiz_app`; the `42501 permission denied` lines in stdout are the intended denial probes                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PGHOST=127.0.0.1 PGPORT=55499 PGUSER=postgres sh scripts/db/cleanroom-chain.sh p4_report_chain` (fresh database)                              | exit 0 — `phase01-migration-checks.sql` **78 PASS / 0 FAIL**; behaviour battery **71 PASS + 1 labelled SKIP** before and immediately after migration 11; migration-11 **abort probe** fires (`Cannot convert Tenant.planId to a UUID: 2 row(s)…`); after the operator NULLs the legacy labels: `plans=1`, catalog **42**, matrix **116**, `planId type=uuid`; Phase 2 battery **55 PASS / 0 FAIL**; step 13 applies `20261020000000` → `20261021000000` → `20261021000001` and the battery prints **72 PASS / 0 FAIL** with the SKIP resolved |

Not run, and not claimed: any live Supabase probe (`pnpm db:assert-rls`), any
browser walkthrough of the document screens, CI on GitHub (nothing pushed), and the
numbering-concurrency SQL script against a real tenant database.

---

## 7. Open gaps in the product (not just in the evidence)

1. **The engine was never audited against the directive.** Task #55 was stopped by
   the owner mid-review. §5 is a mapping built from reading and from tests, not the
   finished audit; treat clauses it marks "proven in code" as awaiting that review.
2. **Tax cannot be applied through the UI.** No `TaxRate` read action exists and
   `new-document-client.tsx` carries `taxRateId: ""` with no control to set it, so
   every document created in the app is untaxed even though the engine, schema and
   CHECKs support rates. Fixing it needs a rate list action, a picker, and
   catalogue-item price/tax prefill.
3. **No draft-editing screen.** `updateDocumentDraftAction` exists and is tested at
   the service layer; there is no `/documents/[id]/edit` UI, so a wrong draft can
   only be abandoned and re-created.
4. **Customer portal is a route, not a product.** The download path, the
   contact-scoped resolver and their tests are in place; there is no portal page
   listing a customer's documents, and no signed-URL mechanism (server-authorized
   download was chosen, which satisfies the directive's "either" wording — but
   nothing in the UI lets a portal user reach a document id).
5. **PDF output is unverified visually.** No test renders a multi-page document, a
   very long description, or a logo (`logo: null` in every render test); nobody
   opened a produced PDF. Pagination, header repetition and page numbering are
   implemented but only by inspection of the writer.
6. **i18n is partial.** The detail client and the shared `documentEnums` namespace
   are translated in en/fr/sw; the list and create pages still hardcode English
   labels, so a fr or sw workspace sees mixed-language document screens.
7. **Currency is KES-only.** The column, the snapshot field and the formatting
   helper exist, but the currency table has one entry; a second currency needs an
   exponent/symbol row and a rounding decision per currency.
8. **Live state is unchanged.** Migrations 11 and 12 and the two gate migrations
   are **not** on the shared project (owner-gated sequence: #38 → 11 → #37), so the
   document feature cannot be exercised there yet, and RLS remains inert.

---

## 8. Next actions, in order

1. **Owner decision: commit the business tree.** It is gate-green as recorded in §6
   and it is the only copy of the work besides `0a67b69` on
   `wip/phase05-business-features`.
2. **Finish the halted audit (#55) and close the gaps it finds (#56)** — starting
   with the two that change behaviour, not just evidence: tax wiring (§7.2) and the
   multi-page/logo rendering tests (§7.5).
3. **#38 operator step** (`../administration/rls-activation-operator-procedure.md`,
   summarised in `../RUNBOOK.md` §3), then the pending migrations in the owner's
   sequence, then the post-apply probes — each with explicit go-ahead.
4. **#37 remainder:** push so the `security` CI job actually runs, or accept the
   documented local rehearsal as equivalent.
5. **#36** Supabase Storage adoption for logos — the document PDF path reads the
   logo bytes live, so it inherits this.

---

## 9. Related records

- `phase-checklist.md` §"Phase 05" — the phase plan line this report closes out.
- `../IMPLEMENTATION_STATUS.md` — current position, feature table and the gate run.
- `../architecture/security-model.md` §13 — what enforcement exists and what does not.
- `../administration/rls-activation-operator-procedure.md` — #38, not executed.
- `phase-01-security-harness-report.md` — the DB-backed proofs cited in §6.
- `../RUNBOOK.md` §4.1–§4.3 — the exact commands, including the two environment
  traps (`DIRECT_URL`, and port 55499 listening on both `localhost` and
  `127.0.0.1`).
