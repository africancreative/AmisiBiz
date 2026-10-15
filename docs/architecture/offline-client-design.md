# AmisiBiz — Offline client architecture (Phase 6 directive)

- **Written:** 2026-10-15, as the design half of **PHASE 6: OFFLINE CLIENT
  ARCHITECTURE**. The implementation record and the verified/unverified split live
  in `../implementation/phase-06-offline-client-report.md`.
- **Supersedes:** the "04.5d offline design" placeholder in
  `../implementation/phase-checklist.md`, and the `CONTRACTS ONLY` banners in
  `packages/sync/src/*` (those interfaces are kept; this document says what
  implements them and where).
- **Baseline:** built on `e0a75cd` (the Phase 4 document engine). The local schema
  mirrors the server's document/contact/catalogue shapes, so a change to those
  server types is a change to this design.

---

## 1. Facts this design had to work around

Verified on 2026-10-15 rather than assumed:

| Fact                                                                                                                                                                         | Consequence                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/sync/src/{queue,transport,conflicts}.ts` are interfaces only; nothing implements them                                                                              | The outbox and sync engine are new code, not a wiring job                                                                 |
| `apps/mobile` has **no** `android/` directory; `apps/desktop/src-tauri` has never been compiled                                                                              | Both shells are starting points, not builds                                                                               |
| JDK 17.0.20, `ANDROID_HOME=C:\src\Android` (build-tools 35/36, platform-tools with `adb`, platforms, ndk, emulator, system-images, licenses)                                 | A real Android build is attempted for this phase                                                                          |
| **No** `cargo`/`rustc`/`rustup` and **no** MSVC C++ Build Tools (only Windows Kits 10)                                                                                       | The Windows installer prototype is **configured and documented, not built**. No Windows build success is claimed anywhere |
| Node 24.18 with a working `node:sqlite` (`DatabaseSync`)                                                                                                                     | The shared SQL layer is tested against real SQLite on this machine, in CI, without native deps                            |
| Registry reachable: `@capacitor-community/sqlite` 8.1.1, `@capacitor/cli` 8.5.3, `@tauri-apps/plugin-sql` 2.6.0                                                              | The two platform drivers are pinned, current and installable                                                              |
| Session resolution is **cookie-based** (`createServerSupabase()` reads `next/headers` cookies; `getSessionUser()` is the only trust chain)                                   | Installed shells cannot reuse it as-is: they need the same chain over an `Authorization: Bearer` header (see §6)          |
| Hard deletes exist for `Item` (`deleteItemAction`) and `ContactItem` (`deleteContactItemAction`); `Contact` is archive-not-delete; `Document` rows are immutable after issue | A pull that only returns live rows would leave deleted rows on devices forever → explicit tombstones (§7.3)               |
| RLS is **inert in the deployed app** (#38 open, `amisibiz_app` has no password)                                                                                              | Every offline authorization claim in this document is an application-layer claim                                          |

---

## 2. Shape of the system

```
┌─ installed shell (Capacitor Android / Tauri Windows) ─────────────────┐
│  static offline client (React, bundled into webDir — no remote URL)    │
│        │                                                               │
│  @amisibiz/offline  ── versioned SQL migrations + repositories         │
│        │                    ▲                                          │
│        │              SqlDriver adapter                                │
│        │      node:sqlite │ @capacitor-community/sqlite │ plugin-sql   │
│  @amisibiz/sync  ── durable outbox, push/pull engine, conflict store   │
└───────────────│────────────────────────────────────────────────────────┘
                │  Authorization: Bearer <user access token> only
┌─ apps/web (server) ┴──────────────────────────────────────────────────┐
│  /api/sync/push · /api/sync/pull · /api/sync/session                   │
│  bearer session resolution → authorizeTenant(...) → Prisma + RLS scope  │
│  SyncOperation receipts (idempotency) · SyncDeletion (tombstones)       │
└────────────────────────────────────────────────────────────────────────┘
```

The client never holds a privileged credential. `SUPABASE_SECRET_KEY`,
`service_role`, the DB password and the JWT signing secret stay server-side; the
bundle carries only the publishable key, the server URL and the signed-in user's
own access token. `pnpm check:bundles` scans client output; the shells' bundles are
added to its scan set so an accidental privileged import fails the gate.

---

## 3. Local storage

**One package, three drivers.** `@amisibiz/offline` owns the SQL and the repository
logic. A `SqlDriver` interface (`exec`, `run`, `all`, `transaction`, `close`, all
async) is implemented by:

| Driver                  | Used by                                | Notes                                           |
| ----------------------- | -------------------------------------- | ----------------------------------------------- |
| `nodeSqliteDriver`      | tests, CI, and any future Node tooling | `node:sqlite` — real SQLite, no install         |
| `capacitorSqliteDriver` | Android                                | `@capacitor-community/sqlite` (native, file DB) |
| `tauriSqlDriver`        | Windows                                | `@tauri-apps/plugin-sql` (SQLite via `sqlx`)    |

Only portable SQLite SQL is allowed in migrations: no `RETURNING` on SQLite < 3.35
assumptions, no Postgres-only syntax, no generated columns. The drivers differ in
_how_ they run statements, never in _what_ schema they run.

**Two verified incompatibilities, recorded because the directive asks for real
compatibility rather than assumed compatibility.** Checked against the installed
package sources, not from documentation:

- `@tauri-apps/plugin-sql` 2.6.0 exposes `execute`, `select`, `load` and `close` and
  **no transaction API**, while every multi-row repository write here
  (document + lines + snapshot + outbox entry) is required to be atomic. It also binds
  `$1, $2, …` where the shared SQL layer uses `?`. The Tauri driver therefore refuses
  `transaction()` at runtime with a message naming the reason, rather than degrading
  it into a non-atomic sequence of statements that would silently produce half-written
  documents. Windows is consequently **blocked, not built** (§10, §12).
- `@capacitor-community/sqlite` 8.1.1 runs in non-SQL92 mode by default, where SQLite
  rejects `DEFAULT` values and column defaults in the shapes this schema uses. The
  driver is created with `isSQL92: true`, and this has **not yet been executed on a
  device** — the Android run is the step that turns that from a pin into a fact (§12).

**Versioned migrations.** Migration files are ordered `NNN_name.sql` resources in
the package, each with a SHA-256 checksum. The runner keeps
`amisibiz_schema_version(version, name, checksum, applied_at)`, applies pending
migrations one transaction each, and **refuses to run against a database whose
recorded checksum differs** from the file it is carrying (a local file edit is
tampering, not a migration). Re-running is a no-op. The current schema version is
exposed to the sync protocol so a server that knows the client's version is behind
can require a re-provision instead of guessing.

**Transactional writes.** Every repository write that touches more than one row
(document + lines + snapshot + outbox entry) runs inside `driver.transaction()`, and
the outbox entry is written **in the same transaction** as the local change it
represents. That is what makes "recovery after interruption" a property rather than a
hope: there is no state where a local edit exists but its operation does not, or the
reverse.

**Stable client-generated UUIDs.** Ids are `crypto.randomUUID()` (v4), generated on
the device and sent to the server as the intended primary key for created rows, so
the same UUID exists on both sides and a retry can never mint a second record. Local
ids are labelled as such; they are not authority, and the server still re-checks
tenant ownership on every row it is handed.

### 3.1 What is stored locally

| Table                               | Purpose                                                                             | Synced from/to                |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| `tenant_profile`, `tenant_branding` | the authorized tenant's display facts, colours, document defaults, numbering config | pull only                     |
| `contact`, `contact_address`        | customer records for the workspace                                                  | both                          |
| `item`                              | catalogue items/services with UOM, price, tax category                              | both                          |
| `customer_price`                    | customer-specific catalogue entries                                                 | both                          |
| `document`, `document_line`         | local drafts and the last synchronized copy of issued documents                     | both (drafts up, issued down) |
| `document_snapshot`                 | frozen issued snapshots + local PDF render cache metadata                           | pull only                     |
| `outbox_operation`                  | the durable queue (§5)                                                              | push                          |
| `sync_checkpoint`                   | per-tenant pull cursor + last successful exchange                                   | both                          |
| `conflict`                          | open conflicts with both revisions                                                  | both                          |
| `local_meta`                        | installation `clientId`, session binding, offline expiry, schema version            | device only                   |

**Sync state column.** Every mirrored row carries `sync_state` ∈ `local`,
`pending`, `synced`, `rejected`, `conflict`, plus `server_updated_at` and
`base_revision`. This is what the UI labels from, and what makes "do not overwrite
newer server data silently" implementable.

### 3.2 Data at rest

The database file lives in the app's private container. Encryption at rest is
**platform-dependent and not implemented here**: Android app-storage encryption is
enabled by the shell's manifest flag, Tauri relies on OS-level encryption;
SQLCipher is not adopted. Consequences are documented as limitations: a contact
list and draft invoices are customer PII, so the client wipes the local database on
explicit sign-out and on any authorization failure, and the server never puts
columns into a pull payload that the workspace does not need to render them.

---

## 4. Offline operations

Allowed while disconnected: browse everything already synchronized; create
contacts, items, customer prices; create **draft** quotations, invoices and delivery
notes; edit local drafts; render a local preview and, where the platform supports
saving a file, a local PDF.

Not allowed, by construction rather than by message box:

- **No server-issued document number.** `document.number` stays `NULL` locally
  until the server allocates it at issuance. The UI shows a clearly-marked local
  reference — `LOCAL <shortId>` — and the design forbids any string shaped like a
  real series number for an unsynchronized document. Issuance itself is a
  server-side operation (§7.2), so a device cannot produce a number even if the UI
  were changed.
- **No status a device invented.** Payment state, issued/accepted/void status and
  activation come from the server; the client stores what it was told and marks it
  stale by age.
- **No privileged key handling.** The outbox stores payloads, not credentials.

Every unsynchronized record is visibly labelled in the UI (`Local`, `Queued`,
`Synced`, `Rejected`, `Conflict`), and rejected drafts are kept for controlled
recovery instead of being deleted — the user gets the server's reason plus the
original payload.

Local PDFs use the existing dependency-free A4 writer from `@amisibiz/documents`,
which runs in a WebView. The tenant logo is the one asset that needs the network, so
an offline render uses the saved colours and omits the logo rather than reaching for
a cached copy it cannot authorize. A generated PDF is a commercial document, never
presented as a KRA/eTIMS tax invoice.

---

## 5. Outbox and retry

`LocalOutbox` (`packages/offline/src/outbox.ts`) is the implementation of the
`OperationQueue` contract in `@amisibiz/sync`, and the conformance is checked at
compile time in `sync-client.ts` (`OutboxConformsToQueue`) rather than asserted in
prose. A queued operation is: `id` (client UUID, the idempotency key), `type`,
**`entity`**, **`entityId`**, `payload`, `baseRevision`, `createdAt`, `attempts`,
`status` (`pending | in_flight | applied | failed | conflict`), `lastError`.

`entity` + `entityId` were added while building the engine, because without them the
server would have to route a write by parsing the operation `type` prefix. A client
that got the prefix right and the entity wrong would have its write applied to the
wrong table; an operation the server cannot route without guessing is not a contract.
Together with `entityId` — the client-generated row id — they are the server's upsert
key, which is what makes a retried create land on the same row instead of minting a
second one.

- **Claiming is transactional.** A push marks its batch `in_flight` with a generation
  token before the network call, and re-reads the rows it claims so the caller is
  handed the state that is actually in the table.
- **Crash recovery is explicit.** On start-up any `in_flight` row from a _previous_
  generation is returned to `pending`, and the push re-sends it **with the same
  operation id**. The server's receipt store answers `duplicate` rather than
  re-applying, which is what makes "retry after interruption" safe instead of merely
  unlikely to collide.
- **Bounded retry, with a distinction the directive requires.** Attempts past a
  configurable cap (default 8) go to `failed` with the last error kept for the user;
  exponential backoff with jitter, capped at 15 minutes. Two failure classes do
  **not** burn the queue: a policy refusal (`rejected`: no permission, suspended
  tenant, revoked session) is permanent and stops retrying immediately, and a lost
  connection is answered by `release()` — the batch returns to `pending` with no
  attempt counted, because the absence of a network is not evidence about the
  operation, and letting it climb the cap would fail good local drafts for a reason
  that has nothing to do with them.
- **Ordering.** Operations for one document are pushed in local order; the engine
  never sends a line operation before its document operation.

---

## 6. Server-facing authentication for an installed app

Installed shells cannot use the cookie path, so `getSessionUser()`'s trust chain is
**factored, not duplicated**: the token-validation, session-version-claim check,
profile lookup and RLS scope entry move behind one function that takes a Supabase
client. Two thin wrappers remain — cookie-based (web) and bearer-based (route
handlers reading `Authorization: Bearer …`).

The bearer path keeps all three links of the existing chain: GoTrue verifies the
token, `app_metadata.amisibiz_session_version` must match `User.sessionVersion`
(revocation is enforced by our database, not by trusting the token), and the profile
must exist and be `ACTIVE`. A bearer request that fails any link gets
`401`/`403` and the client must re-authenticate; the outbox keeps its contents.

The client never sends a tenant id it expects to be believed. Each push/pull
resolves membership and permission server-side from the verified user id, exactly as
the Server Actions do (`authorizeTenant`), and the tenant scope is entered before
any read.

---

## 7. Synchronization protocol

### 7.1 Push

`POST /api/sync/push { clientId, schemaVersion, operations: [{ id, type, entity,
entityId, payload, baseRevision, createdAt }] }` → `{ outcomes: [{ operationId,
outcome }], serverTime }` where outcome is `applied | duplicate | rejected |
conflict`. This is the shape `SyncClient` sends today: `schemaVersion` is the local
schema version, so a server that cannot safely answer an out-of-date replica refuses
the batch instead of sending columns the client would mis-store, and `serverTime` is
the server's clock, which is what the offline window is measured from (§8). **The
endpoints do not exist yet (§12)**; the engine is exercised against a contract stub.

- **Idempotency** is a table, not a heuristic: `SyncOperation(clientId,
operationId)` unique, storing the resolved server id and outcome. A duplicate
  answers the original result, so the client converges even if the response was lost.
- Every operation goes through the **same authorization** as the equivalent Server
  Action (permission chosen from the stored type where one exists), the same Zod
  validation, and the same tenant check. Prices, totals, statuses and numbers are
  recomputed server-side by the existing engine — the sync layer does not implement
  a second copy of either.
- The **suspension write gate** applies: a suspended tenant's operations are
  `rejected` with the reason the provider gave, never silently queued behind the
  backoff.
- **What the client does with each answer, and what it refuses to conclude.**
  `applied`/`duplicate` set the queue row `applied` and the data row `synced` with the
  server's revision. `rejected` is permanent — `failed`, reason kept, never retried —
  and the draft row is preserved with its data and `syncState = rejected`. `conflict`
  opens a conflict record carrying both revisions. An operation the server did not
  answer at all is counted as `missingOutcome` and keeps its place: **the engine never
  reports a success the server did not confirm**, so a partial reply is not read as a
  synchronized device.
- **Errors are classified, not string-matched.** A `401` releases the whole batch with
  no attempt counted, drops the pull cursor (a position a revoked session reached is
  not a fact the next session should inherit), and ends the run. A protocol refusal
  (`400`: unparseable envelope) counts one attempt per operation, stops the batch loop
  — the server cannot say which operation it choked on, so the client does not invent
  one — and still pulls, because the wire worked. Any other failure is a transport
  failure: attempts plus backoff, and no pull, since it would fail for the same
  reason. The run's `halted` field names which of these ended it, and a push halt
  survives a pull that afterwards succeeded.

### 7.2 Issuance stays server-side

Creating a draft is a normal offline operation. **Issuing** a document, recording a
payment, voiding, converting a quotation to an invoice or accepting a quotation is a
synchronized command that the server executes through the existing document service
inside one transaction, allocating the number under `FOR UPDATE`. The device gets
back the number, the snapshot and the status; until then it shows `LOCAL`. This is
why the directive's "do not claim an official server-issued number" holds by
construction rather than by UI discipline.

### 7.3 Pull

`GET /api/sync/pull?cursor=…&limit=…` returns a page of
`{ nextCursor, changes: [{ entity, id, revision, deleted, updatedAt, data }],
serverTime }` ordered by `(updatedAt, id)` with an opaque `nextCursor` (base64 of that
pair, tied to the tenant and checked against membership). Hard-deleted
`Item`/`ContactItem` rows appear as tombstones from `SyncDeletion`, written in the
same transaction as the delete, so a device actually drops them instead of showing
ghosts. Nothing outside the caller's tenant is reachable — the query is
tenant-predicated _and_ RLS-scoped. There is no `tenantId` in the request: the tenant
comes from the verified session, which is why a forged cursor from another workspace
has nothing to be checked against.

The client's side of cursor discipline is already implemented and tested: a page is
applied in **one transaction**, so a frame the client cannot store aborts the whole
page and the cursor stays where it was; a server that repeats the cursor it was given
halts the run rather than pulling forever; and a page's `serverTime` is stored as the
checkpoint's fact, not the device's.

`deleted` tombstones are pruned server-side only after a documented retention
window that exceeds the longest plausible offline period, otherwise a long-offline
device would silently miss deletions.

### 7.4 Conflicts and "no silent overwrite"

Each mutation carries the `baseRevision` (the server revision the device last saw).
If the server row has moved on, the outcome is `conflict` with the current server
revision — never a forced local write, never a silent server-wins. The device keeps
both values in `conflict` and the UI offers the only resolutions the product allows:
keep the server copy, or re-apply the local change deliberately as a new operation
against the new revision. Device clocks are never a tie-breaker; `server_updated_at`
and revisions are.

### 7.5 Checkpoints

`sync_checkpoint(tenantId, cursor, server_time, last_push_at, last_pull_at,
last_error)` records only what actually happened. A failed exchange leaves the cursor
where it was, so "recovery after interruption" means the next successful pull resumes
from the last position the client _knows the server confirmed_. The cursor is dropped
on a revoked session (`invalidate`), because a position an unauthorized session
reached is not a fact the next session should inherit; `server_time` is the server's
own stamp from the page, so "last synced" is not a device guess.

---

## 8. Bounded offline authorization policy

The device caches the last server-confirmed identity facts: membership, role, the
effective permission set, tenant status, and the time it received them.

1. **Reads** of already-synchronized data always work offline.
2. **Local creates/edits** of drafts are allowed only while the cached permission
   set contains the create/update permission **and** the cached offline expiry has
   not passed. Default limit: **72 hours** from the last successful authorized
   exchange, configurable down to 0 (no offline creation) per deployment. The
   client enforces this limit _advisory-only_: it is a UX and data-hygiene guard.
3. **The server decides everything real.** On the next push, authorization is
   re-derived from the verified user id: if membership, role, permission or tenant
   status changed while the device was dark, operations are `rejected` with the
   reason and the drafts are preserved for recovery. A device that was offline
   during a role downgrade cannot make anything the server will accept.
4. **Session expiry** ends offline creation immediately (the token cannot be
   refreshed while dark anyway); existing data remains readable until sign-out or
   the configured local-retention limit.

**As built:** after an exchange the engine writes `last_authorized_at` and
`offline_expires_at` (that instant plus the configured window), measured from the
**server's** `serverTime` when the response carries one and from the device clock only
when it does not. An exchange that halted on a revoked session, and a run that
exchanged nothing, renew nothing — `AuthorizationRenewal.reason` says which. It also
copies the tenant status the server just described into `tenant_status`, which is how
a suspension reaches a device (§8.1). It pointedly does **not** touch
`token_expires_at`: the engine does not own the auth token and cannot refresh it, so
after a run a still-expired session keeps offline creation closed — tested, not
assumed. `offlineCreation()` answers fail-closed in this order: `no_session`,
`no_tenant`, `session_expired`, `offline_window_elapsed`, `tenant_suspended`.

### 8.1 What suspension enforcement cannot mean while disconnected

Stated plainly because the directive asks for the limits:

- Suspension is a **server-side write gate**. `app_tenant_accepts_writes()` denies
  writes and synchronization while reads and downloads continue. There is **no push
  channel to a device** — `lastSyncAt` is only ever written when the device calls
  in, and `answerSyncRequest()` still has no transport caller.
- Therefore a suspended tenant's device **keeps working locally** until it next
  connects. The client can be told at the next exchange, and it can be refused at
  the next exchange, but it cannot be interrupted mid-edit, and its local database
  cannot be remotely wiped by the platform.
- What suspension does guarantee: nothing created while disconnected becomes a
  server record, gets a real document number, or is ever presented as paid, issued
  or accepted. The outage delays the _consequences_, not the enforcement.
- Any claim that suspension is enforced on an offline device would be false, and
  the UI shows the last-known tenant status with its age rather than a
  present-tense badge.

---

## 9. Testing strategy

| Layer                                                 | How it is tested on this machine                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL + migrations                                      | `node:sqlite`: fresh provision, version recorded, re-run no-op, checksum mismatch refuses to start, transaction rollback leaves no partial row                                                                                                                                                                    |
| Repositories + outbox                                 | real SQLite, no mocks: enqueue-in-same-transaction, crash-recovery of `in_flight`, attempt caps, backoff, ordering                                                                                                                                                                                                |
| Sync client ↔ server                                  | **as built:** `SyncClient` against a `SyncTransport` **contract stub** on real SQLite (`tests/phase06-sync-engine.test.ts`, 17 tests). The stub imitates the semantics the endpoints must have; it is not the endpoints, so nothing here is evidence about server behaviour. Route-handler tests are owed to §12. |
| Authorization expiry / suspension / cross-tenant      | client half: expired session releases the batch without burning it, suspension is learned and refused at the next exchange, a window cannot revive an expired token. Server half (expired bearer, revoked session version, foreign-tenant cursor, tombstone pruning) is owed to §12.                              |
| End-to-end SQLite against real Postgres-side behavior | **not** available: the server half is RLS-inert in production (#38) and there are **no sync endpoints to reach**.                                                                                                                                                                                                 |

The directive's gate is kept in view: the offline feature set is **not**
production-ready until conflict, authorization-expiry, suspension and recovery tests
pass. As of this phase all four have a named passing test **on the client side**
(`phase06-sync-engine.test.ts`, `phase06-offline-storage.test.ts`), and none has one
against a real server, because the server half does not exist yet (§12). That is the
difference between "the client cannot lose a change or lie about one" and "the feature
is shippable", and this document does not collapse it.

---

## 12. Built, and not built (as this phase ends)

Written because the directive's deliverable list is a completeness claim waiting to be
made, and the honest answer is partial.

**Built and executed on this machine:**

- `@amisibiz/offline` — SQLite schema + checksummed migration runner, `node:sqlite` /
  Capacitor / Tauri drivers, repositories for tenant profile and branding, contacts
  and addresses, items, customer prices, documents and lines, checkpoints, conflicts,
  and the durable outbox. 31 tests (`phase06-offline-storage.test.ts`) on real files.
- `SyncClient` — the push/pull loop, outcome settling, error taxonomy, recovery,
  cursor handling and authorization renewal, 17 tests against the contract stub,
  including restart-and-recover with a duplicate retry that applied nothing twice.
- `@amisibiz/sync` contracts, reshaped by what the implementation actually needed:
  `entity`/`entityId` on a queued operation, `schemaVersion` and `serverTime` on the
  wire, `release()` on the queue, a runtime `CONFLICT_RESOLUTIONS` list so the SQLite
  `CHECK` constraint and the TypeScript union are asserted equal rather than kept in
  sync by hope.
- The bundle-secret scan now covers the two installed-app directories alongside the
  web build, so "no privileged key in an installed app" is a check on the path that
  ships them.

**Not built — and therefore not claimed:**

- **Server endpoints (§ task #61).** There is no `/api/sync/push` or `/api/sync/pull`,
  no bearer-session wrapper, no `SyncOperation` receipt table, no `SyncDeletion`
  tombstones, and **no `revision` column on `Contact`, `Item`, `ContactItem` or
  `Document`** — the schema today has only `updatedAt`, which cannot support
  "do not overwrite newer server data" on the server side. Until those exist, the
  server-side half of every §7 promise is design, and §9's outstanding rows stay open.
  The migration is deliberately not written here: revision allocation belongs with the
  endpoints that consume it, and an unverifiable schema change in the chain would be
  worse than a documented gap.
- **The static offline client UI in the shells** (labels `Local/Queued/Synced/
Rejected/Conflict`, `LOCAL <shortId>` temporary identifiers) — the shells still
  carry placeholder `web/index.html`.
- **A real Android build.** `android/` has not been generated yet, so
  `capacitorSqliteDriver` has never executed on a device, and the six runtime
  behaviours (open, create offline, persist, restart, recover, sync) remain
  demonstrated only against `node:sqlite` on Windows.
- **Any Windows build.** No Rust, no MSVC workload, and a driver whose `transaction()`
  refuses by design (§3). Blocked, not built.

---

## 10. Build prerequisites (recorded, because the shells are where this ships)

**Android (prerequisites verified on this machine; the generated project and the
first Gradle build are still open work, see §12):** JDK 17 ✔, `ANDROID_HOME` with
build-tools 35/36 + platforms + platform-tools ✔, `@capacitor/cli` 8.5.3 ✔, Gradle via
the generated wrapper (first build downloads its distribution), a signing keystore only
for release. Emulator AVDs exist on this machine; a debug build and an installed smoke
run are separate claims and are reported separately.

**Windows (documented, not built):** `rustup` with the MSVC toolchain, Visual
Studio Build Tools' "Desktop development with C++" workload, then
`pnpm --filter @amisibiz/desktop tauri:build` for `.msi`/NSIS. Neither Rust nor the
C++ workload is installed here, so the Windows installer prototype is **not**
demonstrated in this phase.

---

## 11. Explicit non-goals for this phase

Server-push to devices; remote wipe; SQLCipher; multi-device conflict UI beyond
accept/keep; iOS; incremental schema sync of unlisted tables; production-readiness
claims; and anything that would make an offline-generated document look like an
eTIMS tax invoice.
