/**
 * Offline operation-queue contracts (CONTRACTS ONLY — see transport.ts).
 *
 * An offline-capable client records user actions as operations in a local
 * (SQLite) queue and replays them when connectivity returns. The operation
 * `id` is generated on the client and is the single idempotency key the
 * server uses, so a replayed push can never create duplicates.
 */

export type OperationStatus =
  "pending" | "in_flight" | "applied" | "failed" | "conflict";

export type QueuedOperation<TPayload = unknown> = {
  /** Client-generated UUID — also the server-side idempotency key. */
  id: string;
  /** Operation type, e.g. "contact.create" — resolved by the sync service. */
  type: string;
  payload: TPayload;
  /**
   * When the client observed the change (ISO-8601 UTC). Display/debug only:
   * a device clock is NEVER sufficient to resolve a conflict (constitution).
   */
  createdAt: string;
  attempts: number;
  status: OperationStatus;
  lastError: string | null;
};

export interface OperationQueue {
  enqueue(operation: QueuedOperation): Promise<void>;
  nextPending(limit: number): Promise<QueuedOperation[]>;
  markInFlight(id: string): Promise<void>;
  markApplied(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  markConflict(id: string, conflictId: string): Promise<void>;
  pendingCount(): Promise<number>;
}
