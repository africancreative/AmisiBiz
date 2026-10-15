import { PERMISSIONS, type Permission } from "@amisibiz/auth";
import { prisma } from "@amisibiz/database";
import type { ActionResult } from "@/lib/errors";
import type { SyncOperationInput } from "@/lib/validations/sync";
import {
  createContactAction,
  updateContactAction,
} from "@/server/actions/contact";
import { createItemAction, updateItemAction } from "@/server/actions/item";
import {
  createContactItemAction,
  updateContactItemAction,
} from "@/server/actions/contact-item";

/**
 * The operation registry: the one place that maps a client's `type` string to the
 * work the server performs for it.
 *
 * The design's non-negotiable rule is that every operation goes through the
 * **same authorization, the same Zod validation and the same tenant check** as
 * the equivalent Server Action, so the sync layer implements no second copy
 * (offline-client design §7.1). That is why each entry below is a thin adapter:
 * it re-keys the client's envelope into the exact input the existing Server
 * Action already accepts, and the action does everything else — validate,
 * authorize, enforce the tenant predicate, write the audit event.
 *
 * The registry is *closed*: a type that is not listed is `rejected`, not
 * guessed at. The set below is the supported slice of the design's operation
 * vocabulary; the operations that are deliberately missing are named in
 * `docs/implementation/phase-06-sync-server-report.md` rather than invented here.
 *
 * `entity` and `type` are both sent by the client and both checked. A client that
 * got the type right and the entity wrong would otherwise have its write applied
 * to the wrong table (the reference's own words for why `entity` is explicit),
 * so a mismatch is a refusal before anything is authorized.
 */

/** The local/remote table names this slice can route. */
export const SUPPORTED_SYNC_ENTITIES = [
  "contact",
  "item",
  "customer_price",
] as const;

export type SyncEntity = (typeof SUPPORTED_SYNC_ENTITIES)[number];

export type SyncOperationHandler = {
  /** The entity this type writes. Must equal the operation's `entity`. */
  readonly entity: SyncEntity;
  /** The permission the underlying Server Action will enforce. */
  readonly permission: Permission;
  /**
   * Re-keys the envelope's `payload` into the Server Action's input: the tenant
   * is supplied by the server (never by the client), the client's `entityId`
   * becomes the action's row id, and a create carries its own `id` so the row
   * keeps the device-minted identity.
   */
  readonly buildInput: (
    operation: SyncOperationInput,
    tenantId: string,
  ) => unknown;
  /**
   * The existing Server Action. `rowId` is the client's `entityId`, passed as the
   * trusted `CreateActionOptions.rowId` for creates and ignored by updates (whose
   * identity is already in the action's input as `contactId`/`itemId`/…).
   */
  readonly run: (
    rawInput: unknown,
    rowId: string,
  ) => Promise<ActionResult<unknown>>;
};

export const SYNC_OPERATION_HANDLERS: Readonly<
  Record<string, SyncOperationHandler>
> = {
  "contact.create": {
    entity: "contact",
    permission: PERMISSIONS.CONTACTS_CREATE,
    buildInput: (operation, tenantId) => ({
      ...operation.payload,
      tenantId,
    }),
    run: (input, rowId) => createContactAction(input, { rowId }),
  },
  "contact.update": {
    entity: "contact",
    permission: PERMISSIONS.CONTACTS_UPDATE,
    buildInput: (operation, tenantId) => ({
      ...operation.payload,
      tenantId,
      contactId: operation.entityId,
    }),
    run: (input) => updateContactAction(input),
  },
  "item.create": {
    entity: "item",
    permission: PERMISSIONS.ITEMS_CREATE,
    buildInput: (operation, tenantId) => ({
      ...operation.payload,
      tenantId,
    }),
    run: (input, rowId) => createItemAction(input, { rowId }),
  },
  "item.update": {
    entity: "item",
    permission: PERMISSIONS.ITEMS_UPDATE,
    buildInput: (operation, tenantId) => ({
      ...operation.payload,
      tenantId,
      itemId: operation.entityId,
    }),
    run: (input) => updateItemAction(input),
  },
  "customer_price.create": {
    entity: "customer_price",
    permission: PERMISSIONS.ITEMS_CREATE,
    buildInput: (operation, tenantId) => ({
      ...operation.payload,
      tenantId,
    }),
    run: (input, rowId) => createContactItemAction(input, { rowId }),
  },
  "customer_price.update": {
    entity: "customer_price",
    permission: PERMISSIONS.ITEMS_UPDATE,
    buildInput: (operation, tenantId) => ({
      ...operation.payload,
      tenantId,
      contactItemId: operation.entityId,
    }),
    run: (input) => updateContactItemAction(input),
  },
};

/**
 * The row's current server revision, or null when the row is not in the tenant
 * (which for an update means "nothing to update").
 *
 * Read with the tenant predicate in the WHERE clause, so this cannot be used to
 * probe another workspace's rows.
 */
export async function readRowRevision(
  entity: SyncEntity,
  tenantId: string,
  entityId: string,
): Promise<number | null> {
  switch (entity) {
    case "contact": {
      const row = await prisma.contact.findFirst({
        where: { id: entityId, tenantId },
        select: { revision: true },
      });
      return row?.revision ?? null;
    }
    case "item": {
      const row = await prisma.item.findFirst({
        where: { id: entityId, tenantId },
        select: { revision: true },
      });
      return row?.revision ?? null;
    }
    case "customer_price": {
      const row = await prisma.contactItem.findFirst({
        where: { id: entityId, tenantId },
        select: { revision: true },
      });
      return row?.revision ?? null;
    }
  }
}
