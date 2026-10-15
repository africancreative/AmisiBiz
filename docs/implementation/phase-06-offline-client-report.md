# Phase 06 — Offline client architecture

**Directive:** prepare the shared domain/repository architecture for the installed
Android (Capacitor) and Windows (Tauri) clients — SQLite-backed local repositories, an
offline operations layer, a durable outbox with a real synchronization client, platform
validation, and the deliverables the directive names (design, migration strategy,
synchronization tests, build prerequisites, documented limitations).

**Status at the end of this session: partial, and explicitly not production-ready.**
The client half is implemented and tested against real SQLite. The server half does not
exist. Per the directive's own gate — _"Do not describe the full offline feature set as
production-ready until conflict, authorization-expiry, suspension and recovery tests
pass"_ — the four named behaviours now pass **on the device**, and have no test against
a server because there is nothing to test against. Everything below separates those two
claims rather than blurring them.

---

## 1. Owner decisions taken for this phase

| Question      | Decision                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Baseline      | Commit Phase 4 first — landed as `e0a75cd` before this phase began                                   |
| Windows scope | **Android real, Windows documented as blocked**                                                      |
| Local storage | **Shared SQL + driver adapter** — same SQL everywhere, three drivers, `node:sqlite` for tests and CI |
| Shell UI      | **Static offline client in the shells** (no Next.js inside the app)                                  |

## 2. What was built

**`@amisibiz/offline`** (`packages/offline/`, new package):

- `SqlDriver` abstraction with three adapters: `nodeSqliteDriver` (tests/CI, real
  SQLite), `capacitorSqliteDriver` (`@capacitor-community/sqlite` 8.1.1, `isSQL92`),
  `tauriSqlDriver` (`@tauri-apps/plugin-sql` 2.6.0).
- Checksummed, ordered migration runner (`NNN_name.sql`) with
  `amisibiz_schema_version`, one transaction per migration, and a hard refusal to start
  against a database whose recorded checksum differs from the shipped file.
- Local schema for: `tenant_profile`, `tenant_branding`, `contact`, `contact_address`,
  `item`, `customer_price`, `document`, `document_line`, `document_snapshot`,
  `outbox_operation`, `sync_checkpoint`, `conflict`, `local_meta` — every mirrored row
  carrying `sync_state` ∈ `local | pending | synced | rejected | conflict`,
  `base_revision`, `server_updated_at`.
- `LocalDb` with one-database-one-tenant enforcement (`CrossTenantWriteError`),
  session binding, repositories for each area, `applyPullPage()` (whole page in one
  transaction, dirty-check protecting unsent local work), `wipe()`, `inventory()`.
- `LocalOutbox`: transactional claiming with a **generation token**, crash recovery that
  re-queues `in_flight` work **under the same operation id**, backoff with jitter and an
  attempt cap, `release()` (a lost connection is not evidence about the operation), and
  a permanent `rejected` class that is never retried.
- `SyncClient`: the push/pull loop, per-outcome settling, the error taxonomy
  (`unauthorized` / `protocol_error` / `transport_failure` / `cursor_stalled`), tallies
  including `missingOutcome`, pull cursor handling, and renewal of the offline
  authorization window from the **server's** clock.

**`@amisibiz/sync`** contracts, reshaped by what the implementation actually needed:
`QueuedOperation.entity` + `entityId` (the server must not route a write by parsing a
type prefix), `SyncPushRequest.schemaVersion`, `serverTime` on both push results and
pull pages, `OperationQueue.release()`, and a runtime `CONFLICT_RESOLUTIONS` list so the
SQLite `CHECK` constraint and the TypeScript union are asserted equal in a test instead
of kept in sync by hope. `ConflictStore` has no `auto` resolution, because "server wins"
as a default _is_ the silent overwrite the directive forbids.

**Bundle-secret scan** (`scripts/security/scan-client-bundles.mjs`): now scans
`apps/mobile/web` and `apps/desktop/web` alongside the web build, so "do not store
privileged Supabase keys in installed apps" covers the directories that actually ship
inside an APK and an installer.

## 3. What was verified, and how

Every line below is a command that was run, with its real result.

| Gate                | Command                                                                             | Result                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Storage battery     | `pnpm --filter @amisibiz/web exec vitest run tests/phase06-offline-storage.test.ts` | **31 passed**                                                                                                      |
| Sync engine battery | `pnpm --filter @amisibiz/web exec vitest run tests/phase06-sync-engine.test.ts`     | **17 passed**                                                                                                      |
| Full web suite      | `pnpm --filter @amisibiz/web exec vitest run`                                       | **385 passed, 26 skipped** (15 files; the skip is `integration-security.test.ts`, which needs `TEST_DATABASE_URL`) |
| Types               | `pnpm type-check`                                                                   | **9/9 tasks green**                                                                                                |
| Lint                | `pnpm lint`                                                                         | **0 errors**, 1 pre-existing `<img>` warning in `tenant-branding-panel.tsx`                                        |
| Format              | `pnpm format:check`                                                                 | clean                                                                                                              |
| Build               | `pnpm build`                                                                        | Next.js production build green                                                                                     |
| Secret scan         | `pnpm check:bundles`                                                                | 207 files / 5.5 MB clean across web build output **and both shell webDirs**                                        |
| DB clean-room chain | `scripts/db/cleanroom-chain.sh`                                                     | **not re-run this phase — no Postgres migration was added** (see §5)                                               |

### The directive's four named behaviours

| Behaviour            | Client-side evidence                                                                                                                                                                                                                                                             | Server-side evidence                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Conflict             | Pull refuses to overwrite an unsynchronized local change and records `pull:<entity>:<id>`; a push conflict keeps both revisions and `reapplyAfterConflict()` re-offers the local change against the server revision; the `CHECK` list ≡ the contract list and contains no `auto` | none — no endpoint answers with `conflict` yet                                                                          |
| Authorization expiry | `SyncUnauthorizedError` releases the batch with **zero attempts counted**, drops the pull cursor, stops before pulling, and cannot be renewed: an expired `token_expires_at` still refuses offline creation after a successful run                                               | none                                                                                                                    |
| Suspension           | A refusal arrives with the provider's reason, the draft is preserved (`syncState = rejected`, data intact) and never retried; `tenant_status` is cached from the server's own row so the device learns the suspension at the next exchange                                       | partial: the server gate exists in SQL (`app_tenant_accepts_writes()`) and is tested, but nothing pushes it to a device |
| Recovery             | Restart-and-recover: an operation left `in_flight` by a killed process returns to `pending` with its id, is re-sent, answered `duplicate`, and **the server-side "newly applied" list stays empty**; a third launch pushes nothing at all                                        | none                                                                                                                    |

That is the honest line: the device cannot lose a change or lie about one; the exchange
itself is not real yet.

## 4. Platform validation (directive §"Platform validation")

- **Android: not built.** The prerequisites are real on this machine (JDK 17.0.20,
  `ANDROID_HOME=C:\src\Android` with build-tools 35/36, platform-tools, platforms,
  `@capacitor/cli` 8.5.3), and `@capacitor-community/sqlite` 8.1.1 resolves and
  type-checks against the driver. But `apps/mobile/android/` has **not** been generated,
  no Gradle build has run, and `capacitorSqliteDriver` has therefore never executed on a
  device or emulator. The six runtime behaviours are demonstrated against `node:sqlite`
  on this machine only.
- **Windows: blocked, and configured as blocked.** No `cargo`/`rustc`/`rustup` and no
  MSVC C++ workload on this machine, so `tauri build` cannot produce an `.msi`/NSIS
  installer here. Independently of the toolchain, two verified library incompatibilities
  make the Windows path unsound today: `@tauri-apps/plugin-sql` 2.6.0 exposes **no
  transaction API** (every multi-row repository write here must be atomic, so the driver
  refuses `transaction()` loudly rather than degrading it into a sequence that can
  half-write a document), and it binds `$1, $2` where the shared layer emits `?`. Both
  are recorded in the design document §3.

## 5. What remains in this phase

1. **#61 — server-authorized sync endpoints.** `/api/sync/push` and `/api/sync/pull`,
   the bearer-session wrapper factored from `getSessionUser()` (GoTrue verifies the
   token → `amisibiz_session_version` must match `User.sessionVersion` → profile exists
   and is `ACTIVE`), the `SyncOperation(clientId, operationId)` unique receipt table,
   `SyncDeletion` tombstones for the hard-delete paths, **and a monotonic `revision` for
   `Contact`/`Item`/`ContactItem`/`Document` — none of which have one today** (only
   `updatedAt`, which cannot support "do not silently overwrite newer server data" on
   the server side). Push must re-drive the existing services and the calculation
   engine rather than write rows from a client payload: prices, totals, statuses and
   numbers stay server-authoritative, and issuance goes through
   `allocateDocumentNumber()` under `FOR UPDATE`. This is a Prisma migration plus two
   handlers, and the migration belongs with the endpoints that consume it — writing an
   unverifiable schema change into the chain would be worse than documenting the gap. It
   must be verified through `scripts/db/cleanroom-chain.sh` against the throwaway
   cluster (already running on `127.0.0.1:55499`); applying anything to the live Supabase
   project still needs the owner's go-ahead, and #38 (RLS inert) still frames every
   authorization claim.
2. **#62 — the static offline client in both shells** with `Local/Queued/Synced/
Rejected/Conflict` labels and `LOCAL <shortId>` temporary identifiers. The shells
   still carry placeholder `web/index.html`; a bundling step (esbuild or vite lib mode)
   has to be added to the shell packages first, because `@amisibiz/offline` ships source
   and WebView shells have no loader for it.
3. **#63 — the real Android build** (`cap add android` → `gradlew assembleDebug`), then
   the runtime pass on the six behaviours; build success and runtime success reported
   separately.
4. **#65 — the server-side synchronization tests** the moment #61 exists: duplicate
   retry against the real endpoint, conflict, expired bearer, revoked session version,
   suspended tenant write gate, foreign-tenant cursor refused, tombstone pruning.
5. **#66 closeout** beyond this report: nothing outstanding in docs — `offline-client-
design.md` now carries §12 "Built, and not built".

## 6. Standing rules, checked rather than asserted

- No privileged key is in an installed bundle: enforced by the scan over both shell
  `web/` directories, not by review (§3).
- Client-supplied tenant ids, prices, totals, statuses and numbers are never trusted:
  the device stores a tenant's data only after `bindSession`/provisioning, `applyPullPage`
  refuses a frame whose `tenantId` is not the device's tenant (`PullContractError`, the
  page rolls back, the cursor does not move), and no local path can mark a document
  `ISSUED` with a server number — a number arrives only in a pull frame, tested.
- No silent overwrite: a dirty local row is protected by revision comparison, and both
  sides of a disagreement are kept.
- Nothing is claimed as deployed, submitted, built or passing that was not. Android and
  Windows are reported as not built (§4); the endpoints are reported as not existing
  (§5); `pnpm test`'s 26 skipped tests are reported as skipped.
- `.kilo/`, `.env*` and `uploads/` are not staged; **no commit was made for this phase**
  — the tree is left for the owner's decision, as with the previous phases.

---

Deliverables mapping: **offline design** →
[`../architecture/offline-client-design.md`](../architecture/offline-client-design.md);
**migration strategy** → that document §3 (checksummed local migrations) and §5/§12
(server-side revision/receipt/tombstone migration, deliberately deferred with its
verification path named); **synchronization tests** →
`apps/web/tests/phase06-offline-storage.test.ts`,
`apps/web/tests/phase06-sync-engine.test.ts`; **build prerequisites** → design §10;
**documented limitations** → design §8.1 and §12, and §4–§5 of this report.
