import { prisma } from "@amisibiz/database";
import type { SyncChangeFrame, SyncPullPage } from "@amisibiz/sync";
import { logger } from "@/lib/logger";
import { DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT } from "@/lib/validations/sync";
import { resolveTenantContext } from "@/server/auth/authorization";
import { SUPPORTED_SYNC_ENTITIES } from "@/server/sync/registry";

/**
 * `GET /api/sync/pull` — one page of server changes for a device's replica.
 *
 * The page is ordered by `(updatedAt, id)` and the cursor is exactly that pair,
 * base64-encoded and **bound to the tenant**: a cursor minted in one workspace is
 * refused in another, so a device cannot use a cursor to cross a tenant boundary.
 * The query is tenant-predicated *and* RLS-scoped; the directive's "nothing
 * outside the caller's tenant is reachable" holds twice over.
 *
 * A page mixes live rows and `deleted: true` tombstones. A tombstone is how a
 * hard-deleted row reaches a device that still holds a copy; without it the copy
 * becomes a ghost record nobody can explain (design §7.3).
 *
 * ## The served entity set
 *
 * This slice serves the three device-authored business tables that carry a server
 * `revision` and are safe to reconstruct on their own: `contact`, `item` and
 * `customer_price` (the server's `ContactItem`). It does **not** serve
 * `document`/`document_line` or the configuration entities, and it says so
 * rather than emitting a partial document a device would render as a lie. The
 * gap is named in `docs/implementation/phase-06-sync-server-report.md`.
 */

export type PullEntity = (typeof SUPPORTED_SYNC_ENTITIES)[number];

type Cursor = { v: 1; tenantId: string; updatedAt: string; id: string };

const CURSOR_VERSION = 1;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decodes a cursor and checks it belongs to this tenant. A cursor that does not
 * parse, or that names another workspace, is refused with a thrown error the
 * route turns into a 400 — the position is not a fact this session may inherit.
 */
export function decodeCursor(raw: string, tenantId: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new CursorError("The sync cursor is not readable.");
  }

  const cursor = parsed as Partial<Cursor> | null;
  if (
    !cursor ||
    cursor.v !== CURSOR_VERSION ||
    typeof cursor.tenantId !== "string" ||
    typeof cursor.updatedAt !== "string" ||
    typeof cursor.id !== "string"
  ) {
    throw new CursorError("The sync cursor is not readable.");
  }
  if (cursor.tenantId !== tenantId) {
    // Cross-tenant cursor: refuse rather than silently start from the beginning,
    // which would look like a successful pull that skipped changes.
    throw new CursorError("The sync cursor belongs to another workspace.");
  }
  return cursor as Cursor;
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

type PullParams = {
  userId: string;
  tenantId: string;
  cursor: string | null;
  limit?: number;
};

export async function handleSyncPull({
  userId,
  tenantId,
  cursor: rawCursor,
  limit: requestedLimit,
}: PullParams): Promise<SyncPullPage> {
  const serverTime = new Date().toISOString();
  const limit = Math.min(
    Math.max(1, requestedLimit ?? DEFAULT_PULL_LIMIT),
    MAX_PULL_LIMIT,
  );

  // Membership + tenant authorization before a single row is read. A support
  // grant can read a suspended workspace, which is exactly the write gate we do
  // NOT want here: pulls are reads.
  await resolveTenantContext(userId, tenantId);

  const cursor = rawCursor ? decodeCursor(rawCursor, tenantId) : null;

  const [contacts, items, prices, tombstones] = await Promise.all([
    readRows("contact", tenantId, cursor, limit),
    readRows("item", tenantId, cursor, limit),
    readRows("customer_price", tenantId, cursor, limit),
    readTombstones(tenantId, cursor, limit),
  ]);

  const frames: SyncChangeFrame[] = [
    ...liveFrames("contact", contacts),
    ...liveFrames("item", items),
    ...liveFrames("customer_price", prices),
    ...tombstoneFrames(tombstones),
  ];

  // One global ordering across the merged sources. Sorting the (at most
  // `4 × limit`) candidate frames and slicing is what makes the cursor a single
  // position over four tables instead of four cursors a client must reconcile.
  frames.sort(compareFrames);
  const page = frames.slice(0, limit);

  await stampSyncAttempt(tenantId, true, null);

  return {
    nextCursor:
      page.length < frames.length || page.length === limit
        ? nextCursor(page)
        : null,
    changes: page,
    serverTime,
  };
}

/** Newest-tie-broken-by-id ordering, matching the SQL `ORDER BY`. */
function compareFrames(a: SyncChangeFrame, b: SyncChangeFrame): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function nextCursor(page: SyncChangeFrame[]): string | null {
  const last = page[page.length - 1];
  if (!last) return null;
  // The cursor carries the tenant: a position is only meaningful inside the
  // workspace whose changes it describes.
  const { tenantId } = decodeFrameTenant(last);
  return encodeCursor({
    v: CURSOR_VERSION,
    tenantId,
    updatedAt: last.updatedAt,
    id: last.id,
  });
}

/**
 * The tenant a frame belongs to. Every frame carries `tenantId` in its `data`
 * (the client asserts the same, in `assertFrameTenant`), so the cursor can bind
 * to it without a second read.
 */
function decodeFrameTenant(frame: SyncChangeFrame): { tenantId: string } {
  const tenantId = frame.data["tenantId"];
  if (typeof tenantId !== "string") {
    throw new CursorError("A change frame is missing its workspace.");
  }
  return { tenantId };
}

type LiveRow = {
  id: string;
  revision: number;
  updatedAt: Date;
  tenantId: string;
} & Record<string, unknown>;

async function readRows(
  entity: PullEntity,
  tenantId: string,
  cursor: Cursor | null,
  limit: number,
): Promise<LiveRow[]> {
  const where = {
    tenantId,
    ...(cursor
      ? {
          OR: [
            { updatedAt: { gt: new Date(cursor.updatedAt) } },
            { updatedAt: new Date(cursor.updatedAt), id: { gt: cursor.id } },
          ],
        }
      : {}),
  };
  const orderBy = [{ updatedAt: "asc" as const }, { id: "asc" as const }];

  switch (entity) {
    case "contact":
      return (await prisma.contact.findMany({
        where,
        orderBy,
        take: limit,
      })) as unknown as LiveRow[];
    case "item":
      return (await prisma.item.findMany({
        where,
        orderBy,
        take: limit,
      })) as unknown as LiveRow[];
    case "customer_price":
      return (await prisma.contactItem.findMany({
        where,
        orderBy,
        take: limit,
      })) as unknown as LiveRow[];
    default: {
      return [];
    }
  }
}

function liveFrames(entity: PullEntity, rows: LiveRow[]): SyncChangeFrame[] {
  return rows.map((row) => ({
    entity,
    id: row.id,
    revision: row.revision,
    deleted: false,
    updatedAt: row.updatedAt.toISOString(),
    // `data` is the whole server row, keys as the server names them (the client's
    // readers expect camelCase and treat anything absent as null). A JSON round
    // trip is what turns `Decimal` into a decimal string and `Date` into an ISO
    // string without a hand-written field list that would drift from the schema.
    data: serialiseRow(row),
  }));
}

function serialiseRow(row: LiveRow): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  return plain;
}

type TombstoneRow = {
  entity: string;
  entityId: string;
  revision: number;
  deletedAt: Date;
  tenantId: string;
};

async function readTombstones(
  tenantId: string,
  cursor: Cursor | null,
  limit: number,
): Promise<TombstoneRow[]> {
  return (await prisma.syncDeletion.findMany({
    where: {
      tenantId,
      entity: { in: [...SUPPORTED_SYNC_ENTITIES] },
      ...(cursor
        ? {
            OR: [
              { deletedAt: { gt: new Date(cursor.updatedAt) } },
              { deletedAt: new Date(cursor.updatedAt), id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
    take: limit,
  })) as unknown as TombstoneRow[];
}

function tombstoneFrames(rows: TombstoneRow[]): SyncChangeFrame[] {
  return rows.map((row) => ({
    entity: row.entity,
    id: row.entityId,
    revision: row.revision,
    deleted: true,
    updatedAt: row.deletedAt.toISOString(),
    data: { id: row.entityId, tenantId: row.tenantId },
  }));
}

/**
 * Stamps the workspace's sync indicator through the Phase 2 definer function.
 * Best-effort, for the same reason as the push side: the indicator is a
 * convenience read and a failed stamp must not fail the pull.
 */
async function stampSyncAttempt(
  tenantId: string,
  accepted: boolean,
  errorCode: string | null,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      SELECT public.record_tenant_sync_attempt(
        ${tenantId}::uuid, ${accepted}, ${errorCode}
      )
    `;
  } catch (error) {
    logger.warn("sync.pull.indicator_stamp_failed", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export { compareFrames };
