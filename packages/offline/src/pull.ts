import type { SqlDriver } from "./driver";
import type { SqlRow } from "./types";
import {
  PULL_ENTITIES,
  assertFrameTenant,
  type PullApplier,
  type PullEntity,
  type PullFrame,
} from "./changes";
import { assertMirroredTable, readRowState } from "./sync-state";
import type { ConflictRepository } from "./exchange";

/**
 * Applying a page of server changes.
 *
 * This file is the only place that decides whether a frame may touch a local
 * row, which is why the decision lives here rather than inside each
 * repository's `applyPull`: the repositories hold column-by-column knowledge,
 * and this holds the one rule the directive makes non-negotiable — **do not
 * overwrite newer server data silently**, and equally, do not overwrite an
 * unsynchronized local change silently either.
 *
 * ## What counts as "dirty"
 *
 * A row whose `sync_state` is `local`, `pending` or `rejected` carries work
 * that exists only on this device. `conflict` means a disagreement is already
 * open. Only `synced` rows are the server's to replace.
 *
 * `pending` is the interesting case. The push path moves a row to `synced` the
 * moment the server confirms the operation (`SyncPushOutcome.status ===
 * "applied"` is a fact about the server, not a hope), so a row still in
 * `pending` here is one the device has *not* successfully sent — and a server
 * frame arriving for it is a genuine two-sided edit. That is why a frame that
 * matches a `pending` row raises a conflict instead of being treated as the
 * echo of our own write.
 *
 * ## Which entities are checked
 *
 * Only the four entities the device can author: `contact`, `item`,
 * `customer_price`, `document`. A document's lines, a contact's addresses and
 * the payment and status-event rows ride with their parent — they are
 * synchronized as part of the parent operation, so checking them separately
 * would turn one disagreement into fifteen.
 *
 * ## What a page failure means
 *
 * The whole page runs in one transaction. A frame the client cannot interpret
 * (unknown entity, wrong tenant, a contract break inside an applier) aborts it,
 * and an aborted page never advances the cursor: the next pull re-requests the
 * same range. Conflicts are *not* failures — they are recorded, the local row
 * is left exactly as it was, and the page continues, because refusing to
 * discard either side is the outcome, not an error.
 */

/** Entities the device authors, so entities a frame could stomp on. */
const DIRTY_CHECKED: readonly string[] = [
  "contact",
  "item",
  "customer_price",
  "document",
];

export interface PullPage {
  readonly changes: readonly PullFrame[];
  readonly nextCursor: string | null;
  /** The server's clock for this page, stored so "last synced" is not a device guess. */
  readonly serverTime?: string | null;
}

export interface ApplyPullPageOptions {
  readonly driver: SqlDriver;
  readonly tenantId: string;
  readonly page: PullPage;
  readonly appliers: Readonly<Partial<Record<PullEntity, PullApplier>>>;
  readonly conflicts?: ConflictRepository;
  readonly recordCheckpoint?: (
    cursor: string | null,
    serverTime: string | null,
  ) => Promise<void>;
}

export interface PullFrameOutcome {
  readonly entity: string;
  readonly id: string;
  readonly result: "applied" | "already-current" | "conflict";
}

export interface PullPageResult {
  readonly applied: number;
  readonly alreadyCurrent: number;
  readonly conflicts: number;
  readonly frames: number;
  readonly outcomes: readonly PullFrameOutcome[];
}

export class PullContractError extends Error {
  constructor(
    readonly entity: string,
    readonly frameId: string,
    message: string,
  ) {
    super(`Pull page aborted — ${entity} frame ${frameId}: ${message}`);
    this.name = "PullContractError";
  }
}

/**
 * A row's contents as the server last saw them is not what is being protected
 * here — the *local* version is, so the conflict record has to carry it.
 * `SELECT *` is safe only because the table name has passed through
 * `assertMirroredTable`; a name from a frame never reaches this line.
 */
async function readLocalRow(
  driver: SqlDriver,
  entity: string,
  id: string,
): Promise<SqlRow | null> {
  const table = assertMirroredTable(entity);
  return driver.get<SqlRow>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
}

/** True when the local row holds work the server has not confirmed. */
function isDirty(syncState: string): boolean {
  return syncState !== "synced";
}

export async function applyPullPage(
  options: ApplyPullPageOptions,
): Promise<PullPageResult> {
  const { driver, tenantId, page, appliers } = options;

  // Validated before anything is written: a page naming an entity this client
  // cannot store is a protocol disagreement, and half-applying it would leave
  // the device with a plausible-looking but incoherent dataset.
  for (const frame of page.changes) {
    if (!(PULL_ENTITIES as readonly string[]).includes(frame.entity)) {
      throw new PullContractError(
        frame.entity,
        frame.id,
        `is not an entity this client knows how to store`,
      );
    }
    // Checked here as well as inside the appliers, so a cross-tenant frame
    // cannot be partially applied before the applier notices.
    assertFrameTenant(frame, tenantId);
  }

  const outcomes: PullFrameOutcome[] = [];

  await driver.transaction(async () => {
    for (const frame of page.changes) {
      const applier = appliers[frame.entity as PullEntity];
      if (!applier) {
        throw new PullContractError(
          frame.entity,
          frame.id,
          "has no applier in this build — the client and server disagree about what syncs",
        );
      }

      const checked = DIRTY_CHECKED.includes(frame.entity);
      const state = checked
        ? await readRowState(driver, frame.entity, frame.id)
        : null;

      if (
        state &&
        state.syncState === "synced" &&
        state.baseRevision !== null &&
        state.baseRevision >= frame.revision
      ) {
        // The cursor is `(updated_at, id)`; a page boundary can legitimately
        // repeat a row. Re-applying an identical revision would churn the
        // local copy for no reason, so it is reported as already current.
        outcomes.push({
          entity: frame.entity,
          id: frame.id,
          result: "already-current",
        });
        continue;
      }

      // A tombstone is included deliberately. "The server deleted this row" and
      // "this device has unsent edits to this row" is the same disagreement as
      // any other, and discarding the local side quietly is the failure the
      // directive names. The row keeps its data and the conflict record says
      // what happened; `discarded` is the user's choice to make, not this
      // loop's.
      if (state && checked && isDirty(state.syncState)) {
        const localRow = await readLocalRow(driver, frame.entity, frame.id);
        if (options.conflicts) {
          await options.conflicts.open({
            tenantId,
            operationId: `pull:${frame.entity}:${frame.id}`,
            entity: frame.entity,
            entityId: frame.id,
            serverRevision: frame.revision,
            baseRevision: state.baseRevision,
            serverSnapshot: frame.data,
            localPayload: localRow ?? {},
          });
        }
        outcomes.push({
          entity: frame.entity,
          id: frame.id,
          result: "conflict",
        });
        continue;
      }

      await applier.applyPull(frame, tenantId);
      outcomes.push({ entity: frame.entity, id: frame.id, result: "applied" });
    }

    // Inside the transaction, so a frame that threw half-way through the page
    // cannot leave a cursor pointing past data that was never written.
    if (options.recordCheckpoint) {
      await options.recordCheckpoint(page.nextCursor, page.serverTime ?? null);
    }
  });

  return {
    applied: outcomes.filter((outcome) => outcome.result === "applied").length,
    alreadyCurrent: outcomes.filter(
      (outcome) => outcome.result === "already-current",
    ).length,
    conflicts: outcomes.filter((outcome) => outcome.result === "conflict")
      .length,
    frames: page.changes.length,
    outcomes,
  };
}
