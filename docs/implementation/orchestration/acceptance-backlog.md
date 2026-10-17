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
acceptance row**, per `../agent-7-release-report.md`.

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

| #   | Area                  | Verdict                     | Evidence / gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository foundation | PARTIAL                     | `pnpm type-check` (10 tasks), lint, test:run, build, check:bundles all green at HEAD 8cd1d4b (A7 §1). **format:check red on two committed files (M2)**. Architecture documented (docs/architecture/).                                                                                                                                                                                                                                                                                           |
| 2   | Neon database         | OPEN                        | **C1 (critical): migrations 17–21 are comment-only shells — a fresh `prisma migrate deploy` silently omits `User.passwordHash`, `Subscription*`, 17 branding columns, 4 audit columns (A7 C1 + drift SQL).** Additionally the live project tracked so far is Supabase at 10/10; the matrix names Neon — whether a Neon instance exists and its connection strings are owner-side facts (§4). Offline verification procedure exists (throwaway cluster, 78-check battery, 67-proof RLS battery). |
| 3   | Authentication        | PARTIAL                     | Native credentials + signed session cookie with `sessionVersion` revocation; login/logout/reset flows exist; sessions 7 days for all roles (expiry policy decision open, A6 §3.2). Fresh-deploy auth is **broken by C1** (no `passwordHash` column).                                                                                                                                                                                                                                            |
| 4   | Tenant isolation      | PARTIAL                     | 33-proof real-DB RLS harness ran for the first time: **30 pass, 3 fail** — 2 fail for missing Subscription RLS (tables pending the R5 drop/reform ruling), 1 for stale catalog seeds (row 16). No cross-tenant access defect found in 30 proofs + AGENT 7 manual attempts (A7 §4).                                                                                                                                                                                                              |
| 5   | Control Centre        | SATISFIED                   | `/admin` console: tenant CRUD, invitations, plan assignment, domains, numbering, branding, lifecycle — all platform-gated, audited, i18n'd (A7 §4, UX §1). Residual: orphan `/platform` duplicate console (UX V1, #82).                                                                                                                                                                                                                                                                         |
| 6   | Subscription policy   | SATISFIED (pending R5)      | Manual plan assignment separated from activation; no auto-suspension path exists (Phase 2 directive honored; `platform.ts:836–839` audited). `Subscription*` models are schema-only with zero consumers — drop/reform ruling pending (A0 R5).                                                                                                                                                                                                                                                   |
| 7   | Branding              | PARTIAL                     | Tenant-scoped self-service form + preview + logo upload (validated both sides). **~34 hardcoded English strings (task #71)**; portal-side branding rendering from snapshot verified (A6).                                                                                                                                                                                                                                                                                                       |
| 8   | CRM & catalogue       | PARTIAL                     | Contacts/items/addresses/agreements persist with tenant-scoped uniqueness (A0 §2.2). **Peer remodel in flight** (`DocumentItem`/`DocumentContactItem` target shapes); pricing resolver repoint tracked (#72); tests on these surfaces barred until all-clear. Customer-specific pricing works end-to-end (resolver parity, UX §1).                                                                                                                                                              |
| 9   | Tax & currency        | PARTIAL                     | Decimal-safe engine (18,4 money; string arithmetic; frozen rounding policy; CHECK-enforced totals); explicit currency on documents. **Open behavioral gaps: silent 0% on unclassified items, dead `isDefault`, validity windows unchecked at pricing, no transition sweep, unlabeled manual payments (A5 §3.1–3.7, fixes in #75, blocked by reservation).**                                                                                                                                     |
| 10  | Documents             | SATISFIED                   | Transactional numbering (`SELECT … FOR UPDATE` + unique backstop), immutable issued snapshots, CHECK-constrained totals, valid per-type transitions with append-only event log (phase05 battery: 78 PASS / 0 FAIL offline; A7 §2). Issue-retry refusal vs replay is an owner decision (A5 §3.7).                                                                                                                                                                                                |
| 11  | PDFs                  | PARTIAL                     | Authorization before every download (workspace + portal routes); PDFs stream on demand from frozen snapshots; **private storage NOT operational — no provider configured (A6 §3.1). The matrix requires private storage, so the provider decision is now on the R1 critical path.** No eTIMS claims anywhere (grep-verified).                                                                                                                                                                   |
| 12  | Customer portal       | PARTIAL                     | Explicit linkage (`Contact.portalUserId` + portal role, one account ↔ one customer, per-request re-check, audited grant/revoke). **Link-based sharing model awaits the technical-lead ruling (A6 §3.4)**; portal UI localization gaps (UX V3).                                                                                                                                                                                                                                                  |
| 13  | Audit                 | SATISFIED (delivery caveat) | AuditLog across admin + financial actions; admin audit panels; append-only document events. 4 audit columns are shell-only (C1 carries them).                                                                                                                                                                                                                                                                                                                                                   |
| 14  | Security              | PARTIAL                     | **NO-GO stands (A7 §6): C1 + H1 (catalog 42 vs 57 seeds + matrix drift) + H2 (Subscription RLS absent).** No unresolved critical exposure otherwise: no injection surface, 30/33 isolation proofs, validated uploads, private serving routes, server-side authorization throughout (A7 §4, UX §1).                                                                                                                                                                                              |
| 15  | Deployment            | OPEN                        | No deploy performed; no production approval (none may be presumed). Migration path broken until C1 closes; env template documents 5 of 18 runtime keys (A7 L1); deployment target unconfirmed (§4).                                                                                                                                                                                                                                                                                             |

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
   `APP_DATABASE_URL`. _(Awaiting owner go-ahead: it rejects peer-agent work
   on a shared tree.)_

1. R5 ruling: drop vs reform `Subscription*` (owner; blocks the completion
   migration's content).
2. Write the C1 completion migration: replace the five comment-only shells by
   ONE new migration (never an edit) carrying the already-committed schema —
   `passwordHash`, audit columns, 17 branding columns — plus RLS policies for
   whatever remains. Offline-verify first (throwaway cluster: deploy 21→new,
   checks battery, RLS battery, empty diff). _(Blocked by 1.)_
3. Fix M2: format the two red files; re-run the full gate. _(Unblocked — first
   code change after this document is approved.)_
4. Resolve env authority for R1: which instance is the matrix's "Neon
   database"; refresh `.env.example` to cover all 18 runtime keys. _(Needs §4.)_

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

1. **Neon instance + connection strings** (pooled + direct), or confirmation
   that the tracked Supabase project is not the R1 target; retirement decision
   for it. _(Blocks rows 2 and 15.)_
2. R5: drop vs reform `Subscription*`. _(Blocks the C1 completion migration.)_
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
