import type { SqlDriver } from "./driver";
import { MIGRATIONS } from "./schema";
import { migrate, type Migration, type MigrationReport } from "./migrate";
import type { ChecksumHasher } from "./checksum";
import { LocalOutbox, type OutboxOptions } from "./outbox";
import { MetaRepository } from "./meta-repository";
import { ProvisioningRepository } from "./provisioning";
import { ContactRepository } from "./contact-repository";
import { CustomerPriceRepository, ItemRepository } from "./catalogue";
import { DocumentRepository } from "./document-repository";
import { CheckpointRepository, ConflictRepository } from "./exchange";
import { applyPullPage, type PullPage, type PullPageResult } from "./pull";
import type { PullApplier, PullEntity } from "./changes";
import { newUuid } from "./ids";

/**
 * One open database, one tenant, one signed-in user.
 *
 * This is the object an installed client holds. It exists for three reasons
 * beyond convenience:
 *
 *   1. **The tenant binding is decided once.** Every repository write calls
 *      `requireTenant`, and that check compares against the tenant this
 *      database was provisioned for — never against a value that arrived with
 *      the write. Without it, the client-side stand-in for RLS would have to be
 *      re-implemented at every call site, and one omission would be a
 *      cross-tenant write that nothing else catches (design §1 records that RLS
 *      is inert in the deployed app, so on a device this is the only check).
 *   2. **The schema is validated before anything reads it.** `open()` runs the
 *      migration history check first, so a tampered or newer database is
 *      refused rather than half-read.
 *   3. **`wipe()` is possible.** The append-only trigger on `document_status_event`
 *      protects the audit trail from ordinary use; it must not make "erase this
 *      device" impossible, because a customer's data on a lost phone is a
 *      support obligation, not a theoretical one.
 */

/** Data tables a wipe empties, children before parents. */
const ERASE_TABLES = [
  "document_line",
  "document_payment",
  "document_status_event",
  "document_snapshot",
  "document",
  "customer_price",
  "contact_address",
  "contact",
  "tax_rate",
  "tax_category",
  "item",
  "document_numbering",
  "tenant_branding",
  "tenant_profile",
  "outbox_operation",
  "conflict",
  "sync_checkpoint",
] as const;

const APPEND_ONLY_TRIGGERS = [
  "document_status_event_is_append_only",
  "document_status_event_no_delete",
] as const;

export interface BindSessionInput {
  readonly userId: string;
  readonly sessionVersion: number;
  readonly tokenExpiresAt: string;
  readonly lastAuthorizedAt: string;
  readonly offlineExpiresAt: string;
  readonly tenantId: string;
  readonly tenantStatus: string;
  readonly grantedPermissions: readonly string[];
}

export interface LocalDbOptions {
  readonly driver: SqlDriver;
  /** Tests inject a shorter list; production always uses `MIGRATIONS`. */
  readonly migrations?: readonly Migration[];
  readonly hash?: ChecksumHasher;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly outbox?: OutboxOptions;
}

export interface LocalDbOpenResult {
  readonly report: MigrationReport;
  readonly schemaVersion: number;
  readonly tenantId: string | null;
}

export class CrossTenantWriteError extends Error {
  constructor(
    readonly attempted: string,
    readonly bound: string | null,
  ) {
    super(
      bound === null
        ? `Refused a write for tenant ${attempted}: this database is not provisioned`
        : `Refused a write for tenant ${attempted}: this database holds ${bound}`,
    );
    this.name = "CrossTenantWriteError";
  }
}

export class LocalDb {
  readonly driver: SqlDriver;
  readonly meta: MetaRepository;
  readonly outbox: LocalOutbox;
  readonly provisioning: ProvisioningRepository;
  readonly contacts: ContactRepository;
  readonly items: ItemRepository;
  readonly prices: CustomerPriceRepository;
  readonly documents: DocumentRepository;
  readonly checkpoints: CheckpointRepository;
  readonly conflicts: ConflictRepository;

  private readonly migrations: readonly Migration[];
  private readonly hash: ChecksumHasher | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** Cached so `requireTenant` can be synchronous inside a write transaction. */
  private bound: string | null = null;

  constructor(options: LocalDbOptions) {
    const driver = options.driver;
    this.driver = driver;
    this.migrations = options.migrations ?? MIGRATIONS;
    this.hash = options.hash;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? newUuid;

    const shared = {
      now: this.now,
      newId: this.newId,
      requireTenant: (tenantId: string) => this.requireTenant(tenantId),
    };

    this.meta = new MetaRepository(driver, { now: this.now });
    this.outbox = new LocalOutbox(driver, {
      ...options.outbox,
      now: this.now,
      newId: this.newId,
    });
    this.provisioning = new ProvisioningRepository(driver, { now: this.now });
    this.contacts = new ContactRepository(driver, this.outbox, shared);
    this.items = new ItemRepository(driver, this.outbox, shared);
    this.prices = new CustomerPriceRepository(driver, this.outbox, shared);
    this.documents = new DocumentRepository(driver, this.outbox, shared);
    this.checkpoints = new CheckpointRepository(driver, { now: this.now });
    this.conflicts = new ConflictRepository(driver, {
      now: this.now,
      newId: this.newId,
    });
  }

  /** The tenant this database holds data for, or null before provisioning. */
  get tenantId(): string | null {
    return this.bound;
  }

  /**
   * Validates history, applies pending migrations, and records the version.
   *
   * A driver whose migration list is longer than the compiled one is a build
   * mismatch — a newer app wrote this file and an older one opened it. The
   * error is deliberate: reading forward means writing columns that no longer
   * exist in the code, which corrupts the data on the way back to a server.
   */
  async open(): Promise<LocalDbOpenResult> {
    const report = await migrate({
      driver: this.driver,
      migrations: this.migrations,
      ...(this.hash ? { hash: this.hash } : {}),
      now: this.now,
    });
    await this.meta.set("schema_version", String(report.schemaVersion));
    this.bound = await this.meta.tenantId();
    return {
      report,
      schemaVersion: report.schemaVersion,
      tenantId: this.bound,
    };
  }

  /**
   * Binds the database to a verified session and, on a different user or
   * tenant, refuses to continue with the data already there.
   *
   * A device shared between two tenants is not a supported configuration: the
   * outbox, the cursor and every local row belong to one workspace. Switching
   * identity must go through `wipe()`, so the previous tenant's data cannot be
   * read, edited, or pushed under the new session.
   */
  async bindSession(input: BindSessionInput): Promise<void> {
    if (this.bound !== null && this.bound !== input.tenantId) {
      throw new CrossTenantWriteError(input.tenantId, this.bound);
    }
    const previousUser = await this.meta.get("session_user_id");
    if (previousUser !== null && previousUser !== input.userId) {
      throw new Error(
        `This database holds data for a different user (${previousUser}); ` +
          `sign out and wipe before signing in as ${input.userId}`,
      );
    }
    await this.meta.bindSession(input);
    this.bound = input.tenantId;
  }

  /** Synchronous guard used by every repository write. */
  requireTenant(tenantId: string): void {
    if (this.bound === null || tenantId !== this.bound) {
      throw new CrossTenantWriteError(tenantId, this.bound);
    }
  }

  /** Re-reads the bound tenant after provisioning has written it. */
  async refreshBinding(): Promise<string | null> {
    const tenantId = await this.meta.tenantId();
    if (this.bound !== null && tenantId !== null && this.bound !== tenantId) {
      throw new CrossTenantWriteError(tenantId, this.bound);
    }
    this.bound = tenantId ?? this.bound;
    return this.bound;
  }

  /** The tenant every pull frame and local write is checked against. */
  private expectTenant(): string {
    if (this.bound === null) {
      throw new Error(
        "Cannot exchange changes before the device is provisioned",
      );
    }
    return this.bound;
  }

  /**
   * The entity → applier routing `applyPullPage` dispatches through. Declared
   * as a method rather than a constant because the appliers close over `this`.
   */
  private pullAppliers(): Partial<Record<PullEntity, PullApplier>> {
    return {
      tenant: {
        entity: "tenant",
        applyPull: (frame, tenantId) =>
          this.provisioning.applyTenant(frame, tenantId),
      },
      tenant_branding: {
        entity: "tenant_branding",
        applyPull: (frame, tenantId) =>
          this.provisioning.applyBranding(frame, tenantId),
      },
      document_numbering: {
        entity: "document_numbering",
        applyPull: (frame, tenantId) =>
          this.provisioning.applyNumbering(frame, tenantId),
      },
      tax_category: {
        entity: "tax_category",
        applyPull: (frame, tenantId) =>
          this.provisioning.applyTaxCategory(frame, tenantId),
      },
      tax_rate: {
        entity: "tax_rate",
        applyPull: (frame, tenantId) =>
          this.provisioning.applyTaxRate(frame, tenantId),
      },
      contact: {
        entity: "contact",
        applyPull: (frame, tenantId) =>
          this.contacts.applyPull(frame, tenantId),
      },
      contact_address: {
        entity: "contact_address",
        applyPull: (frame, tenantId) =>
          this.contacts.applyAddressPull(frame, tenantId),
      },
      item: {
        entity: "item",
        applyPull: (frame, tenantId) => this.items.applyPull(frame, tenantId),
      },
      customer_price: {
        entity: "customer_price",
        applyPull: (frame, tenantId) => this.prices.applyPull(frame, tenantId),
      },
      document: {
        entity: "document",
        applyPull: (frame, tenantId) =>
          this.documents.applyPull(frame, tenantId),
      },
      document_line: {
        entity: "document_line",
        applyPull: (frame, tenantId) =>
          this.documents.applyLinePull(frame, tenantId),
      },
      document_payment: {
        entity: "document_payment",
        applyPull: (frame, tenantId) =>
          this.documents.applyPaymentPull(frame, tenantId),
      },
      document_status_event: {
        entity: "document_status_event",
        applyPull: (frame, tenantId) =>
          this.documents.applyStatusEventPull(frame, tenantId),
      },
      document_snapshot: {
        entity: "document_snapshot",
        applyPull: (frame, tenantId) =>
          this.documents.applySnapshotPull(frame, tenantId),
      },
    };
  }

  /**
   * Applies one page of server changes and advances the cursor only if the
   * whole page succeeded. The transport decides when to call this; it never
   * decides what may be overwritten.
   */
  async applyPullPage(page: PullPage): Promise<PullPageResult> {
    const tenantId = this.expectTenant();
    const result = await applyPullPage({
      driver: this.driver,
      tenantId,
      page,
      appliers: this.pullAppliers(),
      conflicts: this.conflicts,
      recordCheckpoint: async (cursor, serverTime) => {
        await this.checkpoints.recordPull({ tenantId, cursor, serverTime });
      },
    });
    // Provisioning frames can be the first thing a device ever receives, so the
    // binding is re-read after a page rather than only at open time.
    await this.refreshBinding();
    return result;
  }

  /**
   * Empties every data table on the device.
   *
   * `client_id` and `schema_version` survive (`clearSession` keeps them too):
   * the installation id is what makes a re-provision recognisable to the
   * server's receipt store rather than a brand-new device. The migration
   * history also survives, because the tables themselves still exist — dropping
   * them would leave the recorded checksums describing a schema the file no
   * longer has.
   */
  async wipe(): Promise<{ deletedRows: number }> {
    let deleted = 0;
    await this.driver.transaction(async () => {
      // The append-only trigger refuses DELETE. It is re-created from the
      // migration text itself rather than a copy in this file, so the guard and
      // the code that suspends it cannot drift apart.
      for (const trigger of APPEND_ONLY_TRIGGERS) {
        await this.driver.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      }
      for (const table of ERASE_TABLES) {
        const result = await this.driver.run(`DELETE FROM ${table}`);
        deleted += result.changes;
      }
      const triggerStatements = this.migrations
        .flatMap((migration) => migration.statements)
        .filter((statement) =>
          APPEND_ONLY_TRIGGERS.some((trigger) =>
            statement.includes(`CREATE TRIGGER ${trigger}`),
          ),
        );
      for (const statement of triggerStatements) {
        await this.driver.exec(statement);
      }
      await this.meta.clearSession();
    });
    this.bound = null;
    return { deletedRows: deleted };
  }

  /** Counts rows per table — used by the UI's "what is on this device" panel. */
  async inventory(tenantId?: string): Promise<Record<string, number>> {
    const target = tenantId ?? this.bound;
    if (target === null) throw new Error("Nothing is provisioned to count");
    const counts: Record<string, number> = {};
    for (const table of ERASE_TABLES) {
      // `contact_address` and `document_snapshot` have no tenant column of their
      // own — neither does the server's copy — so they are counted through their
      // parent. A row that cannot be attributed to this tenant is not counted
      // here, which is the point: it should not exist.
      const sql =
        table === "contact_address"
          ? `SELECT COUNT(*) AS count FROM contact_address
              WHERE contact_id IN (SELECT id FROM contact WHERE tenant_id = ?)`
          : table === "document_snapshot"
            ? `SELECT COUNT(*) AS count FROM document_snapshot
                WHERE document_id IN (SELECT id FROM document WHERE tenant_id = ?)`
            : `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`;
      const row = await this.driver.get<{ count: string | number }>(sql, [
        target,
      ]);
      counts[table] = Math.trunc(Number(row?.count ?? 0));
    }
    return counts;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

export function localDb(options: LocalDbOptions): LocalDb {
  return new LocalDb(options);
}
