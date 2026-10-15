import type { QueuedOperation } from "./queue";

/**
 * Transport seam between an offline-capable client and the AmisiBiz server.
 *
 * These are the shapes the client and the server agree on; the *implementation*
 * that speaks them is Phase 06 and lives with the storage layer
 * (`@amisibiz/offline`, `httpSyncTransport`) because that is where the durable
 * queue, the tenant binding and the conflict records already are. This package
 * stays dependency-free so both installed shells and the server can compile
 * against it.
 *
 * Honesty rules that bind every implementation (constitution):
 * - No fabricated sync success: a push result reflects what the server
 *   actually confirmed.
 * - The push carries each operation's client-generated id as its idempotency
 *   key; retrying a push must never double-apply an operation.
 * - The client is the author of its own ids; the server is the author of
 *   numbers, revisions, roles, activation and payment state.
 *
 * ## What changed when Phase 06 implemented this
 *
 * Additive only, and every addition is optional so an older client still parses:
 * `applied` and `duplicate` may carry the server's new `revision` for the row,
 * and `conflict` may carry the `serverRevision` it collided with. Without those,
 * a client that keeps a local replica cannot record what version it now holds,
 * and the next push would have no base revision to be refused against.
 * `duplicate` no longer repeats `operationId`: every outcome already arrives
 * wrapped in the id it describes.
 */

export type SyncPushOutcome =
  /** The server applied it. `revision` is its revision for the row afterwards. */
  | { status: "applied"; revision?: number | null }
  /**
   * The server had already applied this operation id — a retry after a dropped
   * response. It is a success, not an error, and the row is now synchronized.
   */
  | { status: "duplicate"; revision?: number | null }
  /**
   * A policy refusal (no permission, suspended tenant, expired authorization).
   * Retrying cannot change the answer, so the client keeps the local draft and
   * shows `reason` instead of burning the battery on it.
   */
  | { status: "rejected"; reason: string }
  /**
   * The server's row moved under the client's change. Both versions are kept
   * for a decision; the client never resolves this by itself.
   */
  | { status: "conflict"; conflictId: string; serverRevision?: number | null };

export type SyncPushRequest = {
  /** Stable installation id (UUID v4) generated on first launch. */
  clientId: string;
  /** Ordered operations; each carries its own idempotency key (`id`). */
  operations: QueuedOperation[];
  /**
   * The local schema version the client is running (design §3). A server that
   * cannot safely answer an out-of-date replica refuses the batch instead of
   * sending columns the client would mis-store; the field is optional so a
   * client predating it still parses, and `@amisibiz/offline`'s `SyncClient`
   * always sends it.
   */
  schemaVersion?: number;
};

export type SyncPushResult = {
  outcomes: Array<{ operationId: string; outcome: SyncPushOutcome }>;
  /**
   * The server's clock, when it chooses to send one. The client uses it for the
   * "last authorized exchange" timestamp instead of trusting a device clock
   * (constitution); it never uses it to order changes.
   */
  serverTime?: string | null;
};

/**
 * One row as the server last wrote it — the unit of a pull page.
 *
 * `revision` is the ordering authority for the whole exchange: a client decides
 * whether a frame may replace a local row by comparing revisions, never by
 * comparing the device clock with anything (constitution). `deleted` is a
 * tombstone: hard-deleted server rows still have to reach a device that holds a
 * copy, or the copy becomes a ghost record that no one can explain.
 */
export type SyncChangeFrame = {
  readonly entity: string;
  readonly id: string;
  readonly revision: number;
  readonly deleted: boolean;
  readonly updatedAt: string;
  readonly data: Readonly<Record<string, unknown>>;
};

/** One page of server changes for the client's local replica. */
export type SyncPullPage = {
  /** Opaque cursor to pass on the next pull; null when fully caught up. */
  nextCursor: string | null;
  changes: readonly SyncChangeFrame[];
  /**
   * The server's clock, so "last synced" is a server fact rather than a device
   * guess. A client stores it and never uses it to order anything.
   */
  serverTime?: string | null;
};

export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResult>;
  pull(since: string | null): Promise<SyncPullPage>;
}
