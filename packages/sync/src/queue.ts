/**
 * Offline operation-queue contracts.
 *
 * An offline-capable client records user actions as operations in a local
 * (SQLite) queue and replays them when connectivity returns. The operation
 * `id` is generated on the client and is the single idempotency key the
 * server uses, so a replayed push can never create duplicates.
 *
 * Phase 06 implemented this queue as `LocalOutbox` in `@amisibiz/offline`.
 */

export type OperationStatus =
  "pending" | "in_flight" | "applied" | "failed" | "conflict";

export type QueuedOperation<TPayload = unknown> = {
  /** Client-generated UUID — also the server-side idempotency key. */
  id: string;
  /** Operation type, e.g. "contact.create" — resolved by the sync service. */
  type: string;
  /**
   * The entity this operation describes, which is the local table name and the
   * server's table name. Sent explicitly because the alternative is the server
   * guessing from the type's prefix: a client that got the prefix right and the
   * entity wrong would have its write applied to the wrong table, and an
   * operation the server cannot route without parsing a name is a contract that
   * is not a contract.
   */
  entity: string;
  /**
   * The client-generated id of the row this operation describes. Together with
   * `entity` it is the server's upsert key, and it is why a retried create
   * cannot mint a second record.
   */
  entityId: string;
  payload: TPayload;
  /**
   * When the client observed the change (ISO-8601 UTC). Display/debug only:
   * a device clock is NEVER sufficient to resolve a conflict (constitution).
   */
  createdAt: string;
  attempts: number;
  status: OperationStatus;
  lastError: string | null;
  /**
   * The server revision this local change was made against, when the device had
   * one. A create carries none; an edit carries the revision the pull page
   * handed over. The server uses it for optimistic concurrency, which is how
   * "do not silently overwrite newer server data" is enforced rather than just
   * intended — an update with no base revision cannot be checked, so a client
   * that has one must send it.
   */
  baseRevision?: number | null;
};

/**
 * The queue an offline client persists. `@amisibiz/offline`'s `LocalOutbox` is
 * its only implementation, and the conformance is asserted at compile time in
 * `packages/offline/src/sync-client.ts` — a contract nothing satisfies is
 * decoration, so this shape is the shape the storage layer actually has:
 *
 *   - claiming takes a **generation token**, because "the app died mid-push"
 *     must be distinguishable from "another loop is pushing right now";
 *   - recovery is a first-class method, not an accident of `nextPending`,
 *     because the operations it returns keep their ids and are therefore
 *     recognised as retries by the server, not as new work;
 *   - `rejected` is separate from `failed`: a policy refusal must not be
 *     retried, while a dropped connection must be.
 */
export interface OperationQueue {
  claimPending(generation: string, limit: number): Promise<QueuedOperation[]>;
  recoverInterrupted(generation: string): Promise<QueuedOperation[]>;
  /**
   * The four state transitions below are declared `Promise<unknown>` rather
   * than `Promise<void>` for one reason: the durable implementation hands back
   * the queue row as it now stands, which a screen that just acted on an
   * operation can use without a second read. A `void` contract would make that
   * convenience a type error while telling the caller nothing it needs. Outside
   * `@amisibiz/offline`, do not read the value — treat these as transitions.
   */
  markApplied(id: string, revision?: number | null): Promise<unknown>;
  markFailed(id: string, error: string): Promise<unknown>;
  markRejected(id: string, reason: string): Promise<unknown>;
  markConflict(id: string, reason: string): Promise<unknown>;
  /**
   * Returns a whole batch to `pending` without counting an attempt, for the
   * case where the *exchange* failed rather than the operation: the session
   * expired, the connection dropped before the server could decide. Counting an
   * attempt there would eventually mark good local drafts permanently failed
   * for a reason that has nothing to do with them.
   */
  release(ids: readonly string[], reason: string): Promise<unknown>;
  pendingCount(): Promise<number>;
}
