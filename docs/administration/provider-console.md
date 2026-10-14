# AmisiBiz — Provider Console (administrator documentation)

- **Audience:** Amisi Genuine platform staff operating `/admin`.
- **Applies to:** the Phase 2 provider-administration surface (tenant
  provisioning, lifecycle, plan, branding, address, numbering, owner assignment,
  status history, audit trail and operational indicators).
- **Companion docs:** `../architecture/permission-matrix.md` (who may do what),
  `../architecture/security-model.md` §4.1 (what suspension means),
  `../RUNBOOK.md` (database and deployment operations),
  `../implementation/phase-02-provider-administration-report.md` (what was built
  and what was deliberately left out).

Everything below describes what the console **does today** in this repository. It
is written so an operator can predict what a button will do, what the database
will record, and what the console is not able to claim.

---

## 1. Getting in

| Route                          | What it shows                                      |
| ------------------------------ | -------------------------------------------------- |
| `/{locale}/admin`              | Workspace counts by status + most recently changed |
| `/{locale}/admin/tenants`      | Search, filters and the tenant list                |
| `/{locale}/admin/tenants/new`  | Provision a workspace                              |
| `/{locale}/admin/tenants/{id}` | Everything about one workspace (the panels below)  |

Access requires a signed-in account whose **`User.platformRole` is
`SUPER_ADMIN`** and whose `User.status` is `ACTIVE`. The layout checks
`platform.tenants.read` server-side, and every read model re-checks it — hiding a
button is never the control. Someone without it sees "Administrator access
required" and a link back to their own workspace.

Platform roles are **not self-serviceable**: `users_guard_update` refuses any
non-admin change to `platformRole`, `email` or `status`, so granting an operator
is a database action (`../RUNBOOK.md` §2), not a console feature. Tenant roles
(`TENANT_OWNER`, `SALES`, …) never appear here and never grant platform access.

Support staff (`SUPPORT`) hold **no** platform permissions, so they cannot open
this console at all. They reach a specific workspace through an expiring,
reason-bearing, audited `SupportAccessGrant` (see §8).

> The console shows workspace **configuration** only. Contacts, catalogue items,
> documents and other business rows are never selected by a provider query, and
> the list footnote states that plainly.

---

## 2. Provisioning a workspace

`/admin/tenants/new` → name, optional slug, optional initial-owner email, and the
workspace defaults (currency, timezone, locale, country).

- The workspace is created **`PENDING`** with its default settings, branding row,
  slug hostname and document-numbering series, all inside one transaction, and
  audited as `tenant.created`.
- A new workspace is **not usable** until someone activates it (§4). Nothing in
  provisioning grants access on its own.
- An owner email issues a `TENANT_OWNER` **invitation** (§7). The console never
  writes an owner membership directly from a typed address — the named person has
  to accept while signed in with that exact address.
- Slugs are validated (`^[a-z0-9]…$`, ≤ 63 chars, lower-cased) and checked
  against the reserved list (`www`, `admin`, `api`, `app`, `platform`, `support`,
  …). A reserved or taken slug is refused with a clear message; a
  one-character slug like `a` is legal.
- If no base domain (`APP_BASE_DOMAIN`) is configured for the deployment, the
  console says the workspace route cannot be shown rather than inventing one.

---

## 3. Finding a workspace

The list filters on free text (`q`, matched case-insensitively against name and
slug), status, and plan — plus `planId=none` for workspaces with no plan label.
Pagination takes `page` (1–10 000) and `pageSize` (1–100, default 25), and the
page links **preserve the filters you applied**. An unparseable filter (a forged
status, a non-UUID plan id) reads as "no filter" instead of throwing, and the
form re-shows what you submitted.

Each row carries status, slug, primary hostname, plan label, member count, the
indicators (§9) and the newest audit timestamp.

---

## 4. Verified list of implemented status transitions

This is the complete set. It is generated from
`TENANT_STATUS_TRANSITIONS` in
`apps/web/src/server/services/tenant-lifecycle.ts`, which is the single source
for the buttons rendered in the console, the refusals the Server Actions return,
and this table. If the three ever disagree, the table is wrong and the code is
right — fix the table.

| #   | Transition           | Permission required         | Audit action                 | Confirmation + reason | Effect                                                                                                                                     |
| --- | -------------------- | --------------------------- | ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `PENDING → ACTIVE`   | `platform.tenants.activate` | `platform.tenantActivated`   | yes / required        | The workspace opens to its members; `activatedAt`/`activatedById` are stamped                                                              |
| 2   | `ACTIVE → SUSPENDED` | `platform.tenants.suspend`  | `platform.tenantSuspended`   | yes / required        | New writes and synchronization are refused; reads and downloads keep working; `suspendedAt`/`suspendedById`/`suspensionReason` are stamped |
| 3   | `SUSPENDED → ACTIVE` | `platform.tenants.activate` | `platform.tenantReactivated` | yes / required        | Writes and synchronization resume; suspension bookkeeping is cleared                                                                       |

Notes an operator should know:

- **Reactivation needs the activate permission, not the suspend one.** An
  operator trusted to pause a business is not automatically trusted to bring it
  back; the two permissions are separately grantable.
- **Every transition requires a reason** (3–500 characters, trimmed). The UI
  checks it and the server checks it again; the reason is written into both the
  status history row and the audit event's `metadata`.
- **Each transition is one atomic transaction**: the guarded status update, the
  `TenantStatusHistory` row and the audit event commit together or not at all.
  The update is `WHERE id = … AND status = <expected prior>`; if a second
  operator moved the workspace first, zero rows change and you get
  "Only an active organisation can be suspended." (or the equivalent), not a
  silent double-apply.
- **Only a human can suspend.** There is no job, cron, trigger or scheduled check
  that changes a status because a payment is overdue or any other condition was
  met. The `Plan` label (§5) is never read by lifecycle code.
- **`tenant_status_guard`** in the database refuses a status change made outside
  an active platform-admin context, so even a code path that forgot the check
  cannot move the status.

Transitions that **deliberately do not exist**:

| Requested transition     | Status          | Why                                                                                                                                                   |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING → SUSPENDED`    | not implemented | You cannot take offline a workspace that was never opened. Leave it `PENDING`: authorization already refuses every workspace operation in that state. |
| `SUSPENDED → PENDING`    | not implemented | Sending a live business back to "not yet activated" would rewrite what its activation date means and lose the fact that it ever went live.            |
| any self-service change  | not implemented | No tenant role, including `TENANT_OWNER`, can activate, suspend or reactivate its own workspace.                                                      |
| automatic/overdue-driven | not implemented | MVP policy: manual, provider-controlled activation and suspension only.                                                                               |
| offline propagation      | not possible    | See §10 — the server records what it answered, never what a disconnected device received.                                                             |

---

## 5. Plan assignment

`Plan` is an **informational catalogue**: `code`, `name`, `description`,
`status` (`ACTIVE`/`ARCHIVED`) and `sortOrder`. It has no price column and no
limits column — a database `CHECK` refuses the shape of a billing table, and the
runtime role holds `SELECT` only, so the catalogue changes by migration or an
operator decision recorded in the runbook, never by an application request.

- Assigning or clearing a plan requires `platform.tenants.plan.assign` and is
  audited as `platform.tenantPlanAssigned` with the plan **code** in `metadata`.
- Retired (`ARCHIVED`) plans are not offered for a new assignment, but the plan a
  workspace currently carries is always displayed even if it has since been
  retired — the console must not hide the label a business is actually carrying.
- Re-assigning the plan a workspace already has is refused with a stated
  "already assigned" message rather than writing a duplicate audit event.
- **A plan grants nothing.** No feature, permission, limit or document behaviour
  reads it. Today the catalogue holds exactly one row, `standard` ("Amisi Genuine
  Standard"), because no tier list has been published; inventing Starter/Growth/
  Enterprise rows would be fabricating pricing structure the product does not
  have.
- Seeding further plans is a migration (or reviewed operator SQL) against the
  live project, and applying anything to that project needs the owner's go-ahead.

---

## 6. Profile, branding, numbering and address

| Panel              | Permission                       | Audit action                      | What it can and cannot do                                                                                      |
| ------------------ | -------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Profile            | `platform.tenants.update`        | `platform.tenantUpdated`          | Name, country, currency, timezone, locale. Audited by **field names**, not values.                             |
| Branding           | `platform.tenants.update`        | `platform.tenantBrandingUpdated`  | Trading/registered name, contact details, website, KRA tax PIN, addresses, document currency, footer, colours. |
| Document numbering | `platform.tenants.update`        | `platform.tenantNumberingUpdated` | Prefix, digits, separator, period style and fiscal start month per document type.                              |
| Workspace address  | `platform.tenants.domain.manage` | `platform.tenantDomainUpdated`    | Change the slug; add, make primary, remove custom hostnames.                                                   |

Details that matter operationally:

- **Branding is the same validated patch a business admin would use.** The
  provider edits exactly the fields tenant self-service would edit, so enabling
  `business.branding.update` for owners later is a permission change, not a
  schema or template change. Contrast is enforced: text on the primary colour
  must reach WCAG AA 4.5:1 or the save is refused.
- **The logo is not part of this panel.** Logo bytes go through the upload route
  with its own file validation (PNG/JPEG/WebP, 5 MB) — provider-side logo upload
  into Supabase Storage is still open work (task #36), and the filesystem
  `/uploads` path is currently the effective store.
- **Numbering configures the series only.** Issued documents keep the number they
  were allocated; nothing here renumbers, resets or frees a number, and no
  counter is touched.
- **Changing the slug changes the address every member and installed client uses.**
  Already-issued documents are unaffected. One primary hostname per workspace is
  enforced by a partial unique index, so "set primary" moves the primary rather
  than creating a second one.
- **Removing a hostname deletes the routing entry only** — the workspace keeps
  its slug route, its records and its files.
- **Provider edits keep working on a suspended workspace.** Every platform-admin
  branch in the policy families is unconditional, because the operator who
  suspended a business is the one who will re-brand, re-address and reactivate it.
  The suspended business's own members cannot move the slug, plan label or
  activation/suspension bookkeeping at all (`tenant_provider_columns_guard_update`).

---

## 7. Initial owner assignment

`/admin/tenants/{id}` → Owner panel. Requires `platform.tenants.create` (it is
part of provisioning, not an edit of a running workspace) and is audited as
`platform.tenantOwnerAssigned` / `platform.tenantOwnerInvited` with the address.

- It issues a `TENANT_OWNER` **invitation** valid for 7 days and stores only its
  **hash**. The person named must sign in with that exact address and accept;
  ownership is never granted from a submitted email alone.
- Re-assigning to an address that already has a pending invitation **refreshes
  that invitation** instead of creating a second one, and the audit row records
  `refreshed: true`.
- A workspace that already has an owner is refused: "Ownership moves through a
  role change inside the workspace." The provider console does not reassign the
  owner seat.
- A `PENDING` workspace is exactly where this belongs — `app_tenant_accepts_writes()`
  admits `PENDING`, which is what lets a first owner accept at all.
- **No mail transport exists in this deployment.** Nothing has been emailed and
  the acceptance link is not displayed. Hand the invitation to the business
  through your normal channel; the panel states this rather than implying delivery.

---

## 8. Support access (read-only, expiring, audited)

Support staff are granted access per workspace by an operator holding
`platform.support.grant`, through the server actions in
`apps/web/src/server/actions/support.ts` (`grantSupportAccessAction`,
`revokeSupportAccessAction`). There is **no support-grant screen in the console
yet** — grants are made through those actions today.

A grant names one workspace and one platform user, records a mandatory reason,
expires (default 24 h, hard maximum 30 days), is revocable, and is audited on
grant, revoke, use and denial. Even with an active grant the permission set is
read-only (8 permissions: settings, branding, members, contacts, items,
documents, download, audit read) — there is no support branch in any write
policy, so a grant cannot become a write path even if application code were
wrong.

---

## 9. Status history, audit trail and indicators

**Status history** lists every recorded transition for the workspace, newest
first, with reason and the acting operator's email. It is append-only at two
levels: the application exposes no update/delete path, and the runtime role holds
`SELECT, INSERT` only on `TenantStatusHistory` — the guard trigger even refuses
`UPDATE`/`DELETE` for a context that is the table owner.

**Audit trail** is gated by a _separate_ authority, `platform.audit.read`. An
operator who administers workspaces but cannot read audits sees a stated refusal
("your platform role does not include reading it"), never an empty list that
looks like "nothing happened". Rendering is allow-listed per action family:
unknown action names print verbatim rather than being mapped onto a plausible
label, and `metadata` is summarised only for the events whose payload is a short
non-sensitive summary (field names, hostnames, plan codes, refusal codes,
reasons).

**Indicators** (workspace detail, lifecycle card):

| Indicator                    | Written when                                                                     | What `—` / empty means                                                |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Last authorized write        | the server accepts a **write** for that workspace (`touch_tenant_activity()`)    | no authorized write has ever been recorded                            |
| Last synchronization         | the server **answers** a sync attempt, accepted or refused                       | **every workspace, today:** there is no sync transport yet (Phase 06) |
| Last synchronization refusal | a refusal is recorded (`tenant_suspended`, `no_membership`, `support_read_only`) | no refusal recorded; cleared by the next accepted sync                |
| Record last updated          | any change to the workspace row, including a provider edit                       | — (never treat this as business activity)                             |

The refusal codes you will see and what they mean:

| Code                | Meaning                                                  |
| ------------------- | -------------------------------------------------------- |
| `tenant_suspended`  | Workspace suspended — writes and synchronization refused |
| `no_membership`     | No active membership for that account                    |
| `support_read_only` | Support access is read-only — synchronization refused    |

An unrecognised code is displayed verbatim, because the code is what the server
actually recorded.

Both indicator columns are writable only through the two `SECURITY DEFINER`
functions granted to `amisibiz_app` — nothing in the console can type an
indicator value, and a timestamp that could not be written is a reporting gap,
never a reason to refuse a customer's invoice.

---

## 10. Suspension, sessions and offline devices — what to tell a business

Say this, because it is what the code does:

- Suspension **stops new writes and synchronization** for anything that reaches
  the server.
- The business **keeps reading, printing and downloading** what it already has.
- **No record and no stored file is deleted.** Suspension is a status flag plus
  bookkeeping columns; it never cascades, archives or removes data.
- Existing sessions are not revoked. Status is re-read from the database on every
  protected request, so the workspace becomes read-only for a logged-in member on
  their **next** request — they are not signed out mid-edit.
- **A device that is offline keeps whatever it cached until it connects again.**
  Suspension takes effect when that device asks to write or synchronize, and the
  server records the refusal it gave. No operator statement, UI label or report
  may claim a revocation reached a device earlier than the transport carried it.

Refusals a member will see: a write attempt returns

> "This workspace is suspended. Existing records stay available to view and
> download, but changes and synchronization are paused until Amisi Genuine
> reactivates it."

and the workspace keeps its read-only chrome (write affordances hidden, the
suspension reason card displayed with the reason and date).

---

## 11. Incident playbook (provider-console specific)

- **"Only an active organisation can be suspended."** Someone else moved the
  status first, or the workspace is `PENDING`. Reload the page; check status
  history for the concurrent transition. Do not retry blindly.
- **A panel saves and nothing changes.** Check the audit trail for the same
  window: `authz.denied` (missing permission on your account) or `tenant.writeDenied`.
- **A suspended business is still writing.** Treat it as an active incident and
  follow `../RUNBOOK.md` §8 — capture the request path and the connection
  identity (`current_user`, not the connection string), and check whether the code
  path bypassed `packages/database/src/scope.ts`.
- **The audit panel says you lack permission.** That is the intended behaviour;
  `platform.audit.read` is separate from workspace administration on purpose.
- **A hostname you removed is still routing.** Routing is resolved from the
  database per request; confirm the row is gone in the panel, then check the
  DNS/edge configuration, which is outside this application.

---

## 12. What this console does **not** do yet

Stating these is part of the documentation, not a caveat:

1. **No real document preview.** The preview cards are clearly-labelled branding
   shells against placeholder content; no document, number or total has been
   issued and no tax is computed. True per-document preview arrives with Phase 05.
2. **No synchronization transport calls the refusal path yet.** `answerSyncRequest()`
   is implemented, tested and wired to the indicator functions, but the sync
   endpoint is Phase 06, so `lastSyncAt` is honestly `null` for every workspace.
3. **No support-grant screen.** Grants go through the server actions (§8).
4. **No email delivery.** Invitations, verification and reset mail are not sent
   (§7); production registration must stay disabled until a transport exists.
5. **RLS does not govern the running app yet.** `amisibiz_app` has no password and
   `APP_DATABASE_URL` is unpublished (`../RUNBOOK.md` §3, task #38), so the
   database half of every statement above is written and reviewed but not yet
   enforced against the deployed application.
6. **The Phase 2 migration is not applied to the live project.**
   `20261019000000_phase02_provider_administration_plans_and_suspension_gates`
   exists and passes its own checks; applying it to Supabase is an owner-gated
   operation, so on the live database the plan catalogue, indicator columns and
   the four new platform permissions do not exist yet.
7. **No bulk operations, no tenant-data browsing, no billing.** By design: the MVP
   is manual provider control, and business rows are never selectable from here.
