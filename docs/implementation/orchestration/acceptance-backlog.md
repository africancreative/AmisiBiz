# Production Acceptance Backlog — Orchestrator Step 1

Date: 2026-10-18
Mandate: lead engineering agent for the AmisiBiz production MVP, per the Final
Orchestrator Prompt (§16). This document is Step 1 (factual implementation
backlog) and the status half of Step 10's acceptance matrix, maintained from
here forward. Companion document: `frozen-contracts.md` (Step 2).

Honesty rules adopted verbatim: no phase is reported COMPLETE on the strength
of generated code or a passing build; every claim below cites executed
verification or names the evidence that does not yet exist. The current
program verdict is **PARTIAL — one critical defect (C1) blocks the database
acceptance row**, per `../agent-7-release-report.md`. **UPDATE 2026-10-18
(late): C1 is CLOSED on live Neon** — migration
`20261029000000_c1_completion_subscription_reform` (R5 reform) built,
offline-proven (deploy 22/22, empty diff, SCHEMA-IDENTICAL reconciliation
replica), and applied to the live project with owner authorization after
out-of-band drift SQL was discovered there; live-vs-datamodel diff is now
empty and `migrate status` is up to date at 22/22. Record:
`../c1-neon-reconciliation.sql`. The program verdict moves to **PARTIAL —
H1 (permission-catalog seed drift) + Step 4–10 closures remain**; rows 2, 3,
4, 6, 13, 14, 15 below are updated accordingly.

Excerpt note: the directive references "the approved architecture and the
seven specialist-agent scopes in this document." Sections covering Agent
scopes 1–3 were not included in the received excerpt (Agent 0 checklist,
AGENT 4–7 directives were received earlier). Work is therefore organized by
acceptance-matrix area, and the freeze below binds the contracts those scopes
would have had to share anyway. If the owner supplies the scope texts, they
map onto this backlog without changing it.

Scope guards for release 1 (binding): no eTIMS transmission, no automated
payment gateways, no POS, no custom domains, no native offline applications.
The Phase 6 offline track (#61–65) and interrupted Phase 7 stay out of R1.

---

## 1. Matrix status (evidence-based)

Verdicts: **SATISFIED** (evidence exists), **PARTIAL**, **OPEN**. Evidence
sources: A7 = `../agent-7-release-report.md`; A0 = `../agent-0-canonical-data-model-audit.md`;
UX = `../ui-ux-standards-conformance-audit.md`; A5 = `../agent-5-financial-rules-gap-analysis.md`;
A6 = `../agent-6-pdf-portal-gap-analysis.md`.

| #   | Area                  | Verdict                     | Evidence / gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository foundation | PARTIAL                     | `pnpm type-check` (10 tasks), lint, test:run, build, check:bundles all green at HEAD 8cd1d4b (A7 §1). **format:check red on two committed files (M2)**. Architecture documented (docs/architecture/).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | Neon database         | SATISFIED (2026-10-18)      | Live Neon project `ep-dawn-breeze-b8oji9oi` at **22/22 migrations, `migrate status` up to date, live-vs-datamodel diff EMPTY**. C1 closed: migration `20261029000000_c1_completion_subscription_reform` (R5 reform: enum status, camelCase, planId RESTRICT, changedBy UUID FK, CHECKs, RLS + narrowed grants) was offline-proven then applied via owner-authorized single-transaction reconciliation after out-of-band drift SQL (`../agent-7-schema-drift.sql` shape: snake_case, free-text status, planId SET NULL-vs-NOT NULL, no RLS) was discovered pre-applied on live — record `../c1-neon-reconciliation.sql`, replica proven SCHEMA-IDENTICAL to the clean chain. Residual (not C1): permission-catalog seed parity on live re-checks under H1 (#87); RLS binds `amisibiz_app` — runtime enforcement still needs the scoped `APP_DATABASE_URL` connection (owner-side). |
| 3   | Authentication        | PARTIAL                     | Native credentials + signed session cookie with `sessionVersion` revocation; login/logout/reset flows exist; sessions 7 days for all roles (expiry policy decision open, A6 §3.2). ~~Fresh-deploy auth is broken by C1~~ **C1 closed 2026-10-18: `passwordHash` is live (migration 22)** — login is now DB-viable; production still needs the owner-side env (`AUTH_SECRET` ≥32 chars at minimum).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | Tenant isolation      | PARTIAL                     | 33-proof real-DB RLS harness: **31/33 on the completed 22-migration chain** (the two Subscription-RLS proofs pass since migration 22); the 2 remaining failures are the H1 catalog gap (row 14, #87). No cross-tenant access defect found in the passing proofs + AGENT 7 manual attempts (A7 §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | Control Centre        | SATISFIED                   | `/admin` console: tenant CRUD, invitations, plan assignment, domains, numbering, branding, lifecycle — all platform-gated, audited, i18n'd (A7 §4, UX §1). Residual: orphan `/platform` duplicate console (UX V1, #82).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | Subscription policy   | SATISFIED                   | R5 **RESOLVED: reform** (owner ruling 2026-10-18) — `Subscription`/`SubscriptionStatusHistory` are live with the reformed schema (enum status, camelCase, planId RESTRICT, changedBy UUID FK, ordered-period CHECKs, RLS tenant-read/admin-write, append-only admin-only history). Still schema-only with zero app consumers — any consumer code remains future scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7   | Branding              | PARTIAL                     | Tenant-scoped self-service form + preview + logo upload (validated both sides). **~34 hardcoded English strings (task #71)**; portal-side branding rendering from snapshot verified (A6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | CRM & catalogue       | PARTIAL                     | Contacts/items/addresses/agreements persist with tenant-scoped uniqueness (A0 §2.2). **Peer remodel in flight** (`DocumentItem`/`DocumentContactItem` target shapes); pricing resolver repoint tracked (#72); tests on these surfaces barred until all-clear. Customer-specific pricing works end-to-end (resolver parity, UX §1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9   | Tax & currency        | PARTIAL                     | Decimal-safe engine (18,4 money; string arithmetic; frozen rounding policy; CHECK-enforced totals); explicit currency on documents. **Open behavioral gaps: silent 0% on unclassified items, dead `isDefault`, validity windows unchecked at pricing, no transition sweep, unlabeled manual payments (A5 §3.1–3.7, fixes in #75, blocked by reservation).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Documents             | SATISFIED                   | Transactional numbering (`SELECT … FOR UPDATE` + unique backstop), immutable issued snapshots, CHECK-constrained totals, valid per-type transitions with append-only event log (phase05 battery: 78 PASS / 0 FAIL offline; A7 §2). Issue-retry refusal vs replay is an owner decision (A5 §3.7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | PDFs                  | PARTIAL                     | Authorization before every download (workspace + portal routes); PDFs stream on demand from frozen snapshots; **private storage NOT operational — no provider configured (A6 §3.1). The matrix requires private storage, so the provider decision is now on the R1 critical path.** No eTIMS claims anywhere (grep-verified).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 12  | Customer portal       | PARTIAL                     | Explicit linkage (`Contact.portalUserId` + portal role, one account ↔ one customer, per-request re-check, audited grant/revoke). **Link-based sharing model awaits the technical-lead ruling (A6 §3.4)**; portal UI localization gaps (UX V3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | Audit                 | SATISFIED (delivery caveat) | AuditLog across admin + financial actions; admin audit panels; append-only document events. The 4 audit columns + `correlationId` index are live since migration 22 (2026-10-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 14  | Security              | PARTIAL                     | **A7 NO-GO narrowed 2026-10-18: C1 CLOSED + H2 CLOSED on live Neon (Subscription RLS + narrowed grants live via migration 22); H1 remains — catalog seeds 42 vs the 57-key code matrix + SUPER_ADMIN matrix rows missing 6 keys (#87).** No unresolved critical exposure otherwise: no injection surface, 31/33 isolation proofs on the completed chain, validated uploads, private serving routes, server-side authorization throughout (A7 §4, UX §1).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 15  | Deployment            | OPEN                        | No deploy performed; no production approval (none may be presumed). **Migration path repaired 2026-10-18: live Neon is at 22/22 with an empty live-vs-datamodel diff**; env template documents all runtime keys incl. the Neon injected-key aliases (#86); deployment target is the Neon project (owner-supplied strings); production login additionally needs `AUTH_SECRET` (owner-side, fail-closed by design).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 2. Sequenced backlog (Steps 3–10)

Each item names its blocker. "Owner" items are decisions or external
configuration only the owner can supply; the orchestrator proceeds with
everything not blocked.

**Step 3 — Foundation**

0. **P0 repair (added 2026-10-18, post-freeze): revert the three v0-agent
   commits (`f82a3f4`, `8708189`, `d5d7b12`) that origin/main received
   after the Step 1–2 freeze.** They do not compile (type-check: 9 errors —
   imports of `@/lib/supabase/server` and `@/lib/supabase/middleware`, which
   do not exist in the tree, plus five uses of the deleted
   `requireDatabaseEnv`/`getDatabaseUrl` exports), and they silently revert
   the Supabase removal: `packages/database/src/env.ts` lost the
   `DATABASE_URL`/`DIRECT_URL`/`APP_DATABASE_URL` schema to a Supabase schema;
   `session-user.ts` and `middleware.ts` were wholesale replaced with the
   pre-`2fff426` Supabase auth stack (native signed-cookie resolution gone;
   `getSessionUser` returns null without Supabase env); `/portal` was dropped
   from middleware-protected routes. No Supabase dependency exists in
   `package.json`. The one forward-compatible idea — `client.ts`'s cascade of
   Neon-integration injected keys (`POSTGRES_PRISMA_URL[_2]`,
   `POSTGRES_URL[_2]`, `POSTGRES_URL_NON_POOLING[_2]`,
   `DATABASE_URL_UNPOOLED[_2]`, `DATABASE_URL[_2]`) — is folded into item 4
   as a designed change, with the standing caveat that owner-credential
   fallbacks are RLS-inert and dev-only; runtime requires
   `APP_DATABASE_URL`. **RESOLVED 2026-10-18 by owner ruling ("We are using
   the neon database so remove any supabase implementation"): executed as
   atomic revert `608a0f4`; post-revert gates green (type-check 10/10, tests
   538 passed/33 skipped, supabase sweep clean).**

1. R5 ruling: drop vs reform `Subscription*` (owner; blocks the completion
   migration's content). **RESOLVED 2026-10-18: REFORM** (owner ruling "R5
   rulling reform").
2. Write the C1 completion migration: replace the five comment-only shells by
   ONE new migration (never an edit) carrying the already-committed schema —
   `passwordHash`, audit columns, 17 branding columns — plus RLS policies for
   whatever remains. Offline-verify first (throwaway cluster: deploy 21→new,
   checks battery, RLS battery, empty diff). _(Blocked by 1.)_ **DONE
   2026-10-18:** `20261029000000_c1_completion_subscription_reform` (R5
   reform) — offline-proven (fresh-DB deploy 22/22, empty diff vs datamodel,
   33-proof harness 31/33 with only the H1 failures), then applied to live
   Neon with explicit owner authorization. Live had the Agent 7 drift SQL
   pre-applied out-of-band (drift-shape Subscription tables, no enum, no
   RLS, broken planId SET NULL-vs-NOT NULL FK, empty tables), so verbatim
   deploy was impossible; a guarded single-transaction reconciliation
   (`../c1-neon-reconciliation.sql`) converged live — replica proven
   SCHEMA-IDENTICAL to the clean chain by pg_dump diff — and migration 22
   was recorded via `prisma migrate resolve --applied`. Live verification:
   `migrate status` up to date 22/22, live-vs-datamodel diff empty, enum +
   5 policies + RLS + grants + CHECKs probed present.
3. Fix M2: format the two red files; re-run the full gate. **DONE 2026-10-18
   — `6db97d8` (format-only reflow; full gate re-executed green).**
4. Resolve env authority for R1: which instance is the matrix's "Neon
   database" (owner decision — §4 unchanged); refresh `.env.example` to all
   runtime keys. **Template work DONE 2026-10-18 — #86 (this commit):**
   `.env.example` now documents every runtime key including
   `STRICT_APP_ROLE` and `TEST_DATABASE_URL`, and the Neon injected-key
   cascade is implemented in `@amisibiz/database` (pooled-preferred fixed
   order, unpooled injections stand in for `DIRECT_URL`, empty keys treated
   as absent, messages never echo values; `APP_DATABASE_URL` still wins at
   runtime and the production `STRICT_APP_ROLE` refusal is unchanged).

**Step 4 — Tenant security**

5. H1: reseed the permission catalog to the 57-key code matrix + parity tests
   (part of the completion migration or its successor).
6. R1 same-tenant composite FKs (A0 register) — sequenced AFTER the remodel
   lands so `Contact`/`Item` shapes are final. _(Blocked by peer all-clear.)_
7. Re-run the 33-proof harness to 33/33 on the completed migration chain.

**Step 5–8 — Feature closures** (all gated on the peer all-clear plus the
owner decisions below)

8. A5 gaps in reservation order: rate-validity → tax precedence/vocabulary →
   time-based transitions → payment labeling (#75); issue-retry per ruling.
9. DocumentItem/DocumentContactItem remodel lands; repoint resolver (#72);
   then customer-specific pricing + cross-tenant tests on the new shapes.
10. A6: portal session-expiry decision; draft-download 409→404; portal i18n;
    sharing-model ruling; **storage provider selection → implement private
    object storage + integration tests** (critical path for row 11).
11. UX findings: retire `/platform` (#82, owner nod); invite-delivery copy or
    implementation (V2); branding + document-detail i18n (#71, #83); delete
    dead placeholder component.

**Step 9 — Independent verification**

12. Re-run Agent 7's full gate (static commands + real-DB harness + bundle
    scan + audit) against the integrated tree; fix findings; rerun.

**Step 10 — Release decision**

13. Produce the final acceptance matrix (this document, updated) + final
    release report in the reporting format. **No deployment without explicit
    owner approval.**

## 3. Reporting format (adopted for every phase report)

Phase and agent · requirements addressed · existing functionality reused ·
files created/changed · migrations created · tests executed with actual
results · security evidence · known defects · external configuration still
required · completion status (COMPLETE/PARTIAL/BLOCKED) · the exact next
dependency. No COMPLETE verdict without executed verification.

## 4. External configuration required from the owner

1. ~~**Neon instance + connection strings**~~ **SUPPLIED 2026-10-18:** the
   owner provided live pooled + unpooled Neon strings (project
   `ep-dawn-breeze-b8oji9oi`); the app-side alias support shipped in #86.
   Still owner-side: Supabase retirement decision, and rotating the Neon
   owner password (it transited chat in plaintext).
2. ~~R5: drop vs reform `Subscription*`~~ **RESOLVED 2026-10-18: reform**
   (migration 22, live).
   2b. Production env for the deployed app: `AUTH_SECRET` (≥32 chars,
   Production scope) at minimum; recommended alongside:
   `APP_DATABASE_URL` (scoped `amisibiz_app` role — this is also what makes
   the now-live RLS policies actually bind at runtime) and
   `STRICT_APP_ROLE="true"`.
3. Storage provider + deployment target for private PDF storage. _(Blocks row
   11 acceptance.)_
4. Sharing-model ruling (technical lead) for the portal link model. _(Blocks
   row 12 acceptance.)_
5. Invitation delivery for R1: email transport, out-of-band, or explicit
   unavailable-state copy. _(Blocks row 5's invitation leg being called
   complete.)_
6. Issue-idempotency ruling (A5 §3.7); `/platform` retirement nod (UX V1).
7. Peer all-clear on the reserved document surfaces + contact/item remodel
   landing. _(Blocks items 6, 8, 9 and the document-adjacent i18n.)_
8. Production deployment approval — explicitly withheld until Step 10.
