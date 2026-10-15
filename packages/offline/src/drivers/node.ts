import { assertParamCount, type RunResult, type SqlDriver } from "../driver";
import { toSqlValues, type SqlRow, type SqlValue } from "../types";

/**
 * The `node:sqlite` driver — the one tests and CI run on.
 *
 * It exists so the shared SQL, the migrator and every repository in this
 * package can be executed against real SQLite without a native dependency, a
 * simulator or a mock. The behavioural guarantees the directive asks for
 * (recover after interruption, retry without duplicating, refuse to overwrite a
 * newer server row) are properties of this SQL and this TypeScript, so proving
 * them here is not a stand-in for proving them on a phone — it is the same
 * proof, on the same statements.
 *
 * ## Why the constructor is injected
 *
 * `DatabaseSync` comes from `node:sqlite`, and this package's TypeScript
 * configuration deliberately has **no** `@types/node` in it (`types: []`): the
 * same code has to compile into an Android and a Windows WebView bundle, where
 * a Node import would be a build failure that only shows up on a device. So the
 * caller hands over the constructor:
 *
 * ```ts
 * const { DatabaseSync } = await import("node:sqlite");
 * const driver = nodeSqliteDriver(DatabaseSync, ":memory:");
 * ```
 *
 * Nothing here imports a Node module, and the type of the injected value is the
 * minimal shape this driver actually uses.
 */

/** The slice of `node:sqlite`'s `DatabaseSync` this adapter depends on. */
export interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

export interface NodeSqliteStatement {
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export type NodeSqliteDatabaseConstructor = new (
  path: string,
  options?: { open?: boolean },
) => NodeSqliteDatabase;

export interface NodeSqliteDriverOptions {
  /** Applied once after opening. WAL is a file-database concern; `:memory:` ignores it. */
  readonly journalMode?: "wal" | "delete" | "off";
  readonly foreignKeys?: boolean;
}

export class NodeSqliteDriver implements SqlDriver {
  readonly name = "node:sqlite";

  private readonly db: NodeSqliteDatabase;
  /**
   * SQLite allows one transaction per connection, so a nested
   * `BEGIN IMMEDIATE` would fail. Repositories open transactions inside the
   * engine's transaction on purpose (write the row, then queue the operation),
   * and the reentrant path simply runs the body — the outer transaction already
   * covers it, and the outer commit or rollback is what decides the outcome.
   */
  private depth = 0;
  private closed = false;

  constructor(
    DatabaseCtor: NodeSqliteDatabaseConstructor,
    path: string,
    options: NodeSqliteDriverOptions = {},
  ) {
    this.db = new DatabaseCtor(path);
    if (options.journalMode === "wal") {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
      } catch {
        // A memory database (and some VFSes) refuse WAL. The migrator does not
        // depend on it, so the refusal is not a failure.
      }
    }
    if (options.foreignKeys ?? true) {
      this.db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The SQLite connection is closed");
  }

  async exec(sql: string): Promise<void> {
    this.assertOpen();
    assertParamCount(sql, []);
    this.db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<RunResult> {
    this.assertOpen();
    assertParamCount(sql, params);
    const bound = toSqlValues(params);
    const result = this.db.prepare(sql).run(...bound);
    return {
      changes: Number(result.changes),
      lastInsertRowid:
        result.lastInsertRowid === null ? null : Number(result.lastInsertRowid),
    };
  }

  async all<T extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    this.assertOpen();
    assertParamCount(sql, params);
    const bound = toSqlValues(params);
    return this.db.prepare(sql).all(...bound) as T[];
  }

  async get<T extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    this.assertOpen();
    assertParamCount(sql, params);
    const bound = toSqlValues(params);
    const row = this.db.prepare(sql).get(...bound);
    return (row ?? null) as T | null;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.depth > 0) return fn();

    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A rollback can only fail if the statement already aborted the
        // transaction; the original error is the one the caller needs.
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

export function nodeSqliteDriver(
  DatabaseCtor: NodeSqliteDatabaseConstructor,
  path: string,
  options: NodeSqliteDriverOptions = {},
): SqlDriver {
  return new NodeSqliteDriver(DatabaseCtor, path, options);
}
