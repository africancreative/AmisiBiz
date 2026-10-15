import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import {
  CrossTenantWriteError,
  CURRENT_SCHEMA_VERSION,
  LocalDb,
  MIGRATIONS,
  SchemaChecksumError,
  SqlParamCountError,
  assertParamCount,
  countPlaceholders,
  nodeSqliteDriver,
  positionalToNumbered,
  setSyncState,
  sha256Hex,
  type NodeSqliteDatabaseConstructor,
  type SqlDriver,
} from "@amisibiz/offline";

/**
 * Phase 06 — the offline storage layer, executed against real SQLite.
 *
 * These tests run the same SQL, the same migrator and the same repositories an
 * installed client runs, on `node:sqlite` rather than a mock: the behaviours the
 * directive asks about (restart and recover, retry without duplicating, refuse
 * to overwrite newer server data, keep a rejected draft) are properties of this
 * SQL and this TypeScript, so proving them here is the proof, not a stand-in for
 * it. What this file does **not** establish is that the Capacitor bridge and a
 * real Android build behave identically at runtime — that is the device
 * validation task, and it is reported separately.
 *
 * ## Why only `node:sqlite` is imported through a variable
 *
 * `@types/node` 20 — the version this app pins — declares no `node:sqlite`
 * types (they landed in 22.5). That is exactly why `NodeSqliteDriver` accepts an
 * injected constructor instead of importing the module: the storage layer stays
 * compilable for a WebView bundle, and only this test reaches for the real
 * database. Both this machine and CI run Node 24, where it exists.
 */
async function nodeSqlite(): Promise<NodeSqliteDatabaseConstructor> {
  const specifier = "node:sqlite";
  const sqlite = (await import(specifier)) as unknown as {
    DatabaseSync: NodeSqliteDatabaseConstructor;
  };
  return sqlite.DatabaseSync;
}

const TENANT = "3f2a1b6c-0000-4000-8000-000000000001";
const OTHER_TENANT = "9d8c7b6a-0000-4000-8000-000000000099";
const USER = "11111111-2222-4333-8444-555555555555";

function sessionAt(overrides: Partial<Record<string, string>> = {}) {
  return {
    userId: USER,
    sessionVersion: 1,
    tokenExpiresAt: overrides.tokenExpiresAt ?? "2099-01-01T00:00:00.000Z",
    lastAuthorizedAt: overrides.lastAuthorizedAt ?? "2026-10-15T08:00:00.000Z",
    offlineExpiresAt: overrides.offlineExpiresAt ?? "2099-01-01T00:00:00.000Z",
    tenantId: overrides.tenantId ?? TENANT,
    tenantStatus: overrides.tenantStatus ?? "ACTIVE",
    grantedPermissions: ["document.create", "contact.create"],
  };
}

interface Fixture {
  readonly path: string;
  readonly directory: string;
  /** Every driver opened against this file, so `afterAll` can release them. */
  readonly drivers: SqlDriver[];
}

let DatabaseCtor: NodeSqliteDatabaseConstructor;
const fixtures: Fixture[] = [];

beforeAll(async () => {
  DatabaseCtor = await nodeSqlite();
});

/**
 * Windows will not delete a directory holding a file another handle still has
 * open, so cleanup closes every driver first. A test that leaks a connection
 * still gets a working database; it just costs a temp folder.
 */
afterAll(async () => {
  for (const fixture of fixtures) {
    for (const driver of fixture.drivers) {
      await driver.close().catch(() => undefined);
    }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

/**
 * A file database, not `:memory:`: "restart the app and recover" cannot be
 * demonstrated on a database that dies with the connection.
 */
function newDatabase(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "amisibiz-offline-"));
  const path = join(directory, "client.db");
  const fixture: Fixture = { path, directory, drivers: [] };
  fixtures.push(fixture);
  return fixture;
}

function openDriver(path: string): SqlDriver {
  const driver = nodeSqliteDriver(DatabaseCtor, path, { journalMode: "wal" });
  fixtures.find((fixture) => fixture.path === path)?.drivers.push(driver);
  return driver;
}

async function openProvisioned(path: string, clock?: () => Date) {
  const driver = openDriver(path);
  const db = new LocalDb({ driver, ...(clock ? { now: clock } : {}) });
  await db.open();
  await db.bindSession(sessionAt());
  return { driver, db };
}

describe("offline schema migrations", () => {
  it("applies every migration on a new database and reports the version", async () => {
    const { path } = newDatabase();
    const db = new LocalDb({ driver: openDriver(path) });

    const opened = await db.open();

    expect(opened.report.applied).toHaveLength(MIGRATIONS.length);
    expect(opened.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(opened.tenantId).toBeNull();

    const tables = await db.driver.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = tables.map((row) => row.name);
    for (const expected of [
      "amisibiz_schema_version",
      "local_meta",
      "tenant_profile",
      "contact",
      "contact_address",
      "item",
      "customer_price",
      "document",
      "document_line",
      "document_payment",
      "document_status_event",
      "document_snapshot",
      "outbox_operation",
      "sync_checkpoint",
      "conflict",
    ]) {
      expect(names).toContain(expected);
    }
    await db.close();
  });

  it("is idempotent: reopening an existing database applies nothing", async () => {
    const { path } = newDatabase();
    const first = new LocalDb({ driver: openDriver(path) });
    await first.open();
    await first.bindSession(sessionAt());
    await first.contacts.create({ tenantId: TENANT, firstName: "Wanjiku" });
    await first.close();

    const second = new LocalDb({ driver: openDriver(path) });
    const reopened = await second.open();

    expect(reopened.report.applied).toHaveLength(0);
    expect(reopened.report.alreadyApplied.length).toBeGreaterThan(0);
    // The data survived the close: this is the "restart the app" half of the
    // directive's recovery requirement.
    const contacts = await second.contacts.list(TENANT);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.firstName).toBe("Wanjiku");
    // So does the pending operation, which is the other half.
    expect(await second.outbox.pendingCount(TENANT)).toBe(1);
    expect(reopened.tenantId).toBe(TENANT);
    await second.close();
  });

  it("refuses to run against a database whose recorded checksum differs", async () => {
    const { path } = newDatabase();

    const pristine = new LocalDb({ driver: openDriver(path), hash: sha256Hex });
    await pristine.open();
    await pristine.close();

    // A different hasher is how a changed migration looks to the guard: the
    // recorded checksum no longer matches the statement list in the build.
    const tampered = new LocalDb({
      driver: openDriver(path),
      hash: async (input: string) =>
        createHash("sha256")
          .update(input + " ")
          .digest("hex"),
    });

    await expect(tampered.open()).rejects.toBeInstanceOf(SchemaChecksumError);

    // Refusing must not have written anything.
    const versions = await (
      await openDriver(path)
    ).all<{ version: string | number }>(
      `SELECT version FROM amisibiz_schema_version`,
    );
    expect(versions.length).toBeGreaterThan(0);
  });

  it("rolls back a failed migration instead of leaving half a schema", async () => {
    const { path } = newDatabase();

    const broken = {
      version: MIGRATIONS.length + 1,
      name: "half_built",
      statements: [
        `CREATE TABLE half_built (id TEXT PRIMARY KEY)`,
        `CREATE TABLE half_built (id TEXT PRIMARY KEY)`,
      ],
    };

    const db = new LocalDb({
      driver: openDriver(path),
      migrations: [...MIGRATIONS, broken],
      hash: sha256Hex,
    });

    await expect(db.open()).rejects.toThrow();

    const tables = await db.driver.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_built'`,
    );
    expect(tables).toHaveLength(0);

    const history = await db.driver.all<{ version: string | number }>(
      `SELECT version FROM amisibiz_schema_version ORDER BY version`,
    );
    expect(history.map((row) => Number(row.version))).toEqual(
      MIGRATIONS.map((migration) => migration.version),
    );
    await db.close();
  });

  it("verifies the digest against node:crypto rather than trusting itself", async () => {
    const samples = [
      "",
      "a",
      "amisibiz",
      "€\u{1F600}",
      JSON.stringify([1, 2, 3]),
    ];

    for (const sample of samples) {
      const expected = createHash("sha256")
        .update(sample, "utf8")
        .digest("hex");
      await expect(sha256Hex(sample)).resolves.toBe(expected);
    }
  });
});

describe("local writes and the outbox", () => {
  it("writes a contact and its operation in one transaction", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);

    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Amina",
      lastName: "Wanjiru",
      phone: "+254700000000",
      addresses: [{ type: "PHYSICAL", line1: "Rongai", isDefault: true }],
    });

    expect(contact.syncState).toBe("local");
    expect(await db.outbox.pendingCount(TENANT)).toBe(1);
    const queued = await db.outbox.list(TENANT);
    expect(queued[0]?.entity).toBe("contact");
    expect(queued[0]?.entityId).toBe(contact.id);
    // The payload is what the server reads: never a tenant id, never a number.
    expect(queued[0]?.payload).not.toHaveProperty("tenantId");
    expect(await db.contacts.addresses(contact.id)).toHaveLength(1);

    const counts = await db.contacts.stateCounts(TENANT);
    expect(counts.local).toBe(1);
    await db.close();
  });

  it("refuses a write for a tenant this database does not hold", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);

    await expect(
      db.contacts.create({ tenantId: OTHER_TENANT, firstName: "Mwangi" }),
    ).rejects.toBeInstanceOf(CrossTenantWriteError);

    expect(await db.contacts.list(OTHER_TENANT as never)).toHaveLength(0);
    expect(await db.outbox.pendingCount()).toBe(0);
    await db.close();
  });

  it("recovers interrupted operations after a restart, with the same ids", async () => {
    const { path } = newDatabase();
    const first = await openProvisioned(path);
    const contact = await first.db.contacts.create({
      tenantId: TENANT,
      firstName: "Otieno",
    });
    const claimed = await first.db.outbox.claimPending("generation-1");
    expect(claimed).toHaveLength(1);
    // The device dies here: mid-flight, before any response was written.
    await first.db.close();

    const reopened = await openProvisioned(path);
    const stillInFlight = await reopened.db.outbox.claimPending("generation-2");
    expect(stillInFlight).toHaveLength(0);

    const recovered =
      await reopened.db.outbox.recoverInterrupted("generation-2");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe(claimed[0]?.id);
    expect(recovered[0]?.status).toBe("pending");
    expect(recovered[0]?.entityId).toBe(contact.id);
    // Recovering must not mint a second operation for the same contact.
    expect(await reopened.db.outbox.pendingCount(TENANT)).toBe(1);
    await reopened.db.close();
  });

  it("claims an operation once, so two loops cannot send it twice", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    await db.contacts.create({ tenantId: TENANT, firstName: "Chelule" });

    const firstClaim = await db.outbox.claimPending("generation-a");
    const secondClaim = await db.outbox.claimPending("generation-b");

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(0);
    await db.close();
  });

  it("backs off a transient failure and stops at the attempt ceiling", async () => {
    let nowMs = Date.parse("2026-10-15T08:00:00.000Z");
    const { path } = newDatabase();
    const driver = openDriver(path);
    const db = new LocalDb({
      driver,
      now: () => new Date(nowMs),
      outbox: {
        maxAttempts: 3,
        backoffBaseMs: 1000,
        maxBackoffMs: 5000,
        random: () => 0.5,
      },
    });
    await db.open();
    await db.bindSession(sessionAt());

    await db.contacts.create({ tenantId: TENANT, firstName: "Kiptoo" });
    const [operation] = await db.outbox.claimPending("g1");
    expect(operation).toBeDefined();

    const first = await db.outbox.markFailed(
      operation!.id,
      "network unreachable",
    );
    expect(first?.status).toBe("pending");
    expect(first?.attempts).toBe(1);
    expect(first?.nextAttemptAt).not.toBeNull();

    // Not yet claimable: the backoff is real, not a spin.
    expect(await db.outbox.claimPending("g2")).toHaveLength(0);
    nowMs += 2000;
    const retry = await db.outbox.claimPending("g3");
    expect(retry).toHaveLength(1);

    await db.outbox.markFailed(retry[0]!.id, "network unreachable");
    nowMs += 6000;
    const last = await db.outbox.claimPending("g4");
    await db.outbox.markFailed(last[0]!.id, "network unreachable");

    const exhausted = await db.outbox.findById(last[0]!.id);
    expect(exhausted?.status).toBe("failed");
    expect(exhausted?.attempts).toBe(3);
    // Giving up on the queue must not lose the record: the contact is still
    // here, with its data. Its state stays `local` — this layer stamps a row
    // only when the row's own write is what changed (create → `local`, edit →
    // `pending`). Turning a *queue outcome* into a row state is the sync
    // engine's job, through `setSyncState`, which the next test exercises.
    const contact = await db.contacts.get(operation!.entityId, TENANT);
    expect(contact?.syncState).toBe("local");
    expect(contact?.firstName).toBe("Kiptoo");
    await db.close();
  });

  it("keeps a rejected draft and records why, instead of discarding it", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Njeri",
    });
    const [operation] = await db.outbox.claimPending("g1");

    await db.outbox.markRejected(operation!.id, "you may not create contacts");

    // The verdict and its reason stay on the device: nothing here deletes work.
    const kept = await db.outbox.findById(operation!.id);
    expect(kept?.status).toBe("failed");
    expect(kept?.rejectedReason).toBe("you may not create contacts");

    // The row half of the same outcome, through the helper the sync engine
    // calls: the draft keeps its data, gets labelled, and carries the reason.
    await setSyncState(db.driver, "contact", contact.id, "rejected", {
      lastError: "you may not create contacts",
    });

    const stored = await db.contacts.get(contact.id, TENANT);
    expect(stored).not.toBeNull();
    expect(stored?.syncState).toBe("rejected");
    expect(stored?.firstName).toBe("Njeri");
    expect(stored?.lastError).toContain("you may not create contacts");

    // Recovery from a rejection is an ordinary edit: it re-queues the work and
    // clears the stale reason.
    const edited = await db.contacts.update(TENANT, contact.id, {
      firstName: "Njeri W.",
    });
    expect(edited.syncState).toBe("pending");
    expect(edited.lastError).toBeNull();
    expect(await db.outbox.pendingCount(TENANT)).toBe(1);
    await db.close();
  });

  it("applies a server receipt exactly once, so a retry cannot duplicate", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    await db.contacts.create({ tenantId: TENANT, firstName: "Adan" });
    const [operation] = await db.outbox.claimPending("g1");

    await db.outbox.markApplied(operation!.id);
    const afterFirst = await db.outbox.findById(operation!.id);
    expect(afterFirst?.status).toBe("applied");

    // The server's receipt arrived twice (a retry after a dropped response).
    await db.outbox.markApplied(operation!.id);
    const afterSecond = await db.outbox.findById(operation!.id);
    expect(afterSecond?.status).toBe("applied");
    expect(await db.outbox.pendingCount(TENANT)).toBe(0);
    expect(await db.contacts.count(TENANT)).toBe(1);
    await db.close();
  });

  it("refuses a second operation with the same client id", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const id = "22222222-3333-4444-8555-666666666666";

    await db.driver.transaction(async () => {
      await db.outbox.enqueue({
        id,
        tenantId: TENANT,
        entity: "contact",
        entityId: "33333333-4444-4444-8555-666666666666",
        type: "contact.create",
        payload: { firstName: "Once" },
      });
    });

    await expect(
      db.driver.transaction(async () => {
        await db.outbox.enqueue({
          id,
          tenantId: TENANT,
          entity: "contact",
          entityId: "44444444-5555-4444-8555-666666666666",
          type: "contact.create",
          payload: { firstName: "Twice" },
        });
      }),
    ).rejects.toThrow();

    expect(await db.outbox.findById(id)).not.toBeNull();
    await expect(db.outbox.pendingCount(TENANT)).resolves.toBe(1);
    await db.close();
  });
});

describe("offline documents", () => {
  it("creates a draft with no number and no issue date", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);

    const draft = await db.documents.createDraft({
      tenantId: TENANT,
      type: "QUOTATION",
      currency: "KES",
      lines: [
        { description: "Site survey", quantity: "2", unitPrice: "1500.00" },
        {
          description: "Report",
          quantity: "1",
          unitPrice: "8000.00",
          taxRate: "0.16",
          taxName: "VAT 16%",
        },
      ],
    });

    expect(draft.number).toBeNull();
    expect(draft.issuedAt).toBeNull();
    expect(draft.status).toBe("DRAFT");
    expect(draft.syncState).toBe("local");
    // `LOCAL-…` is a label derived from the id, never a document number.
    expect(draft.reference).toMatch(/^LOCAL-[0-9A-HJ-NP-Za-km-z]{8}$|LOCAL-/);
    expect(db.documents.reference(draft.id)).toMatch(/^LOCAL-/);

    // Totals come from the shared engine: 2 × 1500 + 8000 + 16 % of 8000.
    expect(draft.total).toBe("12280.0000");
    expect(draft.taxTotal).toBe("1280.0000");
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[1]?.lineTax).toBe("1280.0000");

    const queued = await db.outbox.list(TENANT);
    expect(
      queued.some((operation) => operation.type === "document.draft.create"),
    ).toBe(true);
    expect(queued[0]?.payload).not.toHaveProperty("number");
    await db.close();
  });

  it("refuses to store a number or an issue date on a row that never reached the server", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const draft = await db.documents.createDraft({
      tenantId: TENANT,
      type: "INVOICE",
      lines: [
        { description: "Consulting", quantity: "1", unitPrice: "1000.00" },
      ],
    });

    // The two CHECK constraints in `schema.ts`, exercised through the driver
    // rather than through a repository that would never issue the write.
    await expect(
      db.driver.run(`UPDATE document SET number = 'INV-0001' WHERE id = ?`, [
        draft.id,
      ]),
    ).rejects.toThrow(/CHECK|constraint/i);
    await expect(
      db.driver.run(`UPDATE document SET issued_at = ? WHERE id = ?`, [
        "2026-10-15T08:00:00.000Z",
        draft.id,
      ]),
    ).rejects.toThrow(/CHECK|constraint/i);

    const unchanged = await db.documents.get(draft.id, TENANT);
    expect(unchanged?.number).toBeNull();
    expect(unchanged?.issuedAt).toBeNull();
    await db.close();
  });

  it("asks the server to issue it and invents nothing while waiting", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const draft = await db.documents.createDraft({
      tenantId: TENANT,
      type: "QUOTATION",
      lines: [
        { description: "Pump service", quantity: "1", unitPrice: "4500.00" },
      ],
    });

    const operationId = await db.documents.requestIssuance(TENANT, draft.id);

    const operation = await db.outbox.findById(operationId);
    expect(operation?.type).toBe("document.issue");
    expect(operation?.entityId).toBe(draft.id);
    const after = await db.documents.get(draft.id, TENANT);
    expect(after?.number).toBeNull();
    expect(after?.status).toBe("DRAFT");
    expect(after?.issuedAt).toBeNull();
    await db.close();
  });

  it("refuses to edit a document the server has issued", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    await db.applyPullPage({
      nextCursor: "cursor-1",
      serverTime: "2026-10-15T09:00:00.000Z",
      changes: [
        {
          entity: "document",
          id: "55555555-6666-4444-8555-777777777777",
          revision: 12,
          deleted: false,
          updatedAt: "2026-10-15T09:00:00.000Z",
          data: {
            tenantId: TENANT,
            type: "INVOICE",
            status: "ISSUED",
            number: "INV-2026-0042",
            currency: "KES",
            issueDate: "2026-10-15T09:00:00.000Z",
            subtotal: "1000.0000",
            taxableBase: "1000.0000",
            taxTotal: "160.0000",
            total: "1160.0000",
            issuedAt: "2026-10-15T09:00:00.000Z",
            roundingPolicy: "half-up-per-line-v1",
          },
        },
      ],
    });

    const issued = await db.documents.get(
      "55555555-6666-4444-8555-777777777777",
      TENANT,
    );
    expect(issued?.number).toBe("INV-2026-0042");
    expect(issued?.syncState).toBe("synced");

    await expect(
      db.documents.updateDraft(TENANT, issued!.id, {
        lines: [{ description: "Tampered", quantity: "1", unitPrice: "1.00" }],
      }),
    ).rejects.toThrow(/immutable|not editable|DRAFT/i);

    await expect(
      db.documents.requestIssuance(TENANT, issued!.id),
    ).rejects.toThrow();
    await db.close();
  });

  it("keeps a status history nobody can rewrite locally", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const documentId = "55555555-6666-4444-8555-777777777778";
    await db.applyPullPage({
      nextCursor: "cursor-1",
      changes: [
        {
          entity: "document",
          id: documentId,
          revision: 3,
          deleted: false,
          updatedAt: "2026-10-15T09:00:00.000Z",
          data: {
            tenantId: TENANT,
            type: "INVOICE",
            status: "ISSUED",
            number: "INV-2026-0099",
            currency: "KES",
            issueDate: "2026-10-15T09:00:00.000Z",
            total: "1160.0000",
          },
        },
        {
          entity: "document_status_event",
          id: "66666666-7777-4444-8555-888888888888",
          revision: 3,
          deleted: false,
          updatedAt: "2026-10-15T09:00:00.000Z",
          data: {
            tenantId: TENANT,
            documentId,
            fromStatus: "DRAFT",
            toStatus: "ISSUED",
            actorId: USER,
            createdAt: "2026-10-15T09:00:00.000Z",
          },
        },
      ],
    });

    const eventId = "66666666-7777-4444-8555-888888888888";
    await expect(
      db.driver.run(
        `UPDATE document_status_event SET to_status = 'VOIDED' WHERE id = ?`,
        [eventId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.driver.run(`DELETE FROM document_status_event WHERE id = ?`, [
        eventId,
      ]),
    ).rejects.toThrow(/append-only/i);
    await db.close();
  });
});

describe("pulling server changes", () => {
  it("advances the cursor only when the whole page succeeded", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);

    await db.applyPullPage({
      nextCursor: "cursor-1",
      serverTime: "2026-10-15T09:00:00.000Z",
      changes: [
        {
          entity: "contact",
          id: "77777777-8888-4444-8555-999999999999",
          revision: 4,
          deleted: false,
          updatedAt: "2026-10-15T09:00:00.000Z",
          data: {
            tenantId: TENANT,
            type: "BUSINESS",
            companyName: "Rift Valley Produce",
            status: "ACTIVE",
          },
        },
      ],
    });

    const checkpoint = await db.checkpoints.get(TENANT);
    expect(checkpoint?.cursor).toBe("cursor-1");

    await expect(
      db.applyPullPage({
        nextCursor: "cursor-2",
        changes: [
          {
            entity: "contact",
            id: "88888888-9999-4444-8555-000000000001",
            revision: 5,
            deleted: false,
            updatedAt: "2026-10-15T09:00:00.000Z",
            data: { tenantId: TENANT, type: "BUSINESS", companyName: "Ok" },
          },
          // Configuration the device only ever reads, in dependency order: a
          // rate names the category it belongs to.
          {
            entity: "tax_category",
            id: "99999999-0000-4444-8555-111111111110",
            revision: 1,
            deleted: false,
            updatedAt: "2026-10-15T09:00:00.000Z",
            data: { tenantId: TENANT, name: "VAT", isDefault: true },
          },
          {
            entity: "tax_rate",
            id: "99999999-0000-4444-8555-111111111111",
            revision: 1,
            deleted: false,
            updatedAt: "2026-10-15T09:00:00.000Z",
            data: {
              tenantId: TENANT,
              categoryId: "99999999-0000-4444-8555-111111111110",
              name: "VAT 16%",
              rate: "0.16",
              effectiveFrom: "2026-01-01T00:00:00.000Z",
              isActive: true,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: 3 });

    // A frame for an entity the client cannot store aborts the page.
    await expect(
      db.applyPullPage({
        nextCursor: "cursor-3",
        changes: [
          {
            entity: "user_session",
            id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            revision: 1,
            deleted: false,
            updatedAt: "2026-10-15T09:00:00.000Z",
            data: { tenantId: TENANT },
          },
        ],
      }),
    ).rejects.toThrow(/not an entity this client knows/);

    const afterFailure = await db.checkpoints.get(TENANT);
    expect(afterFailure?.cursor).toBe("cursor-2");
    expect(
      await db.contacts.get("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", TENANT),
    ).toBeNull();
    await db.close();
  });

  it("refuses a frame that names another tenant", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);

    await expect(
      db.applyPullPage({
        nextCursor: "cursor-1",
        changes: [
          {
            entity: "contact",
            id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
            revision: 1,
            deleted: false,
            updatedAt: "2026-10-15T09:00:00.000Z",
            data: { tenantId: OTHER_TENANT, companyName: "Not yours" },
          },
        ],
      }),
    ).rejects.toThrow(/not the provisioned tenant/);

    expect(await db.contacts.count(TENANT)).toBe(0);
    // No checkpoint row at all: the first page never committed, so the device
    // does not even know an exchange was attempted.
    await expect(db.checkpoints.get(TENANT)).resolves.toBeNull();
    await db.close();
  });

  it("does not overwrite an unsynchronized local change; it records a conflict", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Grace",
      phone: "+254711",
    });

    const result = await db.applyPullPage({
      nextCursor: "cursor-1",
      changes: [
        {
          entity: "contact",
          id: contact.id,
          revision: 9,
          deleted: false,
          updatedAt: "2026-10-15T10:00:00.000Z",
          data: {
            tenantId: TENANT,
            firstName: "Grace (server)",
            phone: "+254700",
          },
        },
      ],
    });

    expect(result.conflicts).toBe(1);
    const preserved = await db.contacts.get(contact.id, TENANT);
    expect(preserved?.firstName).toBe("Grace");
    expect(preserved?.phone).toBe("+254711");
    expect(preserved?.syncState).toBe("local");

    const open = await db.conflicts.listOpen(TENANT);
    expect(open).toHaveLength(1);
    expect(open[0]?.operationId).toBe(`pull:contact:${contact.id}`);
    expect(open[0]?.baseRevision).toBeNull();
    expect(open[0]?.serverRevision).toBe(9);
    expect((open[0]?.localPayload as { first_name?: string }).first_name).toBe(
      "Grace",
    );

    // Keeping the server copy is a decision, then an action, then a closure.
    await db.contacts.applyPull(
      {
        entity: "contact",
        id: contact.id,
        revision: 9,
        deleted: false,
        updatedAt: "2026-10-15T10:00:00.000Z",
        data: {
          tenantId: TENANT,
          firstName: "Grace (server)",
          phone: "+254700",
        },
      },
      TENANT,
    );
    const resolved = await db.conflicts.resolve(open[0]!.id, "kept_server");
    expect(resolved?.resolution).toBe("kept_server");
    expect(await db.conflicts.countOpen(TENANT)).toBe(0);

    const adopted = await db.contacts.get(contact.id, TENANT);
    expect(adopted?.firstName).toBe("Grace (server)");
    expect(adopted?.syncState).toBe("synced");
    await db.close();
  });

  it("re-applies a preserved local change as a new operation", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Sammy",
    });
    const before = await db.outbox.pendingCount(TENANT);

    await db.applyPullPage({
      nextCursor: "cursor-1",
      changes: [
        {
          entity: "contact",
          id: contact.id,
          revision: 7,
          deleted: false,
          updatedAt: "2026-10-15T10:00:00.000Z",
          data: { tenantId: TENANT, firstName: "Sammy (server)" },
        },
      ],
    });

    const operationId = await db.contacts.reapplyAfterConflict(
      TENANT,
      contact.id,
    );
    const requeued = await db.outbox.findById(operationId);
    expect(requeued?.type).toBe("contact.update");
    expect(requeued?.baseRevision).toBe(7);
    expect(await db.outbox.pendingCount(TENANT)).toBe(before + 1);

    const row = await db.contacts.get(contact.id, TENANT);
    expect(row?.syncState).toBe("pending");
    expect(row?.firstName).toBe("Sammy");
    await db.close();
  });

  it("treats a repeated revision as already current", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const frame = {
      entity: "contact",
      id: "cccccccc-dddd-4eee-8fff-111111111111",
      revision: 2,
      deleted: false,
      updatedAt: "2026-10-15T10:00:00.000Z",
      data: { tenantId: TENANT, companyName: "Overlapping page" },
    };

    const first = await db.applyPullPage({
      nextCursor: "c1",
      changes: [frame],
    });
    const second = await db.applyPullPage({
      nextCursor: "c2",
      changes: [frame],
    });

    expect(first.applied).toBe(1);
    expect(second.alreadyCurrent).toBe(1);
    expect(second.applied).toBe(0);
    await db.close();
  });

  it("marks a tombstone without deleting the local row", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    await db.applyPullPage({
      nextCursor: "c1",
      changes: [
        {
          entity: "item",
          id: "dddddddd-eeee-4fff-8000-222222222222",
          revision: 1,
          deleted: false,
          updatedAt: "2026-10-15T10:00:00.000Z",
          data: {
            tenantId: TENANT,
            type: "SERVICE",
            name: "Delivery",
            unitPrice: "300.00",
          },
        },
      ],
    });

    await db.applyPullPage({
      nextCursor: "c2",
      changes: [
        {
          entity: "item",
          id: "dddddddd-eeee-4fff-8000-222222222222",
          revision: 2,
          deleted: true,
          updatedAt: "2026-10-15T11:00:00.000Z",
          data: { tenantId: TENANT },
        },
      ],
    });

    const row = await db.driver.get<{ deleted: number | string }>(
      `SELECT deleted FROM item WHERE id = ?`,
      ["dddddddd-eeee-4fff-8000-222222222222"],
    );
    expect(Number(row?.deleted)).toBe(1);
    expect(await db.items.list(TENANT)).toHaveLength(0);
    await db.close();
  });
});

describe("provisioning and bounded offline authorization", () => {
  it("stores the tenant profile and branding it is given", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);

    await db.applyPullPage({
      nextCursor: "c1",
      changes: [
        {
          entity: "tenant",
          id: TENANT,
          revision: 1,
          deleted: false,
          updatedAt: "2026-10-15T08:00:00.000Z",
          data: {
            tenantId: TENANT,
            name: "Rift Valley Produce Ltd",
            slug: "rift-valley",
            status: "ACTIVE",
            country: "KE",
            currency: "KES",
            timezone: "Africa/Nairobi",
            locale: "en-KE",
          },
        },
        {
          entity: "tenant_branding",
          id: "eeeeeeee-ffff-4aaa-8bbb-333333333333",
          revision: 1,
          deleted: false,
          updatedAt: "2026-10-15T08:00:00.000Z",
          data: {
            tenantId: TENANT,
            companyName: "Rift Valley Produce",
            accentColor: "#0f766e",
          },
        },
      ],
    });

    const profile = await db.provisioning.profile(TENANT);
    expect(profile?.name).toBe("Rift Valley Produce Ltd");
    expect(profile?.currency).toBe("KES");
    const branding = await db.provisioning.branding(TENANT);
    expect(branding?.accentColor).toBe("#0f766e");
    await db.close();
  });

  it("refuses a tenant frame whose id is another tenant", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);

    await expect(
      db.applyPullPage({
        nextCursor: "c1",
        changes: [
          {
            entity: "tenant",
            id: OTHER_TENANT,
            revision: 1,
            deleted: false,
            updatedAt: "2026-10-15T08:00:00.000Z",
            data: {
              name: "Somebody else",
              slug: "somebody-else",
              status: "ACTIVE",
              currency: "KES",
              timezone: "Africa/Nairobi",
              locale: "en-KE",
            },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await db.provisioning.profile(TENANT)).toBeNull();
    await db.close();
  });

  it("stops offline creation once the authorization window elapses", async () => {
    let nowMs = Date.parse("2026-10-15T08:00:00.000Z");
    const { path } = newDatabase();
    const driver = openDriver(path);
    const db = new LocalDb({ driver, now: () => new Date(nowMs) });
    await db.open();
    await db.bindSession(
      sessionAt({ offlineExpiresAt: "2026-10-18T08:00:00.000Z" }),
    );

    expect(await db.meta.offlineCreation()).toMatchObject({
      allowed: true,
      reason: null,
    });

    nowMs = Date.parse("2026-10-18T08:00:01.000Z");
    expect(await db.meta.offlineCreation()).toMatchObject({
      allowed: false,
      reason: "offline_window_elapsed",
    });
    // Reads still work: the window limits creating, not looking.
    expect(await db.contacts.list(TENANT)).toHaveLength(0);

    nowMs = Date.parse("2026-10-15T09:00:00.000Z");
    await db.meta.set("tenant_status", "SUSPENDED");
    await db.meta.set("offline_expires_at", "2099-01-01T00:00:00.000Z");
    expect(await db.meta.offlineCreation()).toMatchObject({
      allowed: false,
      reason: "tenant_suspended",
    });
    await db.close();
  });

  it("never allows offline creation without a cached window", async () => {
    const { path } = newDatabase();
    const db = new LocalDb({ driver: openDriver(path) });
    await db.open();
    await db.bindSession(sessionAt({ offlineExpiresAt: "" }));

    const state = await db.meta.offlineCreation();
    expect(state.allowed).toBe(false);
    expect(state.reason).toBe("offline_window_elapsed");
    await db.close();
  });
});

describe("wiping and the parameter guard", () => {
  it("empties the device, including the append-only history", async () => {
    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Delete me",
    });
    await db.documents.createDraft({
      tenantId: TENANT,
      type: "QUOTATION",
      lines: [{ description: "Thing", quantity: "1", unitPrice: "10.00" }],
    });
    await db.applyPullPage({
      nextCursor: "c1",
      changes: [
        {
          entity: "document",
          id: "ffffffff-0000-4111-8222-444444444444",
          revision: 1,
          deleted: false,
          updatedAt: "2026-10-15T10:00:00.000Z",
          data: {
            tenantId: TENANT,
            type: "INVOICE",
            status: "ISSUED",
            number: "INV-1",
            currency: "KES",
            issueDate: "2026-10-15T10:00:00.000Z",
            total: "10.0000",
          },
        },
        {
          entity: "document_status_event",
          id: "11111111-2222-4333-8444-555555666666",
          revision: 1,
          deleted: false,
          updatedAt: "2026-10-15T10:00:00.000Z",
          data: {
            tenantId: TENANT,
            documentId: "ffffffff-0000-4111-8222-444444444444",
            toStatus: "ISSUED",
            createdAt: "2026-10-15T10:00:00.000Z",
          },
        },
      ],
    });

    expect(contact.id).toBeTruthy();
    const clientId = await db.meta.clientId();

    // What the device holds before the wipe, read through the same method the
    // offline UI's storage screen uses.
    const before = await db.inventory(TENANT);
    expect(before.contact).toBe(1);
    expect(before.contact_address).toBe(0);
    expect(before.document).toBe(2);
    expect(before.document_line).toBe(1);
    expect(before.document_status_event).toBe(1);
    expect(before.outbox_operation).toBe(2);

    const wiped = await db.wipe();
    expect(wiped.deletedRows).toBeGreaterThan(0);

    // Every mirrored and queued table is empty — including the append-only
    // history, which `wipe()` suspends and re-creates rather than works around.
    const after = await db.inventory(TENANT);
    expect(Object.keys(after)).toContain("document_status_event");
    expect(Object.values(after).every((rows) => rows === 0)).toBe(true);

    expect(await db.meta.clientId()).toBe(clientId);
    expect(db.tenantId).toBeNull();

    // The schema is still intact, so a later provisioning works.
    const again = new LocalDb({ driver: db.driver });
    await expect(again.open()).resolves.toMatchObject({
      report: { applied: [] },
    });
    await db.close();
  });

  it("catches a placeholder/parameter mismatch instead of writing the wrong column", async () => {
    expect(countPlaceholders(`INSERT INTO t (a, b) VALUES (?, ?)`)).toBe(2);
    // A `?` inside a string literal is text, not a binding site.
    expect(countPlaceholders(`SELECT '?' , ? FROM t WHERE x = ?`)).toBe(2);

    expect(() => assertParamCount(`SELECT ? , ?`, ["one"])).toThrow(
      SqlParamCountError,
    );

    const { path } = newDatabase();
    const { db } = await openProvisioned(path);
    await expect(
      db.driver.run(`INSERT INTO contact (id, tenant_id) VALUES (?, ?)`, [
        "a",
        "b",
        "c",
      ]),
    ).rejects.toBeInstanceOf(SqlParamCountError);
    await db.close();
  });

  it("renumbers placeholders for the Tauri dialect without losing one", async () => {
    expect(positionalToNumbered(`SELECT ? , ?, ?`)).toBe(`SELECT $1 , $2, $3`);
    expect(positionalToNumbered(`SELECT '?' , ?`)).toBe(`SELECT '?' , $1`);
    expect(positionalToNumbered(`INSERT INTO t VALUES (?, 'a?b', ?)`)).toBe(
      `INSERT INTO t VALUES ($1, 'a?b', $2)`,
    );
  });
});
