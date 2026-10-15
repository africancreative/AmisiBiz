import { assertParamCount, type RunResult, type SqlDriver } from "../driver";
import { toSqlValues, type SqlRow, type SqlValue } from "../types";
import type {
  SQLiteDBConnection,
  capSQLiteChanges,
  DBSQLiteValues,
} from "@capacitor-community/sqlite";

/**
 * The Capacitor SQLite driver — the Android path.
 *
 * Written against the **installed** declarations of
 * `@capacitor-community/sqlite` 8.1.1 (`dist/esm/definitions.d.ts`), type-only,
 * so this package keeps no runtime dependency on Capacitor: the app creates the
 * connection with `SQLiteConnection.createConnection(...)` and hands it over.
 * The `import type` still means `pnpm type-check` fails if the method names or
 * signatures drift, which is the compatibility proof that matters — a duck-typed
 * adapter can lie, a type-checked one cannot.
 *
 * ## Placeholder dialect
 *
 * The plugin binds `?` positionally, but only when `isSQL92` is true; with the
 * default (`false`) it expects its own JSON-shaped binding. Every call here
 * passes `isSQL92 = true`, which is why the shared SQL in this package is
 * written with `?` and needs no translation on Android.
 *
 * ## Transactions
 *
 * `beginTransaction` / `commitTransaction` / `rollbackTransaction` exist in the
 * plugin's own API (since 5.0.7), so Android gets real atomicity: the local row
 * and its outbox operation commit together or not at all, which is the whole
 * recovery guarantee. Depth tracking matches the Node driver because SQLite
 * allows one transaction per connection and repositories deliberately enqueue
 * inside the caller's transaction.
 */
export interface CapacitorDriverOptions {
  /** Called once before the first statement. Defaults to `connection.open()`. */
  readonly open?: boolean;
}

export class CapacitorSqlDriver implements SqlDriver {
  readonly name = "capacitor:sqlite";

  private readonly connection: SQLiteDBConnection;
  private depth = 0;
  private closed = false;

  constructor(connection: SQLiteDBConnection) {
    this.connection = connection;
  }

  /**
   * Opens the underlying connection. `SQLiteConnection.createConnection`
   * returns an unopened handle, and the plugin refuses statements on it until
   * `open()` resolves, so this is not optional.
   */
  async connect(options: CapacitorDriverOptions = {}): Promise<this> {
    if (options.open ?? true) await this.connection.open();
    return this;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new Error("The Capacitor SQLite connection is closed");
  }

  private changeResult(result: capSQLiteChanges): RunResult {
    return {
      changes: Math.trunc(result.changes?.changes ?? 0),
      lastInsertRowid:
        result.changes?.lastId === undefined
          ? null
          : Math.trunc(result.changes.lastId),
    };
  }

  async exec(sql: string): Promise<void> {
    this.assertOpen();
    assertParamCount(sql, []);
    // `execute` takes a statement list; the migrations in `schema.ts` are
    // deliberately one statement each, precisely because the three drivers
    // disagree about splitting a list.
    await this.connection.execute(sql, false, false);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<RunResult> {
    this.assertOpen();
    assertParamCount(sql, params);
    const result = await this.connection.run(
      sql,
      toSqlValues(params) as unknown[],
      false,
      undefined,
      true,
    );
    return this.changeResult(result);
  }

  async all<T extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    this.assertOpen();
    assertParamCount(sql, params);
    const result: DBSQLiteValues = await this.connection.query(
      sql,
      toSqlValues(params) as unknown[],
      true,
    );
    return (result.values ?? []) as T[];
  }

  async get<T extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.depth > 0) return fn();

    await this.connection.beginTransaction();
    this.depth += 1;
    try {
      const result = await fn();
      await this.connection.commitTransaction();
      return result;
    } catch (error) {
      try {
        await this.connection.rollbackTransaction();
      } catch {
        // The rollback can fail if the statement already aborted the
        // transaction. The caller's error is the one that explains the failure.
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.connection.close();
    this.closed = true;
  }
}

export function capacitorSqlDriver(
  connection: SQLiteDBConnection,
): CapacitorSqlDriver {
  return new CapacitorSqlDriver(connection);
}
