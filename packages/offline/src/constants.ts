/**
 * Shared vocabulary for the local database. These string unions are the values
 * that appear in CHECK constraints in `schema.ts`, so a change here is a
 * schema change — the migrator's checksum guard will refuse to run the old
 * history against new literals.
 */

/**
 * How much of a row the server agrees about.
 *
 * - `local` — created on this device, never sent. A document in this state has
 *   no number and must be labelled as local in every surface that shows it.
 * - `pending` — written locally and queued in the outbox, not yet accepted.
 * - `synced` — the server has the same row; `base_revision` is the revision it
 *   last confirmed.
 * - `rejected` — the server refused it (permission, suspension, expired
 *   session). The row is **kept** for controlled recovery, together with the
 *   reason; it is never silently deleted.
 * - `conflict` — the server row moved on since `base_revision`. Both copies are
 *   retained and the user chooses; nothing is overwritten silently.
 */
export const SYNC_STATES = [
  "local",
  "pending",
  "synced",
  "rejected",
  "conflict",
] as const;

export type SyncState = (typeof SYNC_STATES)[number];

export const DOCUMENT_TYPES = [
  "QUOTATION",
  "INVOICE",
  "DELIVERY_NOTE",
] as const;

export type LocalDocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * The server's full status set. The local table accepts all of it because a
 * synchronized issued document carries the server's status verbatim; which
 * subset is legal for a given type is the server's `lifecycle.ts`, and the
 * offline client never advances a status on its own (design §4).
 */
export const DOCUMENT_STATUSES = [
  "DRAFT",
  "ISSUED",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "VOID",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
] as const;

export type LocalDocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Mirror of `TenantStatus`. A device only ever learns it at an exchange. */
export const TENANT_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED"] as const;

export type LocalTenantStatus = (typeof TENANT_STATUSES)[number];

export const CONTACT_TYPES = ["INDIVIDUAL", "BUSINESS"] as const;
export type LocalContactType = (typeof CONTACT_TYPES)[number];

export const CONTACT_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type LocalContactStatus = (typeof CONTACT_STATUSES)[number];

export const ITEM_TYPES = ["PRODUCT", "SERVICE"] as const;
export type LocalItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type LocalItemStatus = (typeof ITEM_STATUSES)[number];

export const DISCOUNT_TYPES = ["PERCENT", "AMOUNT"] as const;
export type LocalDiscountType = (typeof DISCOUNT_TYPES)[number];

/** Outbox rows only — see `@amisibiz/sync`'s `OperationStatus`. */
export const OPERATION_STATUSES = [
  "pending",
  "in_flight",
  "applied",
  "failed",
  "conflict",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** `local_meta` keys the client reads. Written only through `LocalMetaRepository`. */
export const META_KEYS = [
  "client_id",
  "schema_version",
  "session_user_id",
  "session_version",
  "token_expires_at",
  "offline_expires_at",
  "last_authorized_at",
  "tenant_id",
  "tenant_status",
  "granted_permissions",
] as const;

export type MetaKey = (typeof META_KEYS)[number];

/**
 * The default ceiling on offline *creation*, in hours, from the last
 * successful authorized exchange (design §8). Advisory: the server decides
 * what is real on the next push. A deployment can lower it to 0, which means
 * "reads only while disconnected".
 */
export const DEFAULT_OFFLINE_AUTHORITY_HOURS = 72;

/**
 * How long a row may sit in `local`/`pending` before the client shows it as
 * stale rather than current. Deliberately a display concern: the data does not
 * change, and no local rule turns it into a server fact.
 */
export const STALE_AFTER_HOURS = 24;

/**
 * The three endings a conflict can have, exactly as the `conflict.resolution`
 * CHECK in `schema.ts` enumerates them.
 *
 * `kept_server` — the user chose the server's version, and the applier ran.
 * `reapplied_local` — the user's change becomes a NEW operation against the
 * current revision; the conflict record and the original operation both stay.
 * `discarded` — the user threw their own local change away.
 *
 * There is no `auto` value, because a resolution that happened without the
 * user is not a resolution, it is an overwrite.
 */
export const CONFLICT_RESOLUTIONS = [
  "kept_server",
  "reapplied_local",
  "discarded",
] as const;

export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];
