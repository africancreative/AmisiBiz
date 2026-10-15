import { z } from "zod";

/**
 * Validation for the sync API envelopes (`/api/sync/push`, `/api/sync/pull`).
 *
 * These are the *transport* shapes an installed shell sends. They mirror the
 * contracts in `@amisibiz/sync` (`SyncPushRequest`, `QueuedOperation`,
 * `SyncChangeFrame`); the package stays dependency-free and does not use Zod, so
 * the server re-states the shape it accepts and refuses anything else.
 *
 * Two bounds matter as much as the field types:
 *  - a batch is bounded (`MAX_SYNC_OPERATIONS`), so one request cannot ask the
 *    server to do unbounded work;
 *  - a pull page is bounded (`max(200)`), so a device cannot stream the whole
 *    workspace in one call.
 *
 * `tenantId` is validated here and *authorized* in the handler. Parsing is not
 * authorization: a well-formed id for a workspace the caller does not belong to
 * is refused by `resolveTenantContext`, not by this schema.
 */

/**
 * The local schema version the server knows how to answer.
 *
 * Must equal `CURRENT_SCHEMA_VERSION` in `@amisibiz/offline`. It is duplicated
 * rather than imported because the server must not depend on the client storage
 * package (SQLite drivers); `phase06-sync-server.test.ts` asserts the two are
 * equal, so drift is a failing test rather than a silent mis-storage.
 */
export const SYNC_SCHEMA_VERSION = 5;

/** Upper bound on operations in one push, matching the design's bounded batch. */
export const MAX_SYNC_OPERATIONS = 50;

/** Default and maximum frames in one pull page. */
export const DEFAULT_PULL_LIMIT = 100;
export const MAX_PULL_LIMIT = 200;

export const syncOperationSchema = z.object({
  /** Client-generated UUID; the server's idempotency key. */
  id: z.string().uuid("Operation id must be a UUID"),
  /** e.g. "contact.create" — resolved against the operation registry. */
  type: z.string().trim().min(1).max(64),
  /** The local (and server) table name, e.g. "contact". */
  entity: z.string().trim().min(1).max(64),
  /**
   * The client-generated id of the row. Together with `entity` this is the
   * server's upsert key, and the reason a retried create cannot mint a second
   * record.
   */
  entityId: z.string().uuid("Entity id must be a UUID"),
  /** Operation-specific fields; validated per type by the registry handler. */
  payload: z.record(z.unknown()),
  /** ISO-8601, display/debug only — never a conflict tie-breaker. */
  createdAt: z.string().min(1).max(64),
  attempts: z.number().int().min(0).optional(),
  status: z
    .enum(["pending", "in_flight", "applied", "failed", "conflict"])
    .optional(),
  lastError: z.string().max(2000).nullable().optional(),
  /** The server revision this edit was made against; absent on a create. */
  baseRevision: z.number().int().positive().nullable().optional(),
});

export const syncPushEnvelopeSchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  schemaVersion: z.number().int().positive().optional(),
  operations: z
    .array(syncOperationSchema)
    .min(1, "A push must carry at least one operation")
    .max(MAX_SYNC_OPERATIONS, "Too many operations in one push"),
});

export const syncPullQuerySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  cursor: z.string().max(512).optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_PULL_LIMIT)
    .default(DEFAULT_PULL_LIMIT),
});

export type SyncOperationInput = z.infer<typeof syncOperationSchema>;
export type SyncPushEnvelope = z.infer<typeof syncPushEnvelopeSchema>;
export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;
