# AGENT 5 — Financial rules and document engine: inventory and gap analysis

Date: 2026-10-18 · Status: **inventory complete, implementation blocked by a live
file reservation** (see §4). No code was modified for this report.

## 1. Scope and method

The directive asks for accurate, traceable, immutable-on-issuance commercial
documents with server-side services, transactions, decimal-safe arithmetic and
explicit lifecycle transitions (sections A–I plus an acceptance gate). Phase 05
and the #68 pricing fix already delivered a large part of that engine. This
report inventories what exists against every directive clause, verifies the
database-level enforcement, and names the real gaps.

Evidence is file:line in the current working tree (uncommitted work by several
agents included; nothing here was executed against the live database).

## 2. What already holds, per directive section

| Section                                       | Status                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C — Decimal-safe money                        | **Holds**                               | `packages/documents/src/calculations.ts`: every money/quantity value is a decimal STRING end-to-end; arithmetic never touches a JS `number` (`addDecimalStrings`/`multiplyDecimalStrings`/`subtractDecimalStrings`); rounding policy named and frozen as `half-up-per-line-v1` (line 35), recorded on every document and in every snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C — Rounding / precision / negatives          | **Holds**                               | Per-line rounding at 4 dp, totals are exact sums of rounded components, and the equalities are CHECK-enforced (`document_totals_are_consistent`, `document_line_net_matches_its_components`, `document_line_discount_is_within_the_line`, `document_line_quantity_is_positive_and_bounded`, `document_payment_amount_is_positive_and_bounded` — migration `20261015000000_phase05_documents_and_numbering`). Zod bounds (`decimalStringSchema(4)`, `moneySchema`, `percentSchema`) reject unsupported precision before the engine runs.                                                                                                                                                                                                                             |
| C — Currency                                  | **Holds**                               | `Document.currency` explicit per document, default KES; `currencySchema` is a whitelist (`packages/domain/src/validation/common.ts:113`); a catalogue item priced in another currency is refused, not converted (`services/documents/lines.ts:452`). No conversion exists anywhere — per the directive's own prohibition.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C — Server-side recalculation before issuance | **Holds**                               | `issueDocument` recomputes totals from the stored lines in `"stored"` mode before freezing (`services/documents/service.ts:554`); the snapshot builder re-derives totals from the copied lines so a snapshot cannot disagree with itself (`packages/documents/src/snapshot.ts:154`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D — Types, draft→issue, PDF                   | **Holds**                               | QUOTATION / INVOICE / DELIVERY_NOTE; drafts are editable and unnumbered; PDF renders from the frozen snapshot only, drafts 409 (`services/documents/render.ts:39`); deterministic bytes tested (`phase05-documents.test.ts:428`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| E — Lifecycle state machine                   | **Holds structurally**                  | Typed transitions per type (`packages/documents/src/lifecycle.ts:43`), re-enforced by CHECK `document_status_matches_type`; every write passes `assertDocumentTransition`; invalid transitions are refused with a field error. Derived statuses (PAID / PARTIALLY_PAID / OVERDUE / delivery) are computed from payment rows and dates, never set by the client (`deriveInvoiceStatus`).                                                                                                                                                                                                                                                                                                                                                                             |
| F — Issuance snapshot                         | **Holds**                               | `DocumentSnapshot` v1 carries: number; tenant + displayed business details; customer identity + displayed details; currency; per-line description, quantity, unit price, discount mechanism, tax rate AND tax name; document totals + per-rate breakdown; terms and all dates; issuance timestamp (`generatedAt`); issuing actor (`Document.issuedById` + status event + audit row); calculation/template version metadata (`version`, `roundingPolicy`). Immutability is trigger-enforced (`document_is_immutable_after_issue`, `document_line_is_immutable_after_issue`, `document_payment_is_append_only`, `document_status_event_is_append_only`). A later contact/branding/catalogue edit cannot rewrite an issued document — the PDF reads only the snapshot. |
| F — Corrections                               | **Holds**                               | Void requires a reason and an actor (CHECK `document_voiding_requires_a_reason_and_an_actor`), is invoice-only, permission-gated (`INVOICES_VOID`), audited; replacement is a NEW draft linked by `replacementOfId`; the original stays on the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| G — Numbering                                 | **Holds**                               | `allocate_document_number()` allocates under `SELECT … FOR UPDATE` on the counter row inside the issuance transaction; per-(tenant, type, period) sequences (`DocumentNumberSequence_tenantId_type_period_key`); uniqueness of issued numbers is database-enforced (`Document @@unique([tenantId, type, number])`, schema line 772); a failed issuance rolls back and returns the number; counters persist across restarts; format and prefix configurable per tenant/type (`DocumentNumbering`), with calendar and financial-year periods; `peek_document_number()` mirrors composition for previews.                                                                                                                                                              |
| H — Transactions / duplicate protection       | **Holds, with one design note**         | Every operation is a single transaction containing authorization-adjacent reads, number allocation, snapshot and writes. Idempotency keys exist for draft creation and delivery notes (unique index `Document_tenantId_idempotencyKey_key`); quotation→invoice conversion is idempotent via `document_one_invoice_per_source`. Audits are written **after** the transaction commits; no external side effects inside transaction logic. **Note:** `issueDocument` itself takes no idempotency key — a retried issue is refused by the immutability check rather than returning the original outcome (see §3.4).                                                                                                                                                     |
| I — Payment representation                    | **Holds on integrity, gap on labeling** | Payments are rows; status is derived only from recorded rows (a redirect cannot mark an invoice paid); void invoices refuse payments; reversal is non-destructive and audited; no gateway integration exists. **Gap:** nothing labels a record as manually recorded (§3.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Gate — tests                                  | **Mostly holds**                        | `phase05-documents.test.ts` (46 cases): exact arithmetic incl. 0.1+0.2, discount clamping, per-rate grouping, derived statuses, transition refusals, numbering composition parity, snapshot freezing, deterministic PDF, conversion idempotency, download authorization for staff and portal. Two gate items are implemented but not test-proven (§3.6).                                                                                                                                                                                                                                                                                                                                                                                                            |

## 3. Real gaps

### 3.1 (A, B) A catalogue item with no tax classification is silently priced at 0%

In `services/documents/lines.ts`, tax resolution for a catalogue line is:
item's own classification wins, else the line's explicit `taxRateId`, else
`taxRate = "0"` with `taxName = null` (lines 461–470 and the initializers at
361–362). There is no refusal, no warning, and no business-default tier. This
is precisely what the directive forbids: "Never silently treat an unknown or
missing tax classification as zero-rated or exempt."

### 3.2 (A) The business-level default tax exists in the schema but is never consumed

`TaxCategory.isDefault` (`schema.prisma:457`) is written by nothing and read by
nothing in the document engine — a grep for `isDefault` finds only
contact-address and item-form uses. The directive requires tax configuration at
**both** the business and item levels; today only item-level assignment
(`Item.taxRateId`) and per-line override exist. A tenant's default treatment
never reaches a line.

### 3.3 (A, B) Tax-rate validity windows are not enforced at pricing time

`TaxRate` carries `effectiveFrom` / `effectiveTo` / `isActive`, and the tax CRUD
actions maintain them (`actions/item.ts:149–153`, lists filter `isActive: true`
at line 308). But the pricing path reads the relation and the rates without any
validity predicate (`lines.ts` `ITEM_SELECT` and the `taxRate.findMany` at
327–333). A retired or expired rate still prices lines. Everything else is
re-verified at document time (ownership, existence, item status); rate validity
is the one check missing from that family.

### 3.4 (A, B) No explicit classification vocabulary

"Taxable / exempt / zero-rated / other" exist only as free-text category names
("VAT", "WHT", "EXEMPT") plus a numeric fraction. A 0% rate is indistinguishable
from "not classified", and the source of an applied treatment (item vs line vs
business default) is not identified anywhere user-visible — price provenance is
(`priceSources` + audit summary), tax provenance is only the copied
`taxRateId`/`taxName` pair on the line.

### 3.5 (E) Time-based transitions never run on their own

`deriveInvoiceStatus` (OVERDUE) is applied only inside `recordPayment` and
`reversePayment`; quotation EXPIRED is a manual decision only. There is no
scheduled job anywhere in the app (`grep` for sweep/cron/schedule: only a
comment in `tenant-lifecycle.ts` saying there is none). An invoice whose due
date passed shows ISSUED in the list until some unrelated write touches it. The
directive's "Invoices move to Overdue based on approved due-date rules" needs
either a read-path derivation or a sweep; the machine already knows the rule —
nothing applies it over time.

### 3.6 (I) Manual payment records are not labeled as such

`DocumentPayment` has amount/occurredOn/method/reference/note/reversal columns —
no `source` or `recordedBy` marker distinguishing "entered by a person" from a
future gateway verification. All current methods are manual-entry enums, so the
de-facto state is correct, but the directive's labeling requirement is unmet and
a schema addition + migration is the honest fix.

### 3.7 (H, design note) Retried issuance refuses instead of replaying

A second `issueDocument` on the same draft fails with IMMUTABLE. No duplicate
issued document can be produced (the gate's actual requirement), but the retry
does not return the original number; the caller sees an error. Either this is
documented as intentional (refusal-as-protection) or issuance grows an
idempotency key that replays the original outcome. Owner decision.

### 3.8 (Gate) Two implemented properties have no test proof

- **Concurrent issuance produces unique numbers**: the guarantee lives in the
  database (`FOR UPDATE` + unique index); the vitest suite mocks Prisma and
  cannot prove it. Needs the real-DB integration harness (`#37`), currently
  skipped without `TEST_DATABASE_URL`.
- **Expired/retired tax rate refused**: untested (the behavior itself is
  missing, §3.3).

## 4. The blocker: nearly every fix lands in reserved files

Another agent has reserved `apps/web/src/server/services/documents/*.ts` and
`apps/web/src/server/actions/document*.ts` ("do not modify or create … until I
give the all-clear"), has `Contact`/`ContactItem`/`Item` explicitly not frozen,
is mid-remodel on `/app/{items,contacts}/`, and has asked that no tests be added
or revalidated against contact, item or document surfaces.

| Gap                          | Files it needs                                                                         | Reserved?                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| §3.1 silent 0%               | `services/documents/lines.ts` (+ pure helper in `packages/documents`)                  | Yes                                                                                 |
| §3.2 business default        | `services/documents/lines.ts`, possibly schema                                         | Yes                                                                                 |
| §3.3 rate validity           | `services/documents/lines.ts`                                                          | Yes                                                                                 |
| §3.4 vocabulary + provenance | `packages/documents` + `services/documents/lines.ts` + snapshot shape                  | Partially (snapshot shape change bumps `DOCUMENT_SNAPSHOT_VERSION`)                 |
| §3.5 time-based transitions  | `services/documents/lifecycle.ts` / `service.ts` or a new read-path derivation + sweep | Yes                                                                                 |
| §3.6 payment labeling        | `prisma/schema.prisma` + migration + `services/documents/service.ts`                   | Partially (schema is shared and dirty with other agents' work; service is reserved) |
| §3.7 issue idempotency       | `services/documents/service.ts` + actions                                              | Yes                                                                                 |

Pure additions to `packages/documents/src/*` are not reserved, but every wiring
point and every test that would prove them sits in the reserved/mid-remodel
surfaces, so landing them now would produce unwired code and test debt against
an explicit coordination request.

## 5. Recommendation

1. **Hold all edits** until the reserving agent's all-clear, and hand them this
   report so the gaps (§3.1–§3.5 in particular) can be folded into or sequenced
   after the contact/item remodel — the two efforts touch the same resolver.
2. When unblocked, close in this order: §3.3 (small, closes a real correctness
   hole) → §3.1 + §3.2 + §3.4 together (one tax-precedence design: refuse
   unknown, honor business default, stamp source) → §3.5 (read-path derivation
   or sweep; sweep needs an owner decision on where jobs run) → §3.6 (schema +
   migration) → §3.7 (owner decision, possibly "documented as-is") → §3.8 (live
   DB tests once `#38`/`#37` unlock the harness).
3. No compliance claim accompanies any of this: nothing here establishes legal
   tax compliance, and no eTIMS transmission exists or is planned in this work.

Per standing rule, no changes were committed. The two AGENT 4 record documents
(`docs/implementation/phase-checklist.md`, `docs/IMPLEMENTATION_STATUS.md`)
remain uncommitted from the previous phase, on offer.
