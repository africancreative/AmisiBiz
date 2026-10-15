import type { SqlDriver } from "./driver";
import type { SyncState } from "./constants";

/**
 * Table-level helpers for the synchronization tail.
 *
 * These exist because the sync engine must be able to say "that operation was
 * rejected" without each repository re-implementing the same UPDATE, and
 * because a table name interpolated into SQL has to come from a closed list —
 * never from a string that arrived over the network.
 */

export const MIRRORED_TABLES = [
  "contact",
  "contact_address",
  "item",
  "customer_price",
  "document",
  "document_line",
  "document_payment",
  "document_status_event",
] as const;

export type MirroredTable = (typeof MIRRORED_TABLES)[number];

/**
 * Tables a device only ever reads. An operation naming one of these is a bug in
 * the client, which is why the write repositories never touch them and
 * `assertMirroredTable` refuses to treat them as mirrored.
 */
export const PULL_ONLY_TABLES = [
  "tenant_profile",
  "tenant_branding",
  "document_numbering",
  "tax_category",
  "tax_rate",
  "document_snapshot",
] as const;

export type PullOnlyTable = (typeof PULL_ONLY_TABLES)[number];

/** Guards a table name that came from anywhere other than this module. */
export function assertMirroredTable(name: string): MirroredTable {
  if (!(MIRRORED_TABLES as readonly string[]).includes(name)) {
    throw new Error(`"${name}" is not a locally mirrored table`);
  }
  return name as MirroredTable;
}

/** The local row state after a server outcome, shared by every entity. */
export interface StateUpdate {
  readonly baseRevision?: number | null;
  readonly serverUpdatedAt?: string | null;
  readonly lastError?: string | null;
}

/**
 * Moves one row's synchronization state.
 *
 * A row in `rejected` or `conflict` keeps its data — this function never
 * deletes or blanks anything, because "preserve rejected local drafts for
 * controlled recovery" is the requirement. The reason travels in `lastError`.
 */
export async function setSyncState(
  driver: SqlDriver,
  table: string,
  id: string,
  state: SyncState,
  update: StateUpdate = {},
): Promise<void> {
  const target = assertMirroredTable(table);
  await driver.run(
    `UPDATE ${target}
        SET sync_state = ?,
            base_revision = COALESCE(?, base_revision),
            server_updated_at = COALESCE(?, server_updated_at),
            last_error = ?
      WHERE id = ?`,
    [
      state,
      update.baseRevision ?? null,
      update.serverUpdatedAt ?? null,
      update.lastError ?? null,
      id,
    ],
  );
}

/** Marks a row deleted locally after the server said it is gone (a tombstone). */
export async function markDeleted(
  driver: SqlDriver,
  table: string,
  id: string,
  at: string,
): Promise<void> {
  const target = assertMirroredTable(table);
  await driver.run(
    `UPDATE ${target} SET deleted = 1, updated_at = ?, sync_state = 'synced' WHERE id = ?`,
    [at, id],
  );
}

/** Reads the tail of one row, for the "may this frame overwrite it?" decision. */
export interface RowState {
  readonly syncState: SyncState;
  readonly baseRevision: number | null;
  readonly deleted: boolean;
}

export async function readRowState(
  driver: SqlDriver,
  table: string,
  id: string,
): Promise<RowState | null> {
  const target = assertMirroredTable(table);
  const row = await driver.get<{
    sync_state: string;
    base_revision: string | number | null;
    deleted: string | number;
  }>(`SELECT sync_state, base_revision, deleted FROM ${target} WHERE id = ?`, [
    id,
  ]);
  if (!row) return null;
  return {
    syncState: row.sync_state as SyncState,
    baseRevision:
      row.base_revision === null ? null : Math.trunc(Number(row.base_revision)),
    deleted: Number(row.deleted) !== 0,
  };
}

/** `?,?,?` for an `IN (…)` list. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/** Escapes a LIKE pattern's wildcards so user text searches for literal text. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** An `ORDER BY` fragment that is stable when timestamps collide. */
export function stableOrder(tieBreaker = "id"): string {
  return `updated_at DESC, ${tieBreaker} DESC`;
}
