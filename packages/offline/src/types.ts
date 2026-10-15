/**
 * The only two value types that ever cross the driver boundary.
 *
 * SQLite has four storage classes and a habit of handing back whatever it
 * stored, so the repositories normalise at the edge instead of trusting a
 * column's declared type. Everything a driver returns is `unknown` until a
 * repository has checked it.
 */

/** A bindable parameter. Booleans are 0/1 integers — see `toSqlValue`. */
export type SqlValue = null | number | string | Uint8Array;

/** One column of one row, as SQLite returned it. */
export type SqlCell = null | number | string | Uint8Array;

export type SqlRow = Record<string, SqlCell>;

/**
 * Normalises a JavaScript value into something a SQLite driver will accept.
 *
 * `null` and `undefined` both mean "SQL NULL" here — an absent optional field
 * is not the same as the empty string, and storing "" would make a `IS NULL`
 * lookup miss the row. Booleans become 0/1 because SQLite has no boolean class
 * and the three drivers disagree about what to do with `true`.
 */
export function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(
    `Cannot bind a value of type ${typeof value} to SQLite; serialise it first`,
  );
}

export function toSqlValues(values: readonly unknown[]): SqlValue[] {
  return values.map(toSqlValue);
}

/** Reads a nullable TEXT/INTEGER/REAL column. */
export function cellString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

export function cellNumber(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Money is stored as a decimal *string* (see `docs/architecture/
 * offline-client-design.md` §3) and never becomes a float on the way out.
 * A malformed amount is a corruption, so it throws instead of substituting 0 —
 * silently zeroing a total is exactly the failure the constitution forbids.
 */
export function cellDecimal(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return decimalToString(value);
  }
  throw new TypeError(
    `Column "${column}" holds ${String(value)}, which is not a decimal amount`,
  );
}

export function cellDecimalOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.length === 0) return null;
  return cellDecimal(row, column);
}

export function cellBoolean(row: SqlRow, column: string): boolean {
  const value = row[column];
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "1" || value === "true";
  return Boolean(value);
}

/** SQLite INTEGER, tolerating a driver that hands the digits back as TEXT. */
export function cellInteger(row: SqlRow, column: string): number {
  const value = cellNumber(row, column);
  if (value === null) {
    throw new TypeError(`Column "${column}" is null but must hold an integer`);
  }
  return Math.trunc(value);
}

/**
 * Formats a float as a fixed-scale decimal string. Only used to rescue a value
 * a driver returned as REAL; the stored representation is always text.
 */
export function decimalToString(value: number, scale = 4): string {
  return value.toFixed(scale);
}

/** An ISO-8601 UTC timestamp, or null for "not recorded". */
export function cellTimestamp(row: SqlRow, column: string): string | null {
  return cellString(row, column);
}
