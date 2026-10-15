import type { SqlDriver } from "./driver";
import { cellBoolean, cellString, type SqlRow, type SqlValue } from "./types";
import {
  CONTACT_TYPES,
  type LocalContactStatus,
  type LocalContactType,
  type SyncState,
} from "./constants";
import { CONTACT_STATUSES } from "./constants";
import {
  assertFrameTenant,
  boolField,
  enumField,
  textField,
  timestampField,
  type PullFrame,
} from "./changes";
import { likePattern, readRowState } from "./sync-state";
import type { LocalOutbox } from "./outbox";
import { newUuid } from "./ids";

/**
 * Contacts, offline.
 *
 * Every write here does three things inside one transaction: writes the local
 * row, stamps its `sync_state`, and enqueues the operation that will carry it
 * to the server. There is no method that writes a row without an operation,
 * which is why a device that dies mid-edit cannot end up holding a contact
 * nobody has ever been told about.
 *
 * Two of the directive's rules are structural rather than advisory:
 *
 *   - A payload never carries a tenant id. The server derives the tenant from
 *     the verified session (design §6), so a device that claimed another
 *     workspace would be refused rather than believed.
 *   - A row in `conflict` refuses an edit. Allowing one would overwrite the
 *     disagreement record, which is the silent overwrite the design forbids;
 *     the user resolves the conflict first.
 */

export interface LocalContact {
  readonly id: string;
  readonly tenantId: string;
  readonly type: LocalContactType;
  readonly status: LocalContactStatus;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly mobile: string | null;
  readonly taxPin: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly syncState: SyncState;
  readonly serverUpdatedAt: string | null;
  readonly baseRevision: number | null;
  readonly deleted: boolean;
  readonly lastError: string | null;
}

export interface LocalContactAddress {
  readonly id: string;
  readonly contactId: string;
  readonly type: "POSTAL" | "PHYSICAL";
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly syncState: SyncState;
}

export interface ContactWithAddresses extends LocalContact {
  readonly addresses: readonly LocalContactAddress[];
}

export interface NewContactAddress {
  readonly id?: string;
  readonly type: "POSTAL" | "PHYSICAL";
  readonly line1: string;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly isDefault?: boolean;
}

export interface NewContact {
  readonly tenantId: string;
  /** Client-generated, so a retried create cannot mint a second contact. */
  readonly id?: string;
  readonly type?: LocalContactType;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly companyName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly mobile?: string | null;
  readonly taxPin?: string | null;
  readonly notes?: string | null;
  readonly addresses?: readonly NewContactAddress[];
}

export interface ContactPatch {
  readonly type?: LocalContactType;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly companyName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly mobile?: string | null;
  readonly taxPin?: string | null;
  readonly notes?: string | null;
}

export interface ContactListOptions {
  readonly search?: string;
  readonly status?: LocalContactStatus;
  readonly syncState?: SyncState;
  readonly limit?: number;
  readonly offset?: number;
}

const CONTACT_COLUMNS = `id, tenant_id, type, status, first_name, last_name, company_name,
                         email, phone, mobile, tax_pin, notes, portal_user_id,
                         created_at, updated_at, archived_at, sync_state,
                         server_updated_at, base_revision, deleted, last_error`;

function contactFrom(row: SqlRow): LocalContact {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    type: String(row.type) as LocalContactType,
    status: String(row.status) as LocalContactStatus,
    firstName: cellString(row, "first_name"),
    lastName: cellString(row, "last_name"),
    companyName: cellString(row, "company_name"),
    email: cellString(row, "email"),
    phone: cellString(row, "phone"),
    mobile: cellString(row, "mobile"),
    taxPin: cellString(row, "tax_pin"),
    notes: cellString(row, "notes"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: cellString(row, "archived_at"),
    syncState: String(row.sync_state) as SyncState,
    serverUpdatedAt: cellString(row, "server_updated_at"),
    baseRevision:
      cellString(row, "base_revision") === null
        ? null
        : Math.trunc(Number(row.base_revision)),
    deleted: cellBoolean(row, "deleted"),
    lastError: cellString(row, "last_error"),
  };
}

function addressFrom(row: SqlRow): LocalContactAddress {
  return {
    id: String(row.id),
    contactId: String(row.contact_id),
    type: String(row.type) as LocalContactAddress["type"],
    line1: String(row.line1),
    line2: cellString(row, "line2"),
    city: cellString(row, "city"),
    state: cellString(row, "state"),
    postalCode: cellString(row, "postal_code"),
    country: cellString(row, "country"),
    isDefault: cellBoolean(row, "is_default"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncState: String(row.sync_state) as SyncState,
  };
}

/** The fields the server's contact schema reads. No tenant id, by design. */
function contactPayload(contact: LocalContact): Record<string, unknown> {
  return {
    id: contact.id,
    type: contact.type,
    firstName: contact.firstName,
    lastName: contact.lastName,
    companyName: contact.companyName,
    email: contact.email,
    phone: contact.phone,
    mobile: contact.mobile,
    taxPin: contact.taxPin,
    notes: contact.notes,
    status: contact.status,
  };
}

export class ContactRepository {
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

  async create(input: NewContact): Promise<ContactWithAddresses> {
    this.requireTenant(input.tenantId);
    const id = input.id ?? this.newId();
    const timestamp = this.now().toISOString();

    await this.driver.transaction(async () => {
      await this.driver.run(
        `INSERT INTO contact (${CONTACT_COLUMNS})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,'local',NULL,NULL,0,NULL)`,
        [
          id,
          input.tenantId,
          input.type ?? "INDIVIDUAL",
          "ACTIVE",
          input.firstName ?? null,
          input.lastName ?? null,
          input.companyName ?? null,
          input.email ?? null,
          input.phone ?? null,
          input.mobile ?? null,
          input.taxPin ?? null,
          input.notes ?? null,
          timestamp,
          timestamp,
        ],
      );

      for (const address of input.addresses ?? []) {
        await this.insertAddress(id, address, timestamp, "local");
      }

      const created = await this.get(id, input.tenantId);
      if (!created) throw new Error(`Contact ${id} was not written`);
      await this.outbox.enqueue({
        tenantId: input.tenantId,
        entity: "contact",
        entityId: id,
        type: "contact.create",
        payload: contactPayload(created),
      });
    });

    const persisted = await this.get(id, input.tenantId);
    if (!persisted) throw new Error(`Contact ${id} vanished after commit`);
    return persisted;
  }

  async update(
    tenantId: string,
    id: string,
    patch: ContactPatch,
  ): Promise<ContactWithAddresses> {
    this.requireTenant(tenantId);
    const existing = await this.get(id, tenantId);
    if (!existing) {
      throw new Error(
        `Contact ${id} is not in this workspace, or belongs to another tenant`,
      );
    }
    if (existing.syncState === "conflict") {
      throw new Error(
        `Contact ${id} has an unresolved conflict. Resolve it before editing — ` +
          `editing now would discard one side of the disagreement.`,
      );
    }

    const timestamp = this.now().toISOString();
    const merged = { ...existing, ...compact(patch) };

    await this.driver.transaction(async () => {
      await this.driver.run(
        `UPDATE contact
            SET type = ?, status = ?, first_name = ?, last_name = ?, company_name = ?,
                email = ?, phone = ?, mobile = ?, tax_pin = ?, notes = ?,
                updated_at = ?, sync_state = 'pending', last_error = NULL
          WHERE id = ? AND tenant_id = ?`,
        [
          merged.type,
          merged.status,
          merged.firstName,
          merged.lastName,
          merged.companyName,
          merged.email,
          merged.phone,
          merged.mobile,
          merged.taxPin,
          merged.notes,
          timestamp,
          id,
          tenantId,
        ],
      );

      const updated = await this.get(id, tenantId);
      if (!updated) throw new Error(`Contact ${id} vanished mid-update`);
      await this.outbox.enqueue({
        tenantId,
        entity: "contact",
        entityId: id,
        type: "contact.update",
        payload: contactPayload(updated),
        ...(existing.baseRevision === null
          ? {}
          : { baseRevision: existing.baseRevision }),
      });
    });

    const persisted = await this.get(id, tenantId);
    if (!persisted) throw new Error(`Contact ${id} vanished after the update`);
    return persisted;
  }

  /**
   * Archives rather than deletes, mirroring the server's rule for contacts: a
   * customer with documents must not disappear from under them.
   */
  async archive(tenantId: string, id: string): Promise<ContactWithAddresses> {
    this.requireTenant(tenantId);
    const timestamp = this.now().toISOString();

    await this.driver.transaction(async () => {
      const result = await this.driver.run(
        `UPDATE contact
            SET status = 'ARCHIVED', archived_at = ?, updated_at = ?,
                sync_state = 'pending', last_error = NULL
          WHERE id = ? AND tenant_id = ? AND deleted = 0`,
        [timestamp, timestamp, id, tenantId],
      );
      if (result.changes === 0) {
        throw new Error(`Contact ${id} is not present in this workspace`);
      }
      await this.outbox.enqueue({
        tenantId,
        entity: "contact",
        entityId: id,
        type: "contact.archive",
        payload: { id, archivedAt: timestamp },
      });
    });

    const persisted = await this.get(id, tenantId);
    if (!persisted) throw new Error(`Contact ${id} vanished after archiving`);
    return persisted;
  }

  async addAddress(
    tenantId: string,
    contactId: string,
    address: NewContactAddress,
  ): Promise<LocalContactAddress> {
    this.requireTenant(tenantId);
    const timestamp = this.now().toISOString();
    const id = address.id ?? this.newId();

    await this.driver.transaction(async () => {
      await this.insertAddress(contactId, address, timestamp, "pending");
      await this.outbox.enqueue({
        tenantId,
        entity: "contact_address",
        entityId: id,
        type: "contact_address.create",
        payload: { contactId, ...compact(address) },
      });
    });

    const row = await this.driver.get<SqlRow>(
      `SELECT id, contact_id, type, line1, line2, city, state, postal_code, country,
              is_default, created_at, updated_at, sync_state
         FROM contact_address WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error(`Address ${id} was not written`);
    return addressFrom(row);
  }

  async get(
    id: string,
    tenantId: string,
  ): Promise<ContactWithAddresses | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contact WHERE id = ? AND tenant_id = ? AND deleted = 0`,
      [id, tenantId],
    );
    if (!row) return null;
    return { ...contactFrom(row), addresses: await this.addresses(id) };
  }

  async addresses(contactId: string): Promise<LocalContactAddress[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT id, contact_id, type, line1, line2, city, state, postal_code, country,
              is_default, created_at, updated_at, sync_state
         FROM contact_address
        WHERE contact_id = ? AND deleted = 0
        ORDER BY is_default DESC, created_at ASC, id ASC`,
      [contactId],
    );
    return rows.map(addressFrom);
  }

  async list(
    tenantId: string,
    options: ContactListOptions = {},
  ): Promise<LocalContact[]> {
    const where: string[] = [`tenant_id = ?`, `deleted = 0`];
    const params: SqlValue[] = [tenantId];

    if (options.status) {
      where.push(`status = ?`);
      params.push(options.status);
    }
    if (options.syncState) {
      where.push(`sync_state = ?`);
      params.push(options.syncState);
    }
    if (options.search && options.search.trim().length > 0) {
      const pattern = likePattern(options.search.trim());
      where.push(
        `(company_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\'
          OR first_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
          OR phone LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = await this.driver.all<SqlRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contact
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(contactFrom);
  }

  async count(
    tenantId: string,
    options: { syncState?: SyncState } = {},
  ): Promise<number> {
    const row = options.syncState
      ? await this.driver.get<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM contact
            WHERE tenant_id = ? AND deleted = 0 AND sync_state = ?`,
          [tenantId, options.syncState],
        )
      : await this.driver.get<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM contact WHERE tenant_id = ? AND deleted = 0`,
          [tenantId],
        );
    return Math.trunc(Number(row?.count ?? 0));
  }

  /** Per-state counts — what the "N unsynchronized" chip in the offline UI reads. */
  async stateCounts(tenantId: string): Promise<Record<SyncState, number>> {
    const rows = await this.driver.all<{
      sync_state: string;
      count: string | number;
    }>(
      `SELECT sync_state, COUNT(*) AS count FROM contact
        WHERE tenant_id = ? AND deleted = 0 GROUP BY sync_state`,
      [tenantId],
    );
    const counts: Record<SyncState, number> = {
      local: 0,
      pending: 0,
      synced: 0,
      rejected: 0,
      conflict: 0,
    };
    for (const row of rows) {
      const state = row.sync_state as SyncState;
      if (state in counts) counts[state] = Math.trunc(Number(row.count));
    }
    return counts;
  }

  /**
   * Applies a server frame. Only reached through `applyPullPage`, which has
   * already refused to overwrite a dirty local row — so reaching this method
   * *is* the user's "keep the server copy" decision, not an accident.
   */
  async applyPull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const timestamp = this.now().toISOString();
    const type = enumField(frame, "type", CONTACT_TYPES, "INDIVIDUAL");
    const status = enumField(frame, "status", CONTACT_STATUSES, "ACTIVE");

    if (frame.deleted) {
      await this.driver.run(
        `UPDATE contact SET deleted = 1, updated_at = ?, sync_state = 'synced',
                            server_updated_at = ?, base_revision = ?
          WHERE id = ? AND tenant_id = ?`,
        [timestamp, frame.updatedAt, frame.revision, frame.id, tenantId],
      );
      return;
    }

    const state = await readRowState(this.driver, "contact", frame.id);

    if (state) {
      await this.driver.run(
        `UPDATE contact
            SET type = ?, status = ?, first_name = ?, last_name = ?, company_name = ?,
                email = ?, phone = ?, mobile = ?, tax_pin = ?, notes = ?,
                created_at = ?, updated_at = ?, archived_at = ?,
                sync_state = 'synced', server_updated_at = ?, base_revision = ?,
                deleted = 0, last_error = NULL
          WHERE id = ? AND tenant_id = ?`,
        [
          type,
          status,
          textField(frame, "firstName"),
          textField(frame, "lastName"),
          textField(frame, "companyName"),
          textField(frame, "email"),
          textField(frame, "phone"),
          textField(frame, "mobile"),
          textField(frame, "taxPin"),
          textField(frame, "notes"),
          timestampField(frame, "createdAt") ?? timestamp,
          timestampField(frame, "updatedAt") ?? frame.updatedAt,
          timestampField(frame, "archivedAt"),
          frame.updatedAt,
          frame.revision,
          frame.id,
          tenantId,
        ],
      );
      return;
    }

    await this.driver.run(
      `INSERT INTO contact (${CONTACT_COLUMNS})
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,0,NULL)`,
      [
        frame.id,
        tenantId,
        type,
        status,
        textField(frame, "firstName"),
        textField(frame, "lastName"),
        textField(frame, "companyName"),
        textField(frame, "email"),
        textField(frame, "phone"),
        textField(frame, "mobile"),
        textField(frame, "taxPin"),
        textField(frame, "notes"),
        textField(frame, "portalUserId"),
        timestampField(frame, "createdAt") ?? frame.updatedAt,
        timestampField(frame, "updatedAt") ?? frame.updatedAt,
        timestampField(frame, "archivedAt"),
        frame.updatedAt,
        frame.revision,
      ],
    );
  }

  /**
   * Applies an address frame.
   *
   * `contact_address` carries no `tenant_id` column — the server's table does
   * not either, since an address belongs to a contact — so the isolation check
   * here is the parent: an address whose contact is not in this workspace is
   * refused, and an orphan row is never created. `applyPullPage` deliberately
   * does not run its dirty-row check on this table for the same reason; an
   * address is synchronized as part of its contact's operation, so a
   * server-side edit to one address line while the device holds an unsent
   * contact change is a *contact* conflict, recorded once against the parent.
   */
  async applyAddressPull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const contactId = textField(frame, "contactId", { required: true });
    if (!contactId) throw new Error(`Address frame ${frame.id} has no contact`);

    const parent = await this.driver.get<{ id: string }>(
      `SELECT id FROM contact WHERE id = ? AND tenant_id = ?`,
      [contactId, tenantId],
    );
    if (!parent) {
      throw new Error(
        `Dropped address frame ${frame.id}: its contact ${contactId} is not in this workspace`,
      );
    }

    const timestamp = this.now().toISOString();

    if (frame.deleted) {
      await this.driver.run(
        `UPDATE contact_address SET deleted = 1, updated_at = ?, sync_state = 'synced',
                                  server_updated_at = ?, base_revision = ?
          WHERE id = ?`,
        [timestamp, frame.updatedAt, frame.revision, frame.id],
      );
      return;
    }

    const type = enumField(
      frame,
      "type",
      ["POSTAL", "PHYSICAL"] as const,
      "PHYSICAL",
    );
    const line1 = textField(frame, "line1", { required: true });
    if (line1 === null)
      throw new Error(`Address frame ${frame.id} has no first line`);

    const exists = await this.driver.get<{ id: string }>(
      `SELECT id FROM contact_address WHERE id = ?`,
      [frame.id],
    );

    if (exists) {
      await this.driver.run(
        `UPDATE contact_address
            SET contact_id = ?, type = ?, line1 = ?, line2 = ?, city = ?, state = ?,
                postal_code = ?, country = ?, is_default = ?, updated_at = ?,
                sync_state = 'synced', server_updated_at = ?, base_revision = ?,
                deleted = 0, last_error = NULL
          WHERE id = ?`,
        [
          contactId,
          type,
          line1,
          textField(frame, "line2"),
          textField(frame, "city"),
          textField(frame, "state"),
          textField(frame, "postalCode"),
          textField(frame, "country"),
          boolField(frame, "isDefault") ? 1 : 0,
          timestamp,
          frame.updatedAt,
          frame.revision,
          frame.id,
        ],
      );
      return;
    }

    await this.driver.run(
      `INSERT INTO contact_address (id, contact_id, type, line1, line2, city, state,
                                    postal_code, country, is_default, created_at, updated_at,
                                    sync_state, server_updated_at, base_revision, deleted, last_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'synced', ?,?,0,NULL)`,
      [
        frame.id,
        contactId,
        type,
        line1,
        textField(frame, "line2"),
        textField(frame, "city"),
        textField(frame, "state"),
        textField(frame, "postalCode"),
        textField(frame, "country"),
        boolField(frame, "isDefault") ? 1 : 0,
        timestampField(frame, "createdAt") ?? frame.updatedAt,
        timestampField(frame, "updatedAt") ?? frame.updatedAt,
        frame.updatedAt,
        frame.revision,
      ],
    );
  }

  /**
   * Re-applies a preserved draft as a NEW operation against the current server
   * revision — the only "local wins" the product allows (design §7.4). The
   * original operation and the conflict record both stay; nothing is deleted.
   */
  async reapplyAfterConflict(tenantId: string, id: string): Promise<string> {
    this.requireTenant(tenantId);
    const contact = await this.get(id, tenantId);
    if (!contact) throw new Error(`Contact ${id} is not in this workspace`);

    // The revision this change is offered against. A row that was synchronized
    // before it diverged already carries that in `base_revision`; a row created
    // offline carries nothing, because the server had never heard of it, so the
    // number comes from the open conflict — the revision the pull page refused
    // to write. Reading it here rather than trusting a caller to pass it is the
    // point: an update that arrives with no base revision is an update the
    // server cannot check, and "do not overwrite newer server data" would
    // quietly become "overwrite whatever is there".
    const against = await this.driver.get<{ revision: string | number | null }>(
      `SELECT COALESCE(
                (SELECT server_revision FROM conflict
                  WHERE tenant_id = ? AND entity = 'contact' AND entity_id = ?
                    AND resolved_at IS NULL
                  ORDER BY detected_at DESC LIMIT 1),
                ?
              ) AS revision`,
      [tenantId, id, contact.baseRevision],
    );
    const baseRevision =
      against?.revision === null || against?.revision === undefined
        ? null
        : Math.trunc(Number(against.revision));

    return this.driver.transaction(async () => {
      const timestamp = this.now().toISOString();
      await this.driver.run(
        `UPDATE contact SET sync_state = 'pending', updated_at = ?, last_error = NULL
          WHERE id = ? AND tenant_id = ?`,
        [timestamp, id, tenantId],
      );
      const operation = await this.outbox.enqueue({
        tenantId,
        entity: "contact",
        entityId: id,
        type: "contact.update",
        payload: contactPayload(contact),
        ...(baseRevision === null ? {} : { baseRevision }),
      });
      return operation.id;
    });
  }

  private async insertAddress(
    contactId: string,
    address: NewContactAddress,
    timestamp: string,
    syncState: SyncState,
  ): Promise<void> {
    await this.driver.run(
      `INSERT INTO contact_address (id, contact_id, type, line1, line2, city, state,
                                    postal_code, country, is_default, created_at, updated_at,
                                    sync_state, server_updated_at, base_revision, deleted, last_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,NULL)`,
      [
        address.id ?? this.newId(),
        contactId,
        address.type,
        address.line1,
        address.line2 ?? null,
        address.city ?? null,
        address.state ?? null,
        address.postalCode ?? null,
        address.country ?? null,
        address.isDefault ? 1 : 0,
        timestamp,
        timestamp,
        syncState,
      ],
    );
  }
}

/** Drops keys the caller did not send, so a patch can never blank a column with `undefined`. */
function compact<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}
