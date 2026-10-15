import { sha256Hex, type ChecksumHasher } from "./checksum";
import type { SqlDriver } from "./driver";

/**
 * The versioned local migrator.
 *
 * A device can be updated out from under its own data, so opening a database
 * is never "run whatever SQL the code has". Three things must be true before
 * the repositories are allowed to touch it:
 *
 *   1. every migration the database says it applied is one this build knows,
 *      with the same name and the same SHA-256 of its statements;
 *   2. the database is not ahead of the bundle (an older app must not try to
 *      downgrade a newer schema — it would silently lose the tables it cannot
 *      see);
 *   3. each pending migration commits as one transaction, so an interruption
 *      between statements cannot leave a half-shaped table behind.
 *
 * On a checksum mismatch the migrator **refuses to open**, and the caller must
 * treat that as a provisioning failure: the fix is a fresh provision from the
 * server, not a repair script. An edited migration on a device is tampering or
 * a corrupted install; either way the local data cannot be trusted.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Single statements, in order. See `schema.ts` for why not one script. */
  readonly statements: readonly string[];
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationReport {
  /** Migrations this call applied, in order. Empty when the schema was current. */
  readonly applied: readonly { version: number; name: string }[];
  /** Versions this build knows about that the database already had. */
  readonly alreadyApplied: readonly number[];
  readonly schemaVersion: number;
}

export class SchemaChecksumError extends Error {
  constructor(
    readonly version: number,
    readonly name: string,
  ) {
    super(
      `Local migration ${version} (${name}) does not match the checksum recorded ` +
        `when it was applied. Refusing to open this database: provision it fresh.`,
    );
    this.name = "SchemaChecksumError";
  }
}

export class SchemaAheadError extends Error {
  constructor(readonly version: number) {
    super(
      `The local database is at schema version ${version}, which this build does ` +
        `not know. Update the app instead of writing a schema it cannot read.`,
    );
    this.name = "SchemaAheadError";
  }
}

export class MigrationListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationListError";
  }
}

/**
 * The canonical text a checksum covers: the statements as one JSON array.
 *
 * Deliberately exact — reformatting a released migration changes its checksum
 * and the migrator will refuse old databases. That is the intended behaviour
 * (migrations are append-only), and it is why the list in `schema.ts` is
 * reviewed like an API.
 */
export async function checksumMigration(
  migration: Migration,
  hash: ChecksumHasher = sha256Hex,
): Promise<string> {
  return hash(JSON.stringify(migration.statements));
}

/** Fails loudly on a malformed list: a gap or a repeat would corrupt history. */
export function assertMigrationList(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (migration.version !== previous + 1) {
      throw new MigrationListError(
        `Migrations must be consecutive from version 1; got ${migration.version} after ${previous}`,
      );
    }
    if (migration.statements.length === 0) {
      throw new MigrationListError(
        `Migration ${migration.version} (${migration.name}) has no statements`,
      );
    }
    previous = migration.version;
  }
}

const HISTORY_TABLE = "amisibiz_schema_version";

async function historyExists(driver: SqlDriver): Promise<boolean> {
  const row = await driver.get<{ name: string | null }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [HISTORY_TABLE],
  );
  return row !== null;
}

/**
 * Reads the recorded history in version order. Returns an empty list for a
 * database that has never been provisioned.
 */
export async function readAppliedMigrations(
  driver: SqlDriver,
): Promise<AppliedMigration[]> {
  if (!(await historyExists(driver))) return [];

  const rows = await driver.all<{
    version: string | number;
    name: string;
    checksum: string;
    applied_at: string;
  }>(
    `SELECT version, name, checksum, applied_at
       FROM ${HISTORY_TABLE}
      ORDER BY version ASC`,
  );

  return rows.map((row) => ({
    version: Math.trunc(Number(row.version)),
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export interface MigrateOptions {
  readonly driver: SqlDriver;
  readonly migrations: readonly Migration[];
  /** Injectable for tests; defaults to the platform SHA-256. */
  readonly hash?: ChecksumHasher;
  /** Injectable clock so `applied_at` is assertable. */
  readonly now?: () => Date;
}

/**
 * Verifies the recorded history, then applies everything pending.
 *
 * The order is not incidental: verification happens **before** any write, so a
 * tampered database is never also a partially-migrated one.
 */
export async function migrate(
  options: MigrateOptions,
): Promise<MigrationReport> {
  assertMigrationList(options.migrations);

  const hash = options.hash ?? sha256Hex;
  const now = options.now ?? (() => new Date());
  const byVersion = new Map<number, Migration>(
    options.migrations.map((migration) => [migration.version, migration]),
  );

  const recorded = await readAppliedMigrations(options.driver);

  for (const applied of recorded) {
    const known = byVersion.get(applied.version);
    if (!known) throw new SchemaAheadError(applied.version);
    if (
      known.name !== applied.name ||
      (await checksumMigration(known, hash)) !== applied.checksum
    ) {
      throw new SchemaChecksumError(applied.version, applied.name);
    }
  }

  const appliedVersions = new Set(recorded.map((row) => row.version));
  const alreadyApplied = [...appliedVersions].sort((a, b) => a - b);

  const pending = options.migrations
    .filter((migration) => !appliedVersions.has(migration.version))
    .sort((a, b) => a.version - b.version);

  const ran: { version: number; name: string }[] = [];

  for (const migration of pending) {
    const checksum = await checksumMigration(migration, hash);
    const appliedAt = now().toISOString();

    await options.driver.transaction(async () => {
      for (const statement of migration.statements) {
        await options.driver.exec(statement);
      }
      await options.driver.run(
        `INSERT INTO ${HISTORY_TABLE} (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
        [migration.version, migration.name, checksum, appliedAt],
      );
    });

    ran.push({ version: migration.version, name: migration.name });
  }

  return {
    applied: ran,
    alreadyApplied,
    schemaVersion:
      options.migrations.length > 0
        ? (options.migrations[options.migrations.length - 1]?.version ?? 0)
        : 0,
  };
}

/** The highest version the database has applied, 0 when unprovisioned. */
export async function currentSchemaVersion(driver: SqlDriver): Promise<number> {
  const rows = await readAppliedMigrations(driver);
  return rows.length === 0 ? 0 : (rows[rows.length - 1]?.version ?? 0);
}
