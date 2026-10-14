import type { QueuedOperation } from "./queue";

/**
 * Transport seam between an offline-capable client and the AmisiBiz server.
 *
 * CONTRACTS ONLY — nothing in this package is implemented or wired yet. The
 * offline architecture is designed in Phase 04.5d and implemented in a later
 * phase; these interfaces exist now so `apps/mobile` and `apps/desktop` are
 * scaffolded against a stable shape rather than inventing their own.
 *
 * Honesty rules that bind every implementation (constitution):
 * - No fabricated sync success: a push result reflects what the server
 *   actually confirmed.
 * - The push carries each operation's client-generated id as its idempotency
 *   key; retrying a push must never double-apply an operation.
 */

export type SyncPushOutcome =
  | { status: "applied" }
  | { status: "duplicate"; operationId: string }
  | { status: "rejected"; reason: string }
  | { status: "conflict"; conflictId: string };

export type SyncPushRequest = {
  /** Stable installation id (UUID v4) generated on first launch. */
  clientId: string;
  /** Ordered operations; each carries its own idempotency key (`id`). */
  operations: QueuedOperation[];
};

export type SyncPushResult = {
  outcomes: Array<{ operationId: string; outcome: SyncPushOutcome }>;
};

/** One page of server changes for the client's local replica. */
export type SyncPullPage = {
  /** Opaque cursor to pass on the next pull; null when fully caught up. */
  nextCursor: string | null;
  changes: unknown[];
};

export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResult>;
  pull(since: string | null): Promise<SyncPullPage>;
}
