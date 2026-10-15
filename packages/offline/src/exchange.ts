import type { SqlDriver } from "./driver";
import { fromJsonValue, toJsonValue } from "./driver";
import { newUuid } from "./ids";
import { CONFLICT_RESOLUTIONS, type ConflictResolution } from "./constants";

/**
 * The two tables that describe *the exchange* rather than the data: where the
 * pull cursor stands, and which rows are in conflict.
 *
 * Both exist so the UI can make an honest statement. A checkpoint written on a
 * failed exchange would claim a synchronization that did not happen; a conflict
 * resolved by quietly overwriting the local draft would destroy the customer's
 * work. Neither is offered by these APIs.
 */

export interface SyncCheckpoint {
  readonly tenantId: string;
  readonly cursor: string | null;
  readonly lastPushAt: string | null;
  readonly lastPullAt: string | null;
  readonly lastError: string | null;
  /** The server's clock at the last successful exchange, for "last synced 4 h ago". */
  readonly serverTime: string | null;
  readonly updatedAt: string;
}

// `type` rather than `interface`, deliberately: `driver.get<T>` constrains `T`
// to `SqlRow`, and TypeScript gives an *interface* no implicit index signature,
// so the same column list declared as an interface would fail the constraint
// while telling nothing about the data.
type CheckpointRow = {
  tenant_id: string;
  cursor: string | null;
  last_push_at: string | null;
  last_pull_at: string | null;
  last_error: string | null;
  server_time: string | null;
  updated_at: string;
};

function toCheckpoint(row: CheckpointRow): SyncCheckpoint {
  return {
    tenantId: row.tenant_id,
    cursor: row.cursor,
    lastPushAt: row.last_push_at,
    lastPullAt: row.last_pull_at,
    lastError: row.last_error,
    serverTime: row.server_time,
    updatedAt: row.updated_at,
  };
}

const CHECKPOINT_SELECT = `tenant_id, cursor, last_push_at, last_pull_at, last_error, server_time, updated_at`;

export class CheckpointRepository {
  private readonly driver: SqlDriver;
  private readonly now: () => Date;

  constructor(driver: SqlDriver, options: { now?: () => Date } = {}) {
    this.driver = driver;
    this.now = options.now ?? (() => new Date());
  }

  async get(tenantId: string): Promise<SyncCheckpoint | null> {
    const row = await this.driver.get<CheckpointRow>(
      `SELECT ${CHECKPOINT_SELECT} FROM sync_checkpoint WHERE tenant_id = ?`,
      [tenantId],
    );
    return row ? toCheckpoint(row) : null;
  }

  /**
   * Only a *completed* page advances the cursor, and only forward. A page that
   * failed midway is re-requested from the last position the server confirmed,
   * which is what "resume after interruption" means here.
   *
   * A null cursor on a successful pull means "from the beginning" and must not
   * erase a cursor the device already had, hence `COALESCE`.
   */
  async recordPull(input: {
    tenantId: string;
    cursor: string | null;
    serverTime: string | null;
  }): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.driver.run(
      `INSERT INTO sync_checkpoint (tenant_id, cursor, last_push_at, last_pull_at, last_error, server_time, updated_at)
       VALUES (?, ?, NULL, ?, NULL, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         cursor       = COALESCE(excluded.cursor, sync_checkpoint.cursor),
         last_pull_at = excluded.last_pull_at,
         last_error   = NULL,
         server_time  = COALESCE(excluded.server_time, sync_checkpoint.server_time),
         updated_at   = excluded.updated_at`,
      [input.tenantId, input.cursor, timestamp, input.serverTime, timestamp],
    );
  }

  /**
   * A push records that it happened and what went wrong. It never touches the
   * pull cursor — a push says nothing about what the device has seen.
   */
  async recordPush(input: {
    tenantId: string;
    error?: string | null;
  }): Promise<void> {
    const timestamp = this.now().toISOString();
    const existing = await this.get(input.tenantId);
    if (!existing) {
      await this.driver.run(
        `INSERT INTO sync_checkpoint (tenant_id, cursor, last_push_at, last_pull_at, last_error, server_time, updated_at)
         VALUES (?, NULL, ?, NULL, ?, NULL, ?)`,
        [input.tenantId, timestamp, input.error ?? null, timestamp],
      );
      return;
    }
    await this.driver.run(
      `UPDATE sync_checkpoint SET last_push_at = ?, last_error = ?, updated_at = ?
        WHERE tenant_id = ?`,
      [timestamp, input.error ?? null, timestamp, input.tenantId],
    );
  }

  /** Drops the cursor so the next pull re-provisions from the start. */
  async invalidate(tenantId: string, reason: string): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.driver.run(
      `UPDATE sync_checkpoint SET cursor = NULL, last_error = ?, updated_at = ?
        WHERE tenant_id = ?`,
      [reason, timestamp, tenantId],
    );
  }
}

export interface LocalConflict {
  readonly id: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly serverRevision: number;
  readonly baseRevision: number | null;
  readonly serverSnapshot: unknown;
  readonly localPayload: unknown;
  readonly detectedAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: ConflictResolution | null;
}

type ConflictRow = {
  id: string;
  tenant_id: string;
  operation_id: string;
  entity: string;
  entity_id: string;
  server_revision: string | number;
  base_revision: string | number | null;
  server_snapshot: string | null;
  local_payload: string;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
};

function toConflict(row: ConflictRow): LocalConflict {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    operationId: row.operation_id,
    entity: row.entity,
    entityId: row.entity_id,
    serverRevision: Math.trunc(Number(row.server_revision)),
    baseRevision:
      row.base_revision === null ? null : Math.trunc(Number(row.base_revision)),
    serverSnapshot: fromJsonValue<unknown>(row.server_snapshot),
    localPayload: fromJsonValue<unknown>(row.local_payload),
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution as ConflictResolution | null,
  };
}

const CONFLICT_COLUMNS = `id, tenant_id, operation_id, entity, entity_id,
                          server_revision, base_revision, server_snapshot,
                          local_payload, detected_at, resolved_at, resolution`;

export class ConflictRepository {
  private readonly driver: SqlDriver;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    driver: SqlDriver,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.driver = driver;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? newUuid;
  }

  /**
   * Records a conflict. Idempotent per (tenant, operation): an exchange that
   * conflicts again refreshes the server side of the record instead of piling
   * up duplicates of the same disagreement.
   */
  async open(input: {
    tenantId: string;
    /** A conflict found while pulling, with no queued operation, uses `pull:<entity>:<id>`. */
    operationId: string;
    entity: string;
    entityId: string;
    serverRevision: number;
    baseRevision: number | null;
    serverSnapshot: unknown;
    localPayload: unknown;
  }): Promise<LocalConflict> {
    const timestamp = this.now().toISOString();
    const existing = await this.driver.get<{ id: string }>(
      `SELECT id FROM conflict WHERE tenant_id = ? AND operation_id = ?`,
      [input.tenantId, input.operationId],
    );

    if (existing) {
      await this.driver.run(
        `UPDATE conflict
            SET server_revision = ?, base_revision = ?, server_snapshot = ?,
                local_payload = ?, detected_at = ?, resolved_at = NULL, resolution = NULL
          WHERE id = ?`,
        [
          input.serverRevision,
          input.baseRevision,
          toJsonValue(input.serverSnapshot),
          toJsonValue(input.localPayload) ?? "null",
          timestamp,
          existing.id,
        ],
      );
      const refreshed = await this.get(existing.id);
      if (!refreshed) {
        throw new Error(`Conflict ${existing.id} vanished while refreshing`);
      }
      return refreshed;
    }

    const id = this.newId();
    await this.driver.run(
      `INSERT INTO conflict (${CONFLICT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      [
        id,
        input.tenantId,
        input.operationId,
        input.entity,
        input.entityId,
        input.serverRevision,
        input.baseRevision,
        toJsonValue(input.serverSnapshot),
        toJsonValue(input.localPayload) ?? "null",
        timestamp,
      ],
    );
    const created = await this.get(id);
    if (!created) throw new Error(`Conflict ${id} did not persist`);
    return created;
  }

  async get(id: string): Promise<LocalConflict | null> {
    const row = await this.driver.get<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM conflict WHERE id = ?`,
      [id],
    );
    return row ? toConflict(row) : null;
  }

  async listOpen(tenantId: string): Promise<LocalConflict[]> {
    const rows = await this.driver.all<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM conflict
        WHERE tenant_id = ? AND resolved_at IS NULL
        ORDER BY detected_at ASC, id ASC`,
      [tenantId],
    );
    return rows.map(toConflict);
  }

  /**
   * Records the user's choice. The caller has already done the work the choice
   * implies (adopt the server copy, or re-apply the local change as a new
   * operation); this only closes the record, so a resolution can never claim to
   * have happened when the data says otherwise.
   */
  async resolve(
    id: string,
    resolution: ConflictResolution,
  ): Promise<LocalConflict | null> {
    if (!(CONFLICT_RESOLUTIONS as readonly string[]).includes(resolution)) {
      throw new Error(
        `"${resolution}" is not a resolution this product offers; the choices are ${CONFLICT_RESOLUTIONS.join(", ")}`,
      );
    }
    const row = await this.driver.get<{ id: string }>(
      `SELECT id FROM conflict WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    await this.driver.run(
      `UPDATE conflict SET resolved_at = ?, resolution = ? WHERE id = ?`,
      [this.now().toISOString(), resolution, id],
    );
    return this.get(id);
  }

  async countOpen(tenantId: string): Promise<number> {
    const row = await this.driver.get<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM conflict WHERE tenant_id = ? AND resolved_at IS NULL`,
      [tenantId],
    );
    return Math.trunc(Number(row?.count ?? 0));
  }
}
