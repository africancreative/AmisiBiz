import type { SqlDriver } from "./driver";
import {
  cellBoolean,
  cellDecimal,
  cellString,
  type SqlRow,
  type SqlValue,
} from "./types";
import {
  ITEM_STATUSES,
  ITEM_TYPES,
  type LocalItemStatus,
  type LocalItemType,
  type SyncState,
} from "./constants";
import {
  assertFrameTenant,
  boolField,
  decimalField,
  enumField,
  textField,
  timestampField,
  type PullFrame,
} from "./changes";
import { likePattern, readRowState } from "./sync-state";
import type { LocalOutbox } from "./outbox";
import { newUuid } from "./ids";

/**
 * The catalogue: items/services and the customer-specific entries that price
 * them.
 *
 * These are mirrored for one reason — a quotation drafted offline has to be
 * priced from the same agreed price and tax rate the server would use. The
 * local numbers are a *preview*: the server recomputes every line at issuance
 * with the same `@amisibiz/documents` engine (imported, never copied), and the
 * pull replaces the local figures with the authoritative ones.
 */

export interface LocalItem {
  readonly id: string;
  readonly tenantId: string;
  readonly type: LocalItemType;
  readonly status: LocalItemStatus;
  readonly name: string;
  readonly sku: string | null;
  readonly description: string | null;
  readonly unitOfMeasure: string;
  /** Decimal text — the server's `numeric(18,4)`, never a float. */
  readonly unitPrice: string;
  readonly currency: string;
  readonly taxRateId: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly syncState: SyncState;
  readonly serverUpdatedAt: string | null;
  readonly baseRevision: number | null;
  readonly deleted: boolean;
  readonly lastError: string | null;
}

export interface LocalCustomerPrice {
  readonly id: string;
  readonly tenantId: string;
  readonly contactId: string;
  readonly itemId: string;
  readonly customCode: string | null;
  readonly customName: string | null;
  readonly agreedPrice: string;
  readonly discountPercent: string;
  readonly isAvailable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly syncState: SyncState;
  readonly baseRevision: number | null;
  readonly deleted: boolean;
}

export interface NewItem {
  readonly tenantId: string;
  readonly id?: string;
  readonly type?: LocalItemType;
  readonly name: string;
  readonly sku?: string | null;
  readonly description?: string | null;
  readonly unitOfMeasure?: string;
  readonly unitPrice: string;
  readonly currency?: string;
  readonly taxRateId?: string | null;
  readonly notes?: string | null;
}

export interface ItemPatch {
  readonly type?: LocalItemType;
  readonly name?: string;
  readonly sku?: string | null;
  readonly description?: string | null;
  readonly unitOfMeasure?: string;
  readonly unitPrice?: string;
  readonly currency?: string;
  readonly taxRateId?: string | null;
  readonly notes?: string | null;
  readonly status?: LocalItemStatus;
}

export interface NewCustomerPrice {
  readonly tenantId: string;
  readonly contactId: string;
  readonly itemId: string;
  readonly id?: string;
  readonly customCode?: string | null;
  readonly customName?: string | null;
  readonly agreedPrice: string;
  readonly discountPercent?: string;
  readonly isAvailable?: boolean;
}

export interface CatalogueListOptions {
  readonly search?: string;
  readonly status?: LocalItemStatus;
  readonly type?: LocalItemType;
  readonly syncState?: SyncState;
  readonly limit?: number;
  readonly offset?: number;
}

const ITEM_COLUMNS = `id, tenant_id, type, status, name, sku, description, unit_of_measure,
                      unit_price, currency, tax_rate_id, notes, created_at, updated_at,
                      sync_state, server_updated_at, base_revision, deleted, last_error`;

const PRICE_COLUMNS = `id, tenant_id, contact_id, item_id, custom_code, custom_name,
                       agreed_price, discount_percent, is_available, created_at, updated_at,
                       sync_state, base_revision, deleted`;

function itemFrom(row: SqlRow): LocalItem {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    type: String(row.type) as LocalItemType,
    status: String(row.status) as LocalItemStatus,
    name: String(row.name),
    sku: cellString(row, "sku"),
    description: cellString(row, "description"),
    unitOfMeasure: String(row.unit_of_measure),
    unitPrice: cellDecimal(row, "unit_price"),
    currency: String(row.currency),
    taxRateId: cellString(row, "tax_rate_id"),
    notes: cellString(row, "notes"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncState: String(row.sync_state) as SyncState,
    serverUpdatedAt: cellString(row, "server_updated_at"),
    baseRevision:
      row.base_revision === null ? null : Math.trunc(Number(row.base_revision)),
    deleted: cellBoolean(row, "deleted"),
    lastError: cellString(row, "last_error"),
  };
}

function priceFrom(row: SqlRow): LocalCustomerPrice {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    contactId: String(row.contact_id),
    itemId: String(row.item_id),
    customCode: cellString(row, "custom_code"),
    customName: cellString(row, "custom_name"),
    agreedPrice: cellDecimal(row, "agreed_price"),
    discountPercent: cellDecimal(row, "discount_percent"),
    isAvailable: cellBoolean(row, "is_available"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncState: String(row.sync_state) as SyncState,
    baseRevision:
      row.base_revision === null ? null : Math.trunc(Number(row.base_revision)),
    deleted: cellBoolean(row, "deleted"),
  };
}

function compact<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export class ItemRepository {
  private readonly driver: SqlDriver;
  private readonly outbox: LocalOutbox;
  private readonly requireTenant: (tenantId: string) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    driver: SqlDriver,
    outbox: LocalOutbox,
    options: {
      requireTenant: (tenantId: string) => void;
      now?: () => Date;
      newId?: () => string;
    },
  ) {
    this.driver = driver;
    this.outbox = outbox;
    this.requireTenant = options.requireTenant;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? newUuid;
  }

  async create(input: NewItem): Promise<LocalItem> {
    this.requireTenant(input.tenantId);
    const id = input.id ?? this.newId();
    const timestamp = this.now().toISOString();

    await this.driver.transaction(async () => {
      await this.driver.run(
        `INSERT INTO item (${ITEM_COLUMNS})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'local',NULL,NULL,0,NULL)`,
        [
          id,
          input.tenantId,
          input.type ?? "PRODUCT",
          "ACTIVE",
          input.name,
          input.sku ?? null,
          input.description ?? null,
          input.unitOfMeasure ?? "each",
          input.unitPrice,
          input.currency ?? "KES",
          input.taxRateId ?? null,
          input.notes ?? null,
          timestamp,
          timestamp,
        ],
      );
      const created = await this.get(id, input.tenantId);
      if (!created) throw new Error(`Item ${id} was not written`);
      await this.outbox.enqueue({
        tenantId: input.tenantId,
        entity: "item",
        entityId: id,
        type: "item.create",
        payload: itemPayload(created),
      });
    });

    const persisted = await this.get(id, input.tenantId);
    if (!persisted) throw new Error(`Item ${id} vanished after commit`);
    return persisted;
  }

  async update(
    tenantId: string,
    id: string,
    patch: ItemPatch,
  ): Promise<LocalItem> {
    this.requireTenant(tenantId);
    const existing = await this.get(id, tenantId);
    if (!existing) {
      throw new Error(
        `Item ${id} is not in this workspace, or belongs to another tenant`,
      );
    }
    if (existing.syncState === "conflict") {
      throw new Error(
        `Item ${id} has an unresolved conflict; resolve it before editing`,
      );
    }

    const timestamp = this.now().toISOString();
    const merged = { ...existing, ...compact(patch) };

    await this.driver.transaction(async () => {
      await this.driver.run(
        `UPDATE item
            SET type = ?, status = ?, name = ?, sku = ?, description = ?,
                unit_of_measure = ?, unit_price = ?, currency = ?, tax_rate_id = ?,
                notes = ?, updated_at = ?, sync_state = 'pending', last_error = NULL
          WHERE id = ? AND tenant_id = ?`,
        [
          merged.type,
          merged.status,
          merged.name,
          merged.sku,
          merged.description,
          merged.unitOfMeasure,
          merged.unitPrice,
          merged.currency,
          merged.taxRateId,
          merged.notes,
          timestamp,
          id,
          tenantId,
        ],
      );
      const updated = await this.get(id, tenantId);
      if (!updated) throw new Error(`Item ${id} vanished mid-update`);
      await this.outbox.enqueue({
        tenantId,
        entity: "item",
        entityId: id,
        type: "item.update",
        payload: itemPayload(updated),
        ...(existing.baseRevision === null
          ? {}
          : { baseRevision: existing.baseRevision }),
      });
    });

    const persisted = await this.get(id, tenantId);
    if (!persisted) throw new Error(`Item ${id} vanished after the update`);
    return persisted;
  }

  /**
   * Inactivates rather than deletes. `deleteItemAction` on the server is a hard
   * delete, which is precisely why the pull protocol needs tombstones (design
   * §7.3) — but the offline client has no reason to offer a destructive delete
   * it cannot undo, so the local surface stops at INACTIVE.
   */
  async setStatus(
    tenantId: string,
    id: string,
    status: LocalItemStatus,
  ): Promise<LocalItem> {
    this.requireTenant(tenantId);
    const timestamp = this.now().toISOString();
    await this.driver.transaction(async () => {
      const result = await this.driver.run(
        `UPDATE item SET status = ?, updated_at = ?, sync_state = 'pending', last_error = NULL
          WHERE id = ? AND tenant_id = ? AND deleted = 0`,
        [status, timestamp, id, tenantId],
      );
      if (result.changes === 0) {
        throw new Error(`Item ${id} is not present in this workspace`);
      }
      await this.outbox.enqueue({
        tenantId,
        entity: "item",
        entityId: id,
        type: "item.status",
        payload: { id, status, updatedAt: timestamp },
      });
    });
    const persisted = await this.get(id, tenantId);
    if (!persisted)
      throw new Error(`Item ${id} vanished after the status change`);
    return persisted;
  }

  async get(id: string, tenantId: string): Promise<LocalItem | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT ${ITEM_COLUMNS} FROM item WHERE id = ? AND tenant_id = ? AND deleted = 0`,
      [id, tenantId],
    );
    return row ? itemFrom(row) : null;
  }

  async list(
    tenantId: string,
    options: CatalogueListOptions = {},
  ): Promise<LocalItem[]> {
    const where: string[] = [`tenant_id = ?`, `deleted = 0`];
    const params: SqlValue[] = [tenantId];

    if (options.status) {
      where.push(`status = ?`);
      params.push(options.status);
    }
    if (options.type) {
      where.push(`type = ?`);
      params.push(options.type);
    }
    if (options.syncState) {
      where.push(`sync_state = ?`);
      params.push(options.syncState);
    }
    if (options.search && options.search.trim().length > 0) {
      const pattern = likePattern(options.search.trim());
      where.push(`(name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = await this.driver.all<SqlRow>(
      `SELECT ${ITEM_COLUMNS} FROM item
        WHERE ${where.join(" AND ")}
        ORDER BY name ASC, id ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(itemFrom);
  }

  async count(tenantId: string): Promise<number> {
    const row = await this.driver.get<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM item WHERE tenant_id = ? AND deleted = 0`,
      [tenantId],
    );
    return Math.trunc(Number(row?.count ?? 0));
  }

  async applyPull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const timestamp = this.now().toISOString();

    if (frame.deleted) {
      await this.driver.run(
        `UPDATE item SET deleted = 1, updated_at = ?, sync_state = 'synced',
                          server_updated_at = ?, base_revision = ?
          WHERE id = ? AND tenant_id = ?`,
        [timestamp, frame.updatedAt, frame.revision, frame.id, tenantId],
      );
      return;
    }

    const exists = await readRowState(this.driver, "item", frame.id);
    const values = [
      // Enum fields are validated against the values the local CHECK allows, so
      // a server that starts sending `"GIFT_CARD"` produces a message naming the
      // field and the permitted set instead of an opaque constraint failure
      // from SQLite three statements later.
      enumField(frame, "type", ITEM_TYPES, "PRODUCT"),
      enumField(frame, "status", ITEM_STATUSES, "ACTIVE"),
      textField(frame, "name", { required: true }),
      textField(frame, "sku"),
      textField(frame, "description"),
      textField(frame, "unitOfMeasure") ?? "each",
      decimalField(frame, "unitPrice", "0.0000"),
      textField(frame, "currency") ?? "KES",
      textField(frame, "taxRateId"),
      textField(frame, "notes"),
      timestampField(frame, "createdAt") ?? frame.updatedAt,
      frame.updatedAt,
      frame.updatedAt,
      frame.revision,
    ];

    if (exists) {
      await this.driver.run(
        `UPDATE item
            SET type = ?, status = ?, name = ?, sku = ?, description = ?,
                unit_of_measure = ?, unit_price = ?, currency = ?, tax_rate_id = ?,
                notes = ?, created_at = ?, updated_at = ?, sync_state = 'synced',
                server_updated_at = ?, base_revision = ?, deleted = 0, last_error = NULL
          WHERE id = ? AND tenant_id = ?`,
        [...values, frame.id, tenantId],
      );
      return;
    }

    await this.driver.run(
      `INSERT INTO item (${ITEM_COLUMNS})
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,0,NULL)`,
      [frame.id, tenantId, ...values],
    );
  }
}

function itemPayload(item: LocalItem): Record<string, unknown> {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    name: item.name,
    sku: item.sku,
    description: item.description,
    unitOfMeasure: item.unitOfMeasure,
    unitPrice: item.unitPrice,
    currency: item.currency,
    taxRateId: item.taxRateId,
    notes: item.notes,
  };
}

export class CustomerPriceRepository {
  private readonly driver: SqlDriver;
  private readonly outbox: LocalOutbox;
  private readonly requireTenant: (tenantId: string) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    driver: SqlDriver,
    outbox: LocalOutbox,
    options: {
      requireTenant: (tenantId: string) => void;
      now?: () => Date;
      newId?: () => string;
    },
  ) {
    this.driver = driver;
    this.outbox = outbox;
    this.requireTenant = options.requireTenant;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? newUuid;
  }

  /** One entry per (tenant, contact, item) — the server's unique key, enforced locally too. */
  async set(input: NewCustomerPrice): Promise<LocalCustomerPrice> {
    this.requireTenant(input.tenantId);
    const timestamp = this.now().toISOString();

    const existing = await this.driver.get<{ id: string }>(
      `SELECT id FROM customer_price
        WHERE tenant_id = ? AND contact_id = ? AND item_id = ?`,
      [input.tenantId, input.contactId, input.itemId],
    );
    const id = input.id ?? existing?.id ?? this.newId();

    await this.driver.transaction(async () => {
      await this.driver.run(
        `INSERT INTO customer_price (${PRICE_COLUMNS})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'local',NULL,0,NULL)
         ON CONFLICT(tenant_id, contact_id, item_id) DO UPDATE SET
           custom_code = excluded.custom_code, custom_name = excluded.custom_name,
           agreed_price = excluded.agreed_price, discount_percent = excluded.discount_percent,
           is_available = excluded.is_available, updated_at = excluded.updated_at,
           sync_state = 'pending', deleted = 0`,
        [
          id,
          input.tenantId,
          input.contactId,
          input.itemId,
          input.customCode ?? null,
          input.customName ?? null,
          input.agreedPrice,
          input.discountPercent ?? "0.00",
          input.isAvailable === false ? 0 : 1,
          timestamp,
          timestamp,
        ],
      );
      const row = await this.driver.get<SqlRow>(
        `SELECT ${PRICE_COLUMNS} FROM customer_price WHERE id = ?`,
        [id],
      );
      if (!row) throw new Error(`Customer price ${id} was not written`);
      const saved = priceFrom(row);
      await this.outbox.enqueue({
        tenantId: input.tenantId,
        entity: "customer_price",
        entityId: id,
        type: existing ? "customer_price.update" : "customer_price.create",
        payload: {
          id,
          contactId: input.contactId,
          itemId: input.itemId,
          customCode: saved.customCode,
          customName: saved.customName,
          agreedPrice: saved.agreedPrice,
          discountPercent: saved.discountPercent,
          isAvailable: saved.isAvailable,
        },
        ...(saved.baseRevision === null
          ? {}
          : { baseRevision: saved.baseRevision }),
      });
    });

    const row = await this.driver.get<SqlRow>(
      `SELECT ${PRICE_COLUMNS} FROM customer_price WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error(`Customer price ${id} vanished after commit`);
    return priceFrom(row);
  }

  async forContact(
    tenantId: string,
    contactId: string,
  ): Promise<LocalCustomerPrice[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT ${PRICE_COLUMNS} FROM customer_price
        WHERE tenant_id = ? AND contact_id = ? AND deleted = 0
        ORDER BY item_id ASC`,
      [tenantId, contactId],
    );
    return rows.map(priceFrom);
  }

  async get(id: string, tenantId: string): Promise<LocalCustomerPrice | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT ${PRICE_COLUMNS} FROM customer_price WHERE id = ? AND tenant_id = ? AND deleted = 0`,
      [id, tenantId],
    );
    return row ? priceFrom(row) : null;
  }

  /** The price a line should use: the customer's agreed price when one exists. */
  async effectiveUnitPrice(
    tenantId: string,
    contactId: string | null,
    itemId: string,
  ): Promise<{ price: string; source: "customer_price" | "item" } | null> {
    if (contactId) {
      const row = await this.driver.get<SqlRow>(
        `SELECT ${PRICE_COLUMNS} FROM customer_price
          WHERE tenant_id = ? AND contact_id = ? AND item_id = ? AND deleted = 0
            AND is_available = 1`,
        [tenantId, contactId, itemId],
      );
      if (row)
        return {
          price: cellDecimal(row, "agreed_price"),
          source: "customer_price",
        };
    }
    const item = await this.driver.get<SqlRow>(
      `SELECT ${ITEM_COLUMNS} FROM item WHERE id = ? AND tenant_id = ? AND deleted = 0`,
      [itemId, tenantId],
    );
    if (!item) return null;
    return { price: cellDecimal(item, "unit_price"), source: "item" };
  }

  async applyPull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const timestamp = this.now().toISOString();

    if (frame.deleted) {
      await this.driver.run(
        `UPDATE customer_price SET deleted = 1, updated_at = ?, sync_state = 'synced',
                                  base_revision = ?
          WHERE id = ? AND tenant_id = ?`,
        [timestamp, frame.revision, frame.id, tenantId],
      );
      return;
    }

    await this.driver.run(
      `INSERT INTO customer_price (${PRICE_COLUMNS})
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?,0)
       ON CONFLICT(tenant_id, contact_id, item_id) DO UPDATE SET
         custom_code = excluded.custom_code, custom_name = excluded.custom_name,
         agreed_price = excluded.agreed_price, discount_percent = excluded.discount_percent,
         is_available = excluded.is_available, updated_at = excluded.updated_at,
         sync_state = 'synced', base_revision = excluded.base_revision, deleted = 0`,
      [
        frame.id,
        tenantId,
        textField(frame, "contactId", { required: true }),
        textField(frame, "itemId", { required: true }),
        textField(frame, "customCode"),
        textField(frame, "customName"),
        decimalField(frame, "agreedPrice", "0.0000"),
        decimalField(frame, "discountPercent", "0.00"),
        boolField(frame, "isAvailable", true) ? 1 : 0,
        timestampField(frame, "createdAt") ?? frame.updatedAt,
        frame.updatedAt,
        frame.revision,
      ],
    );
  }
}
