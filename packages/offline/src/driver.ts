import type { SqlRow, SqlValue } from "./types";

/**
 * The single seam between the offline repositories and SQLite.
 *
 * Three drivers implement it — `node:sqlite` (tests/CI), Capacitor's native
 * SQLite (Android) and Tauri's SQL plugin (Windows) — and they differ only in
 * *how* a statement reaches the database. Everything above this interface is
 * shared SQL and shared TypeScript, which is the point: the behavioural
 * requirements (recover after interruption, do not duplicate a retry, do not
 * overwrite newer server data) must be provable once rather than three times.
 *
 * Every method is async because two of the three drivers are asynchronous by
 * nature (the Capacitor and Tauri plugins cross a bridge). The synchronous
 * Node driver returns already-resolved promises rather than exposing a second
 * API shape.
 */
export interface SqlDriver {
  /** Runs one or more statements, discarding any rows. */
  exec(sql: string): Promise<void>;

  /** Runs a statement with parameters, returning the rows it changed. */
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;

  /** Runs a query with parameters, returning every matching row. */
  all<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;

  /** Runs a query and returns only the first row, or null. */
  get<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T | null>;

  /**
   * Runs `fn` inside one transaction and commits it, or rolls everything back
   * if `fn` throws. Nested calls must not be allowed to open a second SQLite
   * transaction — the driver tracks the depth and simply awaits the outer one.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Closes the database and releases the file handle. */
  close(): Promise<void>;

  /** A stable name for logs and tests — never a credential or a file path. */
  readonly name: string;
}

export interface RunResult {
  /** Rows written. All three drivers report it, under three names: `changes`, `changes`, `rowsAffected`. */
  changes: number;
  /** SQLite rowid of the inserted row when the driver reports one. Capacitor calls it `lastId`, Tauri `lastInsertId`, and Tauri omits it entirely on non-SQLite backends. */
  lastInsertRowid: number | null;
}

/**
 * Serialises a JSON column for storage. The local database mirrors the
 * server's `Json` columns (`taxBreakdown`, `snapshot`), which arrive over the
 * wire as objects; storing them as TEXT keeps the SQL portable.
 */
export function toJsonValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function fromJsonValue<T>(raw: string | null): T | null {
  if (raw === null || raw.length === 0) return null;
  return JSON.parse(raw) as T;
}

/**
 * Counts the `?` placeholders in a statement, ignoring any inside a string
 * literal.
 *
 * Every driver calls `assertParamCount` before binding, because a
 * placeholder/parameter mismatch is the nastiest bug class this package can
 * contain: SQLite binds positionally, so one mis-counted column in an INSERT
 * writes a value into the wrong field — a price into a quantity, a tenant id
 * into a contact id — and still succeeds. Catching it in the driver means the
 * check runs identically on Node, Android and Windows, in the same place the
 * binding happens.
 */
export function countPlaceholders(sql: string): number {
  let count = 0;
  let quote: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "?") count += 1;
  }
  return count;
}

export class SqlParamCountError extends Error {
  constructor(
    readonly placeholders: number,
    readonly params: number,
    readonly sql: string,
  ) {
    super(
      `Statement has ${placeholders} placeholder(s) but ${params} parameter(s): ${sql}`,
    );
    this.name = "SqlParamCountError";
  }
}

export function assertParamCount(
  sql: string,
  params: readonly SqlValue[],
): void {
  const placeholders = countPlaceholders(sql);
  if (placeholders !== params.length) {
    throw new SqlParamCountError(placeholders, params.length, sql);
  }
}

/**
 * Rewrites `?` placeholders as `$1, $2, …`, leaving string literals alone.
 *
 * This exists because of a real incompatibility found against the installed
 * declarations rather than in theory: `@tauri-apps/plugin-sql` 2.6.0 documents
 * its SQLite binding as `$1, $2, …` (sqlx's PostgreSQL-style placeholders),
 * while `node:sqlite` and Capacitor bind `?` positionally. The shared SQL in
 * this package is written once, in the `?` dialect every SQLite driver
 * understands, and only the Windows adapter converts it — so the translation
 * happens in one place, next to the count check that guarantees the numbering
 * cannot be off by one.
 */
export function positionalToNumbered(sql: string): string {
  let out = "";
  let quote: string | null = null;
  let ordinal = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    if (quote !== null) {
      out += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      out += character;
      continue;
    }
    if (character === "?") {
      ordinal += 1;
      out += `$${ordinal}`;
      continue;
    }
    out += character;
  }

  return out;
}
