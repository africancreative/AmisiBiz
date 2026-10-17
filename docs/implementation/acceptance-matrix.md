# AmisiBiz — Acceptance Matrix

- **Status:** As-built acceptance record at `main` @ `ddcdec9`, 2026-10-17.
- **Purpose:** one table that states, per capability, whether it is accepted,
  under what evidence, and what still blocks it. Distinguishes **code-present**
  from **proof-present** (tests / DB / deployment).
- **Companions:** `agent-work-plan.md` (the plan that moves ⛔/⚠️ rows to ✅),
  `../architecture/system-overview.md`, `../architecture/data-model.md`,
  `../architecture/security-model.md`.

## Legend

| Mark | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| ✅   | Implemented **and** proven by an automated test in the current tree        |
| 🟡   | Implemented; proof is partial (write-path only, or no dedicated test)      |
| ⚠️   | Implemented but with a known gap, drift, or unverified runtime requirement |
| ⛔   | Not implemented                                                            |
| ⏭️   | Intentionally out of MVP scope / deferred                                  |

"Proven" means the **mocked unit/contract suite** unless the row says otherwise.
The DB-backed RLS harness (33 cases) and any deployment claim are called out
explicitly and are **not** implied by ✅.

---

## A. Platform administration

| #   | Capability                                                 | Status | Evidence / gap                                                                               |
| --- | ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| A1  | Provision tenant (PENDING)                                 | ✅     | `tests/phase02*`, `phase03*`; `server/actions/tenant.ts`                                     |
| A2  | Activate tenant (`PENDING→ACTIVE`)                         | ✅     | status-guarded `updateMany`; `tenant-lifecycle.ts`                                           |
| A3  | Suspend / reactivate (writes+sync denied, reads preserved) | ✅     | `security-model.md` §14; `phase02` tests                                                     |
| A4  | Tenant status history                                      | ✅     | `TenantStatusHistory`; lifecycle tests                                                       |
| A5  | Tenant list / search / pagination                          | 🟡     | `admin/tenants`, `platform`; UI-level                                                        |
| A6  | Tenant detail (domains, plan, numbering, branding)         | 🟡     | rendered from real queries; no page-level test                                               |
| A7  | Support access grant (read-only, time-boxed)               | ✅     | `support-access.ts`; `phase03*` tests                                                        |
| A8  | Cross-tenant audit viewer                                  | ✅     | `phase07-audit-observability.test.ts`                                                        |
| A9  | Plan catalogue management                                  | 🟡     | `Plan` model + seed; limited UI                                                              |
| A10 | Subscription lifecycle                                     | ⚠️     | `Subscription` exists; `status` is `String`, no entitlement enforcement (`data-model.md` §5) |
| A11 | Single platform shell/IA                                   | ⚠️     | two overlapping trees `platform/*` + `admin/*` (`agent-work-plan.md` P2-3)                   |

## B. Tenant business workspace

| #   | Capability                                      | Status | Evidence / gap                                                                                   |
| --- | ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| B1  | Contacts CRUD + addresses                       | ✅     | `phase04` tests; `server/actions/contact.ts`                                                     |
| B2  | Catalogue items CRUD                            | ✅     | `phase04` tests; `items`                                                                         |
| B3  | Customer-specific pricing (`ContactItem`)       | ✅     | `contact-item.ts`; `phase04` tests                                                               |
| B4  | Tax categories & rates                          | ✅     | `TaxCategory`/`TaxRate`; `phase04`                                                               |
| B5  | Documents — quotation / invoice / delivery note | ✅     | `documents/*` services; `phase05*` tests                                                         |
| B6  | Document numbering (atomic, period-aware)       | ✅     | `allocate_document_number`; `phase05`                                                            |
| B7  | Document lifecycle & immutable issued snapshot  | ✅     | `snapshot`; `lifecycle.ts`; `phase05`                                                            |
| B8  | Payments + derived PAID/PARTIALLY_PAID          | ✅     | `DocumentPayment`; `phase05`                                                                     |
| B9  | Document PDF render                             | 🟡     | route + `render.ts`; heavy path not unit-proven end-to-end                                       |
| B10 | Branding + WCAG contrast                        | ✅     | `branding-patch.ts`; `phase04` contrast tests                                                    |
| B11 | Tenant audit trail                              | ✅     | `phase07`                                                                                        |
| B12 | Team members + role management                  | 🟡     | `team`; guards in place; limited test                                                            |
| B13 | Member invitations                              | ⚠️     | `Invitation` model + hashing present; **no email delivery**, acceptance flow untested end-to-end |
| B14 | Workspace dashboard                             | ⚠️     | duplicates `/dashboard` (`agent-work-plan.md` P2-2)                                              |

## C. Customer portal

| #   | Capability                                   | Status | Evidence / gap                                                  |
| --- | -------------------------------------------- | ------ | --------------------------------------------------------------- |
| C1  | Portal sign-in (role `CUSTOMER_PORTAL_USER`) | ✅     | `phase` portal tests; `Contact.portalUserId`                    |
| C2  | Issued-document list (drafts excluded)       | ✅     | `portal.ts`; portal tests                                       |
| C3  | Portal PDF download with ownership check     | ✅     | `api/portal/documents/[id]/pdf`; portal tests                   |
| C4  | Portal access as a first-class model         | ⚠️     | implemented via `Contact.portalUserId` (owner decision pending) |

## D. Identity, security & tenancy

| #   | Capability                                      | Status | Evidence / gap                                                                                                                                                 |
| --- | ----------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Register (bcrypt cost 12)                       | ✅     | `security.test.ts` / auth tests                                                                                                                                |
| D2  | Login + HMAC session cookie                     | ✅     | `lib/auth/token.ts`; `phase01` tests                                                                                                                           |
| D3  | Session revocation via `sessionVersion`         | ✅     | `session.ts`; auth tests                                                                                                                                       |
| D4  | Forgot / reset password                         | 🟡     | token + action exist; **email delivery absent**                                                                                                                |
| D5  | Email verification end-to-end                   | ⛔     | no `/[locale]/verify-email`; `REQUIRE_EMAIL_VERIFICATION` not honoured                                                                                         |
| D6  | Permission catalogue ⇄ DB parity                | ✅     | parity test                                                                                                                                                    |
| D7  | Deny-by-default authorization + denial audit    | ✅     | `authorization.ts`; `phase01`, `phase03`, `phase07`                                                                                                            |
| D8  | Tenant hostname resolution (opt-in proxy trust) | ✅     | `lib/tenancy/host.ts`; `tests/tenancy.test.ts`; `tests/middleware-host.test.ts` (reserved label → 404; `X-Forwarded-Host` ignored)                             |
| D9  | Rate limiting (login/register/forgot/reset)     | ✅     | `security-utils.test.ts`; Redis/Upstash/memory                                                                                                                 |
| D10 | **RLS enforced at runtime**                     | ⚠️     | policies + triggers in schema **and** proven in CI as `amisibiz_app`; **deployed app activation is an operator step not yet done** (`security-model.md` §13.1) |
| D11 | No secret in client bundle                      | ✅     | CI `verify` bundle scan                                                                                                                                        |
| D12 | RLS harness (33 cases, real Postgres)           | ✅     | CI `security` job; skipped locally without `TEST_DATABASE_URL`                                                                                                 |
| D13 | DB-enforced cross-tenant integrity              | ✅     | `integration-security.test.ts` point-9 cases; BEFORE-triggers on Document/DocumentLine/ContactItem/TaxRate; portal-seat unique index                           |

## E. Platform / engineering

| #   | Capability                                  | Status | Evidence / gap                                                                                                                        |
| --- | ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Monorepo build (Turborepo)                  | ✅     | `pnpm build`                                                                                                                          |
| E2  | Type-check strict across workspaces         | ✅     | `pnpm type-check`                                                                                                                     |
| E3  | Lint + format gate                          | ✅     | CI `verify`                                                                                                                           |
| E4  | Unit/contract suite green                   | ✅     | 438 passed / 33 skipped (471), 2026-10-17                                                                                             |
| E5  | CI `security` job (historical pins/asserts) | ✅     | `.github/workflows/ci.yml`                                                                                                            |
| E6  | E2E / Playwright                            | ⛔     | none present; spec requires it                                                                                                        |
| E7  | Deployment config as code                   | ⚠️     | Vercel intended; **no `vercel.json`** in tree                                                                                         |
| E8  | Docs match the tree                         | ⚠️     | `system-design.md`, `README.md`, `phase-checklist.md`, `IMPLEMENTATION_STATUS.md`, schema comments behind (`agent-work-plan.md` P2-6) |
| E9  | Offline sync server (push/pull)             | ✅     | closed registry; sync tests                                                                                                           |
| E10 | Offline/mobile/desktop clients wired        | ⏭️     | storage layer tested; shells unbuilt; not in web                                                                                      |
| E11 | Live eTIMS/DPO/POS                          | ⏭️     | labelled mocks only                                                                                                                   |
| E12 | Billing / reports surfaces                  | ⏭️     | scope confirmation required                                                                                                           |

---

## Acceptance gate for starting major feature work

The repository has been inspected; existing functionality is documented;
schema and module boundaries are consistent; the sequence is clear; and
security-critical gaps are identified. **Gate condition to begin P1 feature work:**
the **P0 block** in `agent-work-plan.md` is closed, or the owner explicitly
accepts the residual risk of deferring any P0 item.

**Security-critical gaps (block a production pilot):** D10 (RLS runtime
activation), D4/D5 (email-dependent auth flows non-functional), E6 (no E2E).
