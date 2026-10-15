import {
  assertParamCount,
  positionalToNumbered,
  type RunResult,
  type SqlDriver,
} from "../driver";
import { toSqlValues, type SqlRow, type SqlValue } from "../types";
import type Database from "@tauri-apps/plugin-sql";

/**
 * The Tauri SQL driver — the Windows path, and the reason Windows is blocked.
 *
 * Written against the installed declarations of `@tauri-apps/plugin-sql` 2.6.0.
 * Two real incompatibilities surfaced while doing that, and both are handled
 * here rather than in prose:
 *
 *   1. **Placeholder dialect.** The plugin binds SQLite parameters as
 *      `$1, $2, …` (it goes through sqlx, which speaks PostgreSQL-style
 *      placeholders on SQLite), while `node:sqlite` and Capacitor bind `?`.
 *      The shared SQL stays in the `?` dialect and `positionalToNumbered`
 *      rewrites it at the seam, after `assertParamCount` has already proved the
 *      parameter list matches the number of placeholders — so the translation
 *      cannot be off by one.
 *   2. **No transaction API.** `Database` exposes `execute`, `select`, `close`
 *      and nothing else. Each `execute` call is a separate statement on a pooled
 *      connection, so `BEGIN` in one call and `COMMIT` in another are not
 *      guaranteed to run on the same connection, and the atomicity they appear
 *      to give is not real.
 *
 * The second point is why `transaction()` below **refuses instead of emulating
 * it**. The offline layer's central guarantee is that a local change and its
 * outbox operation commit together or not at all; an adapter that ran the two
 * halves as two pooled statements would produce exactly the failure that
 * guarantee exists to prevent — a draft with no queued operation, or an
 * operation describing a draft that was never written — and would report success
 * while doing it. There is no option to downgrade that, because a
 * "best-effort transaction" flag is how a data-loss bug ships.
 *
 * **What would unblock Windows** (design §10, and the substance of the Windows
 * build-prerequisite document): a Rust-side command that takes a statement list
 * and runs it inside `sqlx::Connection::transaction(...)` on one acquired
 * connection, exposed to the JS layer as a single call. With that, this driver
 * implements `transaction()` against it and the rest of the offline layer works
 * unchanged — which is the payoff of keeping the SQL shared.
 */

/** The instance surface this adapter depends on, from the real class. */
export interface TauriSqlDatabase {
  execute(
    query: string,
    bindValues?: unknown[],
  ): Promise<{
    rowsAffected: number;
    lastInsertId?: number;
  }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  close(db?: string): Promise<boolean>;
}

/** The class itself, injected so this package holds no runtime Tauri import. */
export interface TauriSqlDatabaseLoader {
  load(
    path: string,
    options?: { autoCreate?: boolean },
  ): Promise<TauriSqlDatabase>;
}

/**
 * Compile-time proof that the plugin's own `Database` class still provides the
 * surface above. If a future version renames `execute`, changes `select`'s
 * generics or drops `close`, `tsc` fails on this line instead of the app failing
 * on a customer's machine — which is the point of checking against the real
 * declarations rather than a copy of them.
 */
type AssertProvides<Target, Source extends Target> = Source;

export type TauriDatabaseMatchesAdapter = AssertProvides<
  TauriSqlDatabase,
  Pick<Database, "execute" | "select" | "close">
>;

export class TauriTransactionUnsupportedError extends Error {
  constructor() {
    super(
      "@tauri-apps/plugin-sql 2.6.0 exposes no transaction primitive, and each " +
        "execute() is a separate statement on a pooled connection, so an " +
        "emulated BEGIN/COMMIT would not be atomic. The offline layer writes a " +
        "local change and its outbox operation in one transaction, so this " +
        "driver refuses rather than pretending: a Windows build needs a " +
        "Rust-side transaction command first (design §10).",
    );
    this.name = "TauriTransactionUnsupportedError";
  }
}

export class TauriSqlDriver implements SqlDriver {
  readonly name = "tauri:sql/sqlite";

  private readonly db: TauriSqlDatabase;

  constructor(db: TauriSqlDatabase) {
    this.db = db;
  }

  /**
   * Loads the database file through the plugin.
   *
   * `path` is relative to Tauri's `BaseDirectory::App` and must start with
   * `sqlite:` (e.g. `sqlite:amisibiz.db`); the plugin creates the file if it is
   * missing. `autoCreate: false` is the option that turns a first-run typo into
   * an error instead of an empty database, which is the safer default for a
   * client that stores invoices.
   */
  static async connect(
    loader: TauriSqlDatabaseLoader,
    path: string,
    options: { autoCreate?: boolean } = {},
  ): Promise<TauriSqlDriver> {
    const db = await loader.load(path, options);
    return new TauriSqlDriver(db);
  }

  async exec(sql: string): Promise<void> {
    assertParamCount(sql, []);
    await this.db.execute(positionalToNumbered(sql));
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<RunResult> {
    this.assertParams(sql, params);
    const result = await this.db.execute(
      positionalToNumbered(sql),
      toSqlValues(params) as unknown[],
    );
    return {
      changes: Math.trunc(result.rowsAffected),
      lastInsertRowid:
        result.lastInsertId === undefined
          ? null
          : Math.trunc(result.lastInsertId),
    };
  }

  async all<T extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    this.assertParams(sql, params);
    const rows = await this.db.select<T[]>(
      positionalToNumbered(sql),
      toSqlValues(params) as unknown[],
    );
    return rows ?? [];
  }

  async get<T extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Refuses. See the file header: emulating this would break the one guarantee
   * the outbox rests on, and reporting success while doing it.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    void fn;
    throw new TauriTransactionUnsupportedError();
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * `assertParamCount` runs against the `?` form because that is the SQL this
   * package writes; numbering afterwards would count `$n` placeholders as none.
   */
  private assertParams(sql: string, params: readonly SqlValue[]): void {
    assertParamCount(sql, params);
  }
}
