/**
 * Conflict-handling contracts.
 *
 * Conflict resolution requires a server outcome or an explicit user decision.
 * Device timestamps are never a tie-breaker (constitution); a local value is
 * never authoritative proof of anything server-side.
 *
 * ## Why these shapes look the way they do
 *
 * They are the shapes `@amisibiz/offline` persists in its `conflict` table,
 * which is where a conflict actually becomes survivable: a disagreement that
 * lives only in memory is lost when the app closes, and the one thing the
 * directive forbids is losing either side of a collision.
 *
 * The earlier draft of this file named strategies `server_wins` /
 * `client_wins` / `manual`. Phase 06 replaced them with the three outcomes a
 * device can honestly record, because "server wins" as an automatic policy *is*
 * the silent overwrite the rules forbid, and "client wins" as a policy would
 * let a device decide that its unsent version is authoritative:
 *
 *   - `kept_server` — the user chose the server's row and let their local
 *     version go;
 *   - `reapplied_local` — the user chose to offer their local version again,
 *     as a new operation against the server's current revision (the only
 *     "local wins", and it is an explicit act, not a default);
 *   - `discarded` — the local change was thrown away deliberately.
 *
 * There is no `auto`. `phase06-sync-engine.test.ts` asserts that this list and
 * the values the local `conflict` table's CHECK constraint accepts are the same
 * list, so the contract and the storage guard cannot drift apart silently.
 */

/**
 * The three endings a device may record for one disagreement, as a value as
 * well as a type: `phase06-sync-engine.test.ts` compares this list with the
 * `conflict.resolution` CHECK constraint in `@amisibiz/offline`, so the contract
 * and the storage guard cannot drift apart without a test failing.
 */
export const CONFLICT_RESOLUTIONS = [
  "kept_server",
  "reapplied_local",
  "discarded",
] as const;

/** The three outcomes a device may record for one disagreement. */
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export type ConflictRecord = {
  id: string;
  tenantId: string;
  /**
   * The operation that collided. A conflict found while pulling, when the
   * device has no queued operation for the row yet, uses
   * `pull:<entity>:<entityId>` so the key stays unique per (tenant, operation).
   */
  operationId: string;
  /** The table the row belongs to, which is also the entity name. */
  entity: string;
  entityId: string;
  /** The server's revision the local change collided with. */
  serverRevision: number;
  /** The revision the local change was made against, when it had one. */
  baseRevision: number | null;
  /** The server's row, as the pull frame carried it. */
  serverSnapshot: unknown;
  /** The local row, as it stood when the frame was refused. */
  localPayload: unknown;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: ConflictResolution | null;
};

/**
 * Where conflicts live. `ConflictRepository` in `@amisibiz/offline` implements
 * this; opening one needs the storage layer's transaction, so it is not part of
 * the seam.
 */
export interface ConflictStore {
  listOpen(tenantId: string): Promise<ConflictRecord[]>;
  get(id: string): Promise<ConflictRecord | null>;
  /**
   * Records the user's decision. Resolution is a *choice plus an action*: the
   * store never rewrites the data row here, because "keep the server copy" is
   * carried out by applying the server frame, and "offer mine again" is carried
   * out by enqueueing a new operation.
   */
  resolve(
    id: string,
    resolution: ConflictResolution,
  ): Promise<ConflictRecord | null>;
  countOpen(tenantId: string): Promise<number>;
}
