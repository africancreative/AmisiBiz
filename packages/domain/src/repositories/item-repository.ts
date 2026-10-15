import type {
  ItemQuery,
  ItemRecord,
  ItemStatus,
  ItemType,
  Page,
} from "./types";

/**
 * Persistence port for the item catalogue.
 *
 * Contract only — see `./types.ts`. Items are tenant-owned and every query is
 * scoped by `tenantId`. `unitPrice` is a decimal string; a caller must never
 * coerce it to a JS number. `archive`/`restore` toggle the ACTIVE/INACTIVE
 * status rather than deleting a row that an issued document may reference.
 */
export interface ItemRepository {
  findById(tenantId: string, itemId: string): Promise<ItemRecord | null>;

  /** Case-insensitive search across name, SKU and description. */
  list(tenantId: string, query: ItemQuery): Promise<Page<ItemRecord>>;

  create(
    tenantId: string,
    input: {
      type: ItemType;
      name: string;
      sku?: string | null;
      description?: string | null;
      unitOfMeasure: string;
      unitPrice: string;
      currency: string;
      taxRateId?: string | null;
      notes?: string | null;
    },
  ): Promise<ItemRecord>;

  update(
    tenantId: string,
    itemId: string,
    input: Partial<{
      type: ItemType;
      status: ItemStatus;
      name: string;
      sku: string | null;
      description: string | null;
      unitOfMeasure: string;
      unitPrice: string;
      currency: string;
      taxRateId: string | null;
      notes: string | null;
    }>,
  ): Promise<ItemRecord | null>;

  /** Returns false when the item is not in the tenant. */
  archive(tenantId: string, itemId: string): Promise<boolean>;

  /** Returns false when the item is not in the tenant. */
  restore(tenantId: string, itemId: string): Promise<boolean>;
}
