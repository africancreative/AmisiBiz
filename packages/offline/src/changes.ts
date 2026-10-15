/**
 * The change frame the server sends on a pull, and the safe readers a pull
 * applier needs to turn it into columns.
 *
 * This is the client's view of `SyncChangeFrame` in `@amisibiz/sync`
 * (`packages/sync/src/transport.ts`). It is re-declared here, structurally,
 * because the storage half of this package does not need the transport types at
 * all: the repositories, the pull appliers and the tests work without them.
 * Only `sync-client.ts` imports the sync contracts, and it imports them to
 * check itself against them, not to describe rows.
 *
 * `data` is whatever the server put in the frame, using the server's own
 * camelCase field names. Everything below treats it as untrusted input — a
 * field that is absent is null, a field of the wrong type is an error, and
 * nothing is ever `as`-cast into a column.
 */

export interface PullFrame {
  readonly entity: string;
  readonly id: string;
  /** The server's revision counter for that row. Ties are broken by this, never by a device clock. */
  readonly revision: number;
  /** A tombstone. The local row is marked deleted; a ghost is worse than a gap. */
  readonly deleted: boolean;
  /** The server's own `updatedAt`, ISO-8601 UTC. Stored as `server_updated_at`. */
  readonly updatedAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type PullEntity =
  | "tenant"
  | "tenant_branding"
  | "document_numbering"
  | "tax_category"
  | "tax_rate"
  | "contact"
  | "contact_address"
  | "item"
  | "customer_price"
  | "document"
  | "document_line"
  | "document_payment"
  | "document_status_event"
  | "document_snapshot";

export const PULL_ENTITIES: readonly PullEntity[] = [
  "tenant",
  "tenant_branding",
  "document_numbering",
  "tax_category",
  "tax_rate",
  "contact",
  "contact_address",
  "item",
  "customer_price",
  "document",
  "document_line",
  "document_payment",
  "document_status_event",
  "document_snapshot",
];

export class PullFrameError extends Error {
  constructor(
    readonly entity: string,
    message: string,
  ) {
    super(`Pull frame for ${entity}: ${message}`);
    this.name = "PullFrameError";
  }
}

function has(data: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

/** A TEXT column the server may omit. A non-string is a contract break, not a typo to coerce. */
export function textField(
  frame: PullFrame,
  key: string,
  { required = false }: { required?: boolean } = {},
): string | null {
  if (!has(frame.data, key)) {
    if (required) throw new PullFrameError(frame.entity, `${key} is required`);
    return null;
  }
  const value = frame.data[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new PullFrameError(
      frame.entity,
      `${key} must be text, got ${typeof value}`,
    );
  }
  return value;
}

/** An enum column, validated against the values the local CHECK allows. */
export function enumField<T extends string>(
  frame: PullFrame,
  key: string,
  allowed: readonly T[],
  fallback: T | null = null,
): T | null {
  const value = textField(frame, key);
  if (value === null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new PullFrameError(
      frame.entity,
      `${key} is "${value}", which is not one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

/** A decimal column, kept as text. Never parsed into a float. */
export function decimalField(
  frame: PullFrame,
  key: string,
  fallback: string | null = null,
): string | null {
  if (!has(frame.data, key)) return fallback;
  const value = frame.data[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  // Prisma's Decimal serialises to a string over JSON, but a hand-written
  // fixture or a Prisma `toJson` may carry a number; accepting an integer
  // literal is safe, accepting a float is not (it is the rounding bug), so a
  // non-integer number is refused rather than silently reformatted.
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new PullFrameError(
        frame.entity,
        `${key} arrived as the float ${value}; amounts travel as decimal strings`,
      );
    }
    return String(value);
  }
  throw new PullFrameError(frame.entity, `${key} is not a decimal amount`);
}

export function intField(frame: PullFrame, key: string, fallback = 0): number {
  if (!has(frame.data, key)) return fallback;
  const value = frame.data[key];
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new PullFrameError(frame.entity, `${key} is not a number`);
  }
  return Math.trunc(parsed);
}

export function boolField(
  frame: PullFrame,
  key: string,
  fallback = false,
): boolean {
  if (!has(frame.data, key)) return fallback;
  const value = frame.data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false" || value === null)
    return false;
  throw new PullFrameError(frame.entity, `${key} is not a boolean`);
}

/** A timestamp column, normalised to ISO-8601 UTC text. */
export function timestampField(
  frame: PullFrame,
  key: string,
  { required = false }: { required?: boolean } = {},
): string | null {
  if (!has(frame.data, key)) {
    if (required) throw new PullFrameError(frame.entity, `${key} is required`);
    return null;
  }
  const value = frame.data[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new PullFrameError(frame.entity, `${key} is not a timestamp`);
    }
    return new Date(parsed).toISOString();
  }
  if (typeof value === "number") return new Date(value).toISOString();
  throw new PullFrameError(frame.entity, `${key} is not a timestamp`);
}

/** A Json column (taxBreakdown, snapshot), stored as the text the server sent. */
export function jsonField(frame: PullFrame, key: string): string | null {
  if (!has(frame.data, key)) return null;
  const value = frame.data[key];
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/**
 * Every frame must name the tenant the device is provisioned for. A frame that
 * says otherwise is refused loudly: silently writing another tenant's row into
 * the local store is the exact failure the whole authorization model exists to
 * prevent, and the local store has no RLS to catch it — design §1 records that
 * RLS is inert in the deployed app today, so on a device this check is the only
 * one that runs.
 */
export function assertFrameTenant(frame: PullFrame, tenantId: string): void {
  const claimed = textField(frame, "tenantId");
  if (claimed !== null && claimed !== tenantId) {
    throw new Error(
      `Dropped ${frame.entity} frame ${frame.id}: it names tenant ${claimed}, ` +
        `not the provisioned tenant`,
    );
  }
}

/**
 * The repository surface `applyPullPage` dispatches to. Declared structurally
 * here so the pull applier does not import concrete repositories.
 */
export interface PullApplier {
  readonly entity: string;
  applyPull(frame: PullFrame, tenantId: string): Promise<void>;
}
