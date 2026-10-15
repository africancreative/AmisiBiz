# Phase 07 — audit viewer & observability

- **Date:** 2026-10-15
- **Directive (checkbox line):** "central `lib/audit` writer (done); audit viewer for
  platform/tenant admins; structured redacting logger; error tracking."
- **Acceptance line:** "privileged actions emit audit rows; viewer permission-gated;
  no secrets/PII leakage in logs."
- **Depends on:** Phase 03.
- **Status word:** a **build-and-verify record, not a completion claim.** Every gate
  number below was produced on this tree with the command quoted in §7. The
  behavioural tests drive the real Server Actions against a mocked Prisma client and
  assert the query arguments; nothing here is a claim about the live Supabase project.
- **Standing security context, unchanged by this phase:** RLS is still **inert in the
  deployed app**. The controls that hold are the application-layer authorization
  checks and the tenant-pinned `WHERE` clauses.

---

## 1. What the phase asked, and where it lives

| Phase clause                                        | Where it lives                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Central audit writer (already existed)              | `apps/web/src/lib/audit/index.ts` — `recordAudit`, `AUDIT_ACTIONS`, `appendAuditLog`       |
| No credential-shaped key survives in audit metadata | `apps/web/src/lib/redaction.ts` (recursive) + `sanitizeAuditMetadata` in the writer        |
| Structured, redacting logger                        | `apps/web/src/lib/logger.ts` — `createLogger`, `logger`                                    |
| Error tracking with a safe correlation handle       | `apps/web/src/lib/error-tracking.ts` — `reportError`                                       |
| Error boundaries route through the tracker          | `apps/web/src/app/[locale]/error.tsx`, `apps/web/src/app/global-error.tsx`                 |
| Tenant audit viewer (owner/admin + support grant)   | `/[locale]/app/settings/audit` + `getAuditLogAction`                                       |
| Platform audit viewer (cross-tenant provider)       | `/[locale]/platform/audit` + `getPlatformAuditLogAction`                                   |
| Query validation / bounded filters                  | `apps/web/src/lib/validations/audit.ts`                                                    |
| Tests + documentation                               | `tests/phase07-audit-observability.test.ts`; this report; `phase-checklist.md` §"Phase 07" |

---

## 2. The audit writer, and the defect this phase closed

`recordAudit` already existed and is called from every privileged path (auth,
tenant lifecycle, team, membership, provider console, support grants, suspension
denials). The single real gap was in **`sanitize`**: it walked only the **top level**
of `metadata`, so `{ user: { password } }` or an array of payloads passed straight
through into the persisted row.

Redaction now lives in its own tiny isomorphic module, `lib/redaction.ts`, and it
recurses:

- matching is case-insensitive **substring** matching on the key name, so `accessToken`,
  `tokenHash`, `refresh_token` and `stripeSecretKey` are all caught by `token`/`secret`;
- a sensitive key is **omitted**, not replaced with a marker — dropping it hides both
  the value and the fact that a caller tried to record one, and keeps the stored shape
  equal to the shape a careful caller would have written;
- the walk bounds its depth and treats a repeated object as `"[circular]"` rather than
  recursing forever; a `Date` becomes an ISO string and a `BigInt` becomes text so the
  payload is always serialisable.

The pre-existing audit-hygiene test (`tests/security.test.ts`, "never persists a
credential-shaped key") asserts the **surviving key list**, which is exactly why the
"omit" semantics were preserved; the new Phase 07 test adds the nested and
array cases on top.

> The writer's `AUDIT_ACTIONS` vocabulary is unchanged. Per the change-control note,
> `AuditLog.action` values are never renamed.

---

## 3. Structured logger

`lib/logger.ts` gives the constitution's "no secret or unnecessary PII reaches a log
sink" rule **one enforcement point** instead of relying on every call site.

- `createLogger(scope)` returns `debug` / `info` / `warn` / `error` plus `child()` for
  a `"<parent>:<child>"` scope; a root `logger` exists for one-off events.
- Production emits **one JSON object per line** (`level`, `time`, `scope`, `message`,
  `context`) so a log platform can index without a regex. Elsewhere it emits a readable
  `[scope] message` line plus the context.
- Context is passed through the **same** recursive `redactValue` the audit writer uses.
  That is the point of extracting `lib/redaction.ts`: if the logger carried its own
  list, the two would drift and a credential could be redacted from the audit trail but
  printed to stdout.
- Level defaults to `debug` outside production and `info` in it, overridable with
  `LOG_LEVEL`.
- The module imports **nothing server-only** (only the pure redaction helper), so a
  client error boundary and a Server Action share the rule and the output shape.

---

## 4. Error tracking

`reportError(error, { digest?, scope?, context? })` is the single boundary every
unexpected throw routes through. It:

- returns `{ correlationId, name, digest? }` — a safe handle to quote in a support
  ticket or search a log sink for, **never** the raw error;
- emits a structured, redacted event through the logger;
- includes the error `message` and `stack` **only when `NODE_ENV === "development"`**;
  in every other environment the event carries the error `name` and Next.js's `digest`
  (a hash the framework attaches and shows to the user), which is enough to correlate a
  report with a server line and nothing more;
- never throws, so a failing reporter cannot mask the original failure.

`global-error.tsx` was added (it replaces the root layout when that itself fails, so it
renders its own `<html>`/`<body>` with inline styles and static English), and the
locale boundary now calls `reportError` instead of `console.error`.

**Explicit boundary:** no error-tracking SaaS is wired. Doing so needs a vendor account
and a credential, and the project's rule is that an integration is not claimed until its
credentials and protocol are verified. `reportError` defines the shape a backend would
consume; pointing it at one is a Phase 08 task.

---

## 5. The viewers

Both viewers are one client component, `components/audit/audit-log-viewer.tsx`, over
two Server Actions. The two audiences differ only in the action called and whether a
tenant selector is offered:

- **Tenant** (`/[locale]/app/settings/audit`): gated by `authorizeTenant(..., AUDIT_READ)`.
  Only `TENANT_OWNER` and `TENANT_ADMIN` hold it, plus a provider holding an active
  support grant (read-only, and each use is already audited as `support.accessUsed`).
  The `tenantId` in the request locates the membership that authorizes it; the **query**
  filter is the authorized `context.tenantId`, so a forged id reads nothing (no
  membership → denied before any audit read).
- **Platform** (`/[locale]/platform/audit`): gated by
  `authorizePlatform(..., PLATFORM_AUDIT_READ)`, held by SUPER_ADMIN only. Support is
  deliberately **not** given a global view — a support engagement is scoped to one
  workspace at a time, and that is enforced by the permission, not by convention.

Filters are action substring, resource substring, actor id, an optional tenant
(platform only) and a `from`/`to` window; ordering is `createdAt desc, id desc` so paging
cannot repeat or skip a row sharing a coarse timestamp. `lib/validations/audit.ts`
bounds `pageSize` to 100 and the free-text filters, and rejects an inverted window.

**Reads are not self-audited.** Walking the trail must not append to the trail it is
walking, or a viewer would grow the table every time it is opened; this matches the rest
of the read surface. The event that needs evidence — a provider reading a workspace —
is already recorded by `authorizeTenant`.

---

## 6. Tests

`tests/phase07-audit-observability.test.ts` — **9 tests**:

- logger redaction, including a secret nested two levels deep and inside an array;
- recursive audit redaction (`tokenHash` at depth, an array element's `secret`),
  asserting the innocuous neighbours survive;
- `reportError` returns the digest as the correlation id and **does not** surface the
  raw message when not in development;
- `getAuditLogAction` denies without `audit.read`;
- `getAuditLogAction` scopes the query to the authorized tenant;
- `getPlatformAuditLogAction` requires `platform.audit.read`;
- `getPlatformAuditLogAction` reads across tenants for SUPER_ADMIN and stays open when
  no tenant filter is given;
- a forged tenant id is denied and **nothing is read**;
- an out-of-bounds `pageSize` is rejected as `VALIDATION_ERROR` before authorization,
  and nothing is read.

---

## 7. Gates

Run from the repository root on this tree:

- `pnpm format:check` — **clean**.
- `pnpm --filter @amisibiz/web lint` — **clean** (one pre-existing `no-img-element`
  warning in `tenant-branding-panel.tsx`, unrelated to this phase).
- `pnpm --filter @amisibiz/web type-check` — **clean**.
- `pnpm turbo run test:run --filter=@amisibiz/web` — **407 passed / 26 skipped** (433)
  across 16 files (was 398 / 26; **+9** from this phase).
- `pnpm --filter @amisibiz/web build` — **succeeds**; the route table includes
  `/[locale]/app/settings/audit` and `/[locale]/platform/audit` in en/fr/sw.

---

## 8. Honest limits

- **Not browser-exercised.** Both viewers are build- and type-clean and unit-tested at
  the action layer, but have not been driven in a browser against real audit rows.
- **No external error-tracking backend** — by design, for the credential reason above.
- **The tenant viewer shows actor email and client IP/UA** because that is what an
  investigation needs and only owner/admin (or a granted provider) can open it; if a
  narrower default is wanted, that is a policy change, not an implementation fix.
- **RLS stays inert**, so "a platform admin may read across tenants" is an
  application-layer claim today.
- **The audit viewer does not render `metadata`.** The list shows when/action/actor/
  tenant/resource; a per-event detail panel that renders the (already redacted)
  metadata is a natural follow-up, not part of this phase.

---

## 9. Dependencies

Phase 03 (business workspace, CRM, items) supplies the privileged paths whose actions
already emit audit rows; Phase 01/02 supply `AUDIT_ACTIONS`, the `audit.read` /
`platform.audit.read` permissions and the `authorizeTenant` / `authorizePlatform`
enforcement pattern this phase reuses unchanged.
