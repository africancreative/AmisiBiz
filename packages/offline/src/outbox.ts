import type { SqlDriver } from "./driver";
import { fromJsonValue, toJsonValue } from "./driver";
import { newUuid } from "./ids";
import { placeholders } from "./sync-state";
import type { OperationStatus } from "./constants";

/**
 * The durable client outbox — the storage half of the queue contract in
 * `@amisibiz/sync` (`packages/sync/src/queue.ts`).
 *
 * The behaviour that matters here is not the rows, it is *when* a row exists:
 * `enqueue` performs a plain INSERT and expects the caller to be inside
 * `driver.transaction()`, because the local change and its operation must
 * commit together or not at all. That single rule is what makes recovery after
 * an interruption a property of the storage layer rather than a retry loop:
 * after a crash there is never a draft with no operation, and never an
 * operation describing a draft that was not written.
 *
 * SQLite cannot nest transactions, so nothing in this file opens one.
 */

/** The row kind an operation describes. Mirrors the local table names. */
export type OutboxEntity =
  | "contact"
  | "contact_address"
  | "item"
  | "customer_price"
  | "document"
  | "document_line";

export interface OutboxOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly entity: OutboxEntity;
  readonly entityId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly baseRevision: number | null;
  readonly status: OperationStatus;
  readonly attempts: number;
  readonly generation: string | null;
  readonly lastError: string | null;
  readonly rejectedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAttemptAt: string | null;
  readonly appliedAt: string | null;
  readonly seq: number;
}

export interface NewOperation {
  /** Client-generated so a retry re-sends the same id (the server's dedupe key). */
  readonly id?: string;
  readonly tenantId: string;
  readonly entity: OutboxEntity;
  readonly entityId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly baseRevision?: number;
}

export interface OutboxOptions {
  /** Attempt count after which an operation stops being retried. */
  readonly maxAttempts?: number;
  /** Backoff base in ms, doubled per attempt and capped at `maxBackoffMs`. */
  readonly backoffBaseMs?: number;
  readonly maxBackoffMs?: number;
  /** Injectable so jitter is assertable in tests. */
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;

const COLUMNS = `id, tenant_id, entity, entity_id, type, payload, base_revision,
                 status, attempts, generation, last_error, rejected_reason,
                 created_at, updated_at, next_attempt_at, applied_at, seq`;

function rowToOperation(row: OutboxRow): OutboxOperation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entity: row.entity as OutboxEntity,
    entityId: row.entity_id,
    type: row.type,
    payload: fromJsonValue<unknown>(row.payload),
    baseRevision:
      row.base_revision === null || row.base_revision === undefined
        ? null
        : Math.trunc(Number(row.base_revision)),
    status: row.status as OperationStatus,
    attempts: Math.trunc(Number(row.attempts)),
    generation: row.generation,
    lastError: row.last_error,
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    appliedAt: row.applied_at,
    seq: Math.trunc(Number(row.seq)),
  };
}

type OutboxRow = {
  id: string;
  tenant_id: string;
  entity: string;
  entity_id: string;
  type: string;
  payload: string;
  base_revision: string | number | null;
  status: string;
  attempts: string | number;
  generation: string | null;
  last_error: string | null;
  rejected_reason: string | null;
  created_at: string;
  updated_at: string;
  next_attempt_at: string | null;
  applied_at: string | null;
  seq: string | number;
};

export class LocalOutbox {
  private readonly driver: SqlDriver;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(driver: SqlDriver, options: OutboxOptions = {}) {
    this.driver = driver;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? newUuid;
  }

  /**
   * Records one operation. **Call inside the transaction that writes the local
   * row** — the method deliberately does not open one.
   */
  async enqueue(operation: NewOperation): Promise<OutboxOperation> {
    const id = operation.id ?? this.newId();
    const timestamp = this.now().toISOString();

    const row = await this.driver.get<{ next: string | number | null }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM outbox_operation`,
    );
    const seq = Math.trunc(Number(row?.next ?? 1));

    await this.driver.run(
      `INSERT INTO outbox_operation (${COLUMNS})
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        operation.tenantId,
        operation.entity,
        operation.entityId,
        operation.type,
        toJsonValue(operation.payload) ?? "null",
        operation.baseRevision ?? null,
        "pending",
        0,
        null,
        null,
        null,
        timestamp,
        timestamp,
        null,
        null,
        seq,
      ],
    );

    const created = await this.findById(id);
    if (!created) {
      throw new Error(`Outbox insert for ${id} did not persist`);
    }
    return created;
  }

  async findById(id: string): Promise<OutboxOperation | null> {
    const row = await this.driver.get<OutboxRow>(
      `SELECT ${COLUMNS} FROM outbox_operation WHERE id = ?`,
      [id],
    );
    return row ? rowToOperation(row) : null;
  }

  /**
   * Claims the next batch to push, in `seq` order, and marks it `in_flight`
   * under `generation`.
   *
   * Ordering is part of the contract: the engine must never send a line
   * operation before the document operation that creates its parent, and a
   * single-transaction claim is what stops two concurrent pushes on the same
   * device from interleaving batches.
   */
  async claimPending(
    generation: string,
    limit = 20,
  ): Promise<OutboxOperation[]> {
    const dueBy = this.now().toISOString();

    return this.driver.transaction(async () => {
      const rows = await this.driver.all<OutboxRow>(
        `SELECT ${COLUMNS} FROM outbox_operation
          WHERE status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY seq ASC
          LIMIT ?`,
        [dueBy, limit],
      );
      if (rows.length === 0) return [];

      const placeholders = rows.map(() => "?").join(",");
      await this.driver.run(
        `UPDATE outbox_operation
            SET status = 'in_flight', generation = ?, updated_at = ?
          WHERE id IN (${placeholders})`,
        [generation, dueBy, ...rows.map((row) => row.id)],
      );

      // Re-read what the UPDATE just wrote. Returning the pre-claim rows would
      // hand the caller operations that still say `pending` with no generation
      // — the fields the push path and the crash-recovery path both read.
      const claimed = await this.driver.all<OutboxRow>(
        `SELECT ${COLUMNS} FROM outbox_operation
          WHERE id IN (${placeholders}) ORDER BY seq ASC`,
        rows.map((row) => row.id),
      );
      return claimed.map(rowToOperation);
    });
  }

  /**
   * Start-up recovery: anything still `in_flight` under an older generation is
   * work the previous process died on. It returns to `pending` **with the same
   * operation id**, so the resend is answered `duplicate` by the server instead
   * of becoming a second record.
   */
  async recoverInterrupted(
    currentGeneration: string,
  ): Promise<OutboxOperation[]> {
    return this.driver.transaction(async () => {
      const rows = await this.driver.all<OutboxRow>(
        `SELECT ${COLUMNS} FROM outbox_operation
          WHERE status = 'in_flight'
            AND (generation IS NULL OR generation <> ?)
          ORDER BY seq ASC`,
        [currentGeneration],
      );

      if (rows.length === 0) return [];

      const timestamp = this.now().toISOString();
      for (const row of rows) {
        await this.driver.run(
          `UPDATE outbox_operation
              SET status = 'pending', generation = NULL, attempts = attempts + 1,
                  last_error = COALESCE(last_error, 'Interrupted before the result was recorded'),
                  updated_at = ?
            WHERE id = ?`,
          [timestamp, row.id],
        );
      }

      // Same rule as the claim: the caller gets the state that is now in the
      // table — `pending`, no generation, one attempt counted — because that
      // state is what decides whether the operation is sent again.
      const placeholders = rows.map(() => "?").join(",");
      const recovered = await this.driver.all<OutboxRow>(
        `SELECT ${COLUMNS} FROM outbox_operation
          WHERE id IN (${placeholders}) ORDER BY seq ASC`,
        rows.map((row) => row.id),
      );
      return recovered.map(rowToOperation);
    });
  }

  /**
   * Returns a whole batch to `pending` **without counting an attempt**.
   *
   * For the cases where the exchange never reached the server's decision: the
   * session expired, the network dropped before a byte was sent. An attempt is
   * evidence about the *operation*, and the absence of a connection is not
   * evidence about anything, so letting it climb the attempt ceiling would
   * eventually mark local drafts permanently failed for a reason that has
   * nothing to do with them. The reason is still recorded, because the user
   * asking "why hasn't this synced" deserves the true answer.
   */
  async release(ids: readonly string[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    const timestamp = this.now().toISOString();
    await this.driver.run(
      `UPDATE outbox_operation
          SET status = 'pending', generation = NULL, last_error = ?,
              next_attempt_at = NULL, updated_at = ?
        WHERE id IN (${placeholders(ids.length)})`,
      [reason, timestamp, ...ids],
    );
  }

  /** A network failure returns the batch to `pending` with backoff, or to `failed` at the cap. */
  async markFailed(id: string, error: string): Promise<OutboxOperation | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const attempts = existing.attempts + 1;
    const timestamp = this.now().toISOString();
    const exhausted = attempts >= this.maxAttempts;

    await this.driver.run(
      `UPDATE outbox_operation
          SET status = ?, attempts = ?, generation = NULL, last_error = ?,
              next_attempt_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        exhausted ? "failed" : "pending",
        attempts,
        error,
        exhausted ? null : this.backoffAt(attempts, timestamp),
        timestamp,
        id,
      ],
    );
    return this.findById(id);
  }

  /**
   * A policy rejection (no permission, suspended tenant, expired session) is
   * permanent: the next attempt would fail identically, so retrying it would
   * only burn battery and delay the user seeing the reason.
   */
  async markRejected(
    id: string,
    reason: string,
  ): Promise<OutboxOperation | null> {
    await this.driver.run(
      `UPDATE outbox_operation
          SET status = 'failed', generation = NULL, rejected_reason = ?,
              next_attempt_at = NULL, updated_at = ?
        WHERE id = ?`,
      [reason, this.now().toISOString(), id],
    );
    return this.findById(id);
  }

  async markConflict(
    id: string,
    conflictReason: string,
  ): Promise<OutboxOperation | null> {
    await this.driver.run(
      `UPDATE outbox_operation
          SET status = 'conflict', generation = NULL, last_error = ?,
              next_attempt_at = NULL, updated_at = ?
        WHERE id = ?`,
      [conflictReason, this.now().toISOString(), id],
    );
    return this.findById(id);
  }

  /** The server accepted it. The row id stays; only the queue state moves. */
  async markApplied(id: string): Promise<OutboxOperation | null> {
    const timestamp = this.now().toISOString();
    await this.driver.run(
      `UPDATE outbox_operation
          SET status = 'applied', generation = NULL, attempts = attempts + 1,
              last_error = NULL, next_attempt_at = NULL, applied_at = ?, updated_at = ?
        WHERE id = ?`,
      [timestamp, timestamp, id],
    );
    return this.findById(id);
  }

  /** Applies a whole batch in one transaction — a partial outcome would be worse than none. */
  async markAppliedBatch(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.driver.transaction(async () => {
      for (const id of ids) {
        await this.markApplied(id);
      }
    });
  }

  async discardApplied(olderThan: string): Promise<number> {
    const result = await this.driver.run(
      `DELETE FROM outbox_operation WHERE status = 'applied' AND applied_at IS NOT NULL AND applied_at < ?`,
      [olderThan],
    );
    return result.changes;
  }

  async pendingCount(tenantId?: string): Promise<number> {
    const row = tenantId
      ? await this.driver.get<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM outbox_operation
            WHERE tenant_id = ? AND status IN ('pending','in_flight')`,
          [tenantId],
        )
      : await this.driver.get<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM outbox_operation
            WHERE status IN ('pending','in_flight')`,
        );
    return Math.trunc(Number(row?.count ?? 0));
  }

  /** Counts per status — what the UI's "N waiting to sync" chip reads. */
  async statusCounts(
    tenantId?: string,
  ): Promise<Record<OperationStatus, number>> {
    const rows = tenantId
      ? await this.driver.all<{ status: string; count: string | number }>(
          `SELECT status, COUNT(*) AS count FROM outbox_operation
            WHERE tenant_id = ? GROUP BY status`,
          [tenantId],
        )
      : await this.driver.all<{ status: string; count: string | number }>(
          `SELECT status, COUNT(*) AS count FROM outbox_operation GROUP BY status`,
        );

    const counts: Record<OperationStatus, number> = {
      pending: 0,
      in_flight: 0,
      applied: 0,
      failed: 0,
      conflict: 0,
    };
    for (const row of rows) {
      const status = row.status as OperationStatus;
      if (status in counts) counts[status] = Math.trunc(Number(row.count));
    }
    return counts;
  }

  /** The queue in push order, including rows already settled (the review screen reads this). */
  async list(
    tenantId: string,
    statuses?: readonly OperationStatus[],
  ): Promise<OutboxOperation[]> {
    const rows =
      statuses && statuses.length > 0
        ? await this.driver.all<OutboxRow>(
            `SELECT ${COLUMNS} FROM outbox_operation
            WHERE tenant_id = ? AND status IN (${statuses.map(() => "?").join(",")})
            ORDER BY seq ASC`,
            [tenantId, ...statuses],
          )
        : await this.driver.all<OutboxRow>(
            `SELECT ${COLUMNS} FROM outbox_operation WHERE tenant_id = ? ORDER BY seq ASC`,
            [tenantId],
          );
    return rows.map(rowToOperation);
  }

  /** Exponential backoff with jitter, capped at `maxBackoffMs`. */
  private backoffAt(attempts: number, from: string): string {
    const doubled = this.backoffBaseMs * 2 ** Math.max(0, attempts - 1);
    const capped = Math.min(doubled, this.maxBackoffMs);
    const jitter = capped * 0.25 * this.random();
    return new Date(Date.parse(from) + capped + jitter).toISOString();
  }
}
