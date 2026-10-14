/**
 * Conflict-handling contracts (CONTRACTS ONLY — see transport.ts).
 *
 * Conflict resolution requires a server outcome or an explicit user decision.
 * Device timestamps are never a tie-breaker (constitution); a local value is
 * never authoritative proof of anything server-side.
 */

export type ConflictStrategy = "server_wins" | "client_wins" | "manual";

export type ConflictRecord = {
  id: string;
  operationId: string;
  /** Opaque server revision token the client's change collided with. */
  serverRevision: string;
  /** Opaque client revision token that was rejected. */
  clientRevision: string;
  detectedAt: string;
  resolvedAt: string | null;
  strategy: ConflictStrategy | null;
};

export interface ConflictStore {
  listOpen(): Promise<ConflictRecord[]>;
  /** Records the user's or policy's decision; resolution is applied on next sync. */
  resolve(conflictId: string, strategy: ConflictStrategy): Promise<void>;
}
