import { prisma } from "@amisibiz/database";
import type { SyncEntity } from "@/server/sync/registry";

/**
 * Tombstones for hard-deleted syncable rows.
 *
 * A row that a device still holds a copy of must be *told* it is gone; a pull
 * that simply stopped mentioning it would leave the copy as a ghost record that
 * nobody can explain (constitution; offline-client design §7.3). So a hard delete
 * writes a `SyncDeletion` row in the **same transaction as the delete** — the
 * design's wording — and the pull endpoint turns each tombstone into a
 * `deleted: true` frame.
 *
 * Only `ContactItem` produces tombstones in this product: `Contact` is archived
 * (`archivedAt`), never deleted, and `Item` has no DELETE grant (it is set
 * INACTIVE). A tombstone written for an entity that is later re-created with the
 * same id is upserted, so the unique `(tenantId, entity, entityId)` key cannot be
 * violated by a delete → re-create → delete sequence.
 */

/** The transaction surface this needs: enough for the tombstone upsert. */
type TombstoneWriter = Pick<typeof prisma, "syncDeletion">;

export async function recordSyncDeletion(
  tx: TombstoneWriter,
  input: {
    tenantId: string;
    entity: SyncEntity;
    entityId: string;
    /** The revision the row had when it was deleted. */
    revision: number;
    deletedById: string;
  },
): Promise<void> {
  await tx.syncDeletion.upsert({
    where: {
      tenantId_entity_entityId: {
        tenantId: input.tenantId,
        entity: input.entity,
        entityId: input.entityId,
      },
    },
    create: {
      tenantId: input.tenantId,
      entity: input.entity,
      entityId: input.entityId,
      revision: input.revision,
      deletedById: input.deletedById,
    },
    update: {
      revision: input.revision,
      deletedAt: new Date(),
      deletedById: input.deletedById,
    },
  });
}
