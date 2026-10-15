import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFLICT_RESOLUTIONS,
  CURRENT_SCHEMA_VERSION,
  LocalDb,
  MIGRATIONS,
  SyncClient,
  nodeSqliteDriver,
  type NodeSqliteDatabaseConstructor,
  type SqlDriver,
  type SyncClientOptions,
} from "@amisibiz/offline";
import {
  CONFLICT_RESOLUTIONS as CONTRACT_CONFLICT_RESOLUTIONS,
  SyncProtocolError,
  SyncUnauthorizedError,
  type QueuedOperation,
  type SyncChangeFrame,
  type SyncPullPage,
  type SyncPushOutcome,
  type SyncPushRequest,
  type SyncPushResult,
  type SyncTransport,
} from "@amisibiz/sync";

/**
 * Phase 06 — the synchronization client, run against real SQLite.
 *
 * `phase06-offline-storage.test.ts` proved the storage half: the queue, the
 * rows, the migration guard, the conflict table. This file runs the *loop* on
 * top of it and asks the questions the directive names: does a push the server
 * answered become `synced` and nothing else; does a retry after a lost response
 * create a second record; does a refusal keep the draft; does an expired session
 * stop the run without burning the queue; does the cursor resume where it
 * stopped; does a document get a number only when the server gives it one.
 *
 * ## What the other side of these tests is, and what it is not
 *
 * The server here is a **contract stub**: `ScriptedServer` implements
 * `SyncTransport` and imitates the semantics the real endpoints must have — an
 * operation id is an idempotency key, a row has a server-allocated revision, a
 * policy refusal is permanent, a pull page hands out one cursor. It is *not* the
 * Phase 06 server, which does not exist yet (task #61), and nothing here
 * establishes that `/api/sync/push` and `/api/sync/pull` behave this way. What
 * these tests establish is the half the client owns: that it reacts correctly to
 * every answer the contract allows. When the endpoints land, the same scenarios
 * are re-run against them; until then, any claim about server behaviour would be
 * a claim about a stub.
 */

async function nodeSqlite(): Promise<NodeSqliteDatabaseConstructor> {
  const specifier = "node:sqlite";
  const sqlite = (await import(specifier)) as unknown as {
    DatabaseSync: NodeSqliteDatabaseConstructor;
  };
  return sqlite.DatabaseSync;
}

const TENANT = "3f2a1b6c-0000-4000-8000-000000000001";
const USER = "11111111-2222-4333-8444-555555555555";

/** Everything is pinned to one instant so the window arithmetic is assertable. */
const CLOCK = () => new Date("2026-10-15T12:00:00.000Z");
const SERVER_TIME = "2026-10-15T12:30:00.000Z";
/** The default 72-hour offline window, measured from the server's own clock. */
const RENEWED_WINDOW = "2026-10-18T12:30:00.000Z";

function sessionAt(overrides: Partial<Record<string, string>> = {}) {
  return {
    userId: USER,
    sessionVersion: 1,
    tokenExpiresAt: overrides.tokenExpiresAt ?? "2099-01-01T00:00:00.000Z",
    lastAuthorizedAt: overrides.lastAuthorizedAt ?? "2026-10-15T08:00:00.000Z",
    offlineExpiresAt: overrides.offlineExpiresAt ?? "2026-10-15T13:00:00.000Z",
    tenantId: overrides.tenantId ?? TENANT,
    tenantStatus: overrides.tenantStatus ?? "ACTIVE",
    grantedPermissions: ["document.create", "contact.create"],
  };
}

interface Fixture {
  readonly path: string;
  readonly directory: string;
  readonly drivers: SqlDriver[];
}

let DatabaseCtor: NodeSqliteDatabaseConstructor;
const fixtures: Fixture[] = [];

beforeAll(async () => {
  DatabaseCtor = await nodeSqlite();
});

/** Windows refuses to delete a directory an open SQLite handle still holds. */
afterAll(async () => {
  for (const fixture of fixtures) {
    for (const driver of fixture.drivers) {
      await driver.close().catch(() => undefined);
    }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

function newDatabase(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "amisibiz-sync-"));
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

/**
 * Opens the file an installed client opens: migrations applied, session bound,
 * tenant readable. `bindSession` runs again on a reopen because a real app
 * re-authenticates on launch, and it is idempotent for the same user and tenant.
 */
async function openDatabase(
  path: string,
  options: { now?: () => Date; session?: Partial<Record<string, string>> } = {},
): Promise<LocalDb> {
  const db = new LocalDb({
    driver: openDriver(path),
    // The device clock is pinned too, not just the client's. `offlineCreation()`
    // compares the stored window against *this* clock, so with the real wall
    // clock a test that seeds a window ending at 13:00Z would pass in the morning
    // and fail in the afternoon. A test that wants a running clock passes `now`.
    now: options.now ?? CLOCK,
  });
  await db.open();
  await db.bindSession(sessionAt(options.session ?? {}));
  return db;
}

async function provisioned(
  options: {
    now?: () => Date;
    session?: Partial<Record<string, string>>;
  } = {},
): Promise<{ db: LocalDb; path: string }> {
  const fixture = newDatabase();
  const db = await openDatabase(fixture.path, options);
  return { db, path: fixture.path };
}

function syncClient(
  db: LocalDb,
  server: SyncTransport,
  options: SyncClientOptions = {},
): SyncClient {
  return new SyncClient(db, server, { now: CLOCK, ...options });
}

/** The one queued operation a fresh local write produced, or a loud failure. */
async function onlyOperation(
  db: LocalDb,
): Promise<Awaited<ReturnType<LocalDb["outbox"]["list"]>>[number]> {
  const [operation] = await db.outbox.list(TENANT);
  if (!operation) throw new Error("Expected exactly one queued operation");
  return operation;
}

// ---------------------------------------------------------------------------
// The stub
// ---------------------------------------------------------------------------

interface ServerScript {
  /**
   * What the server does with an operation it has never seen. Default: apply it.
   * Returning `undefined` models a server that answers for some operations and
   * not others — the case that must never be read as success.
   */
  readonly decide?: (operation: QueuedOperation) => SyncPushOutcome | undefined;
  /** Pages served on pull, in call order; once they run out the client is caught up. */
  readonly pages?: readonly SyncPullPage[];
  /** Thrown instead of answering, on the 1st, 2nd, … push call. */
  readonly pushErrors?: readonly unknown[];
  /** Thrown instead of answering, on the 1st, 2nd, … pull call. */
  readonly pullErrors?: readonly unknown[];
  /** Answer the batch as normal, then lose the response — the idempotency case. */
  readonly dropResponseAfter?: number;
  /** The server's clock, stamped on every push result and every page it serves. */
  readonly serverTime?: string | null;
}

/**
 * A server that keeps receipts, because the contract's central promise is that
 * the same operation id is the same write. The first sighting of an id is
 * decided by the script; every later sighting is answered `duplicate` with the
 * revision already recorded, which is what the real endpoints must do against
 * their receipt store.
 */
class ScriptedServer implements SyncTransport {
  readonly pushRequests: SyncPushRequest[] = [];
  readonly pullSince: Array<string | null> = [];
  /** What the server holds: `entity:entityId` → the revision it allocated. */
  readonly rows = new Map<string, number>();
  /** Operation ids newly written. A retry must never widen this list. */
  readonly newlyApplied: string[] = [];

  private readonly firstAnswer = new Map<string, SyncPushOutcome>();
  private readonly script: ServerScript;
  private revision = 0;
  private pushCall = 0;
  private pullCall = 0;

  constructor(script: ServerScript = {}) {
    this.script = script;
  }

  /** The write landed and the response did not: applied once, answered twice. */
  preapply(input: {
    id: string;
    entity: string;
    entityId: string;
    revision: number;
  }): void {
    this.firstAnswer.set(input.id, {
      status: "applied",
      revision: input.revision,
    });
    this.rows.set(`${input.entity}:${input.entityId}`, input.revision);
  }

  async push(request: SyncPushRequest): Promise<SyncPushResult> {
    this.pushRequests.push(request);
    this.pushCall += 1;
    const failure = this.script.pushErrors?.[this.pushCall - 1];
    if (failure !== undefined) throw failure;

    const outcomes: SyncPushResult["outcomes"] = [];
    for (const operation of request.operations) {
      const already = this.firstAnswer.get(operation.id);
      if (already) {
        outcomes.push({
          operationId: operation.id,
          outcome:
            already.status === "applied"
              ? { status: "duplicate", revision: already.revision ?? null }
              : already,
        });
        continue;
      }

      const decided = this.script.decide
        ? this.script.decide(operation)
        : { status: "applied" as const };
      // No decision, no outcome: the operation is simply absent from the reply.
      if (!decided) continue;

      const outcome = this.record(operation, decided);
      this.firstAnswer.set(operation.id, outcome);
      outcomes.push({ operationId: operation.id, outcome });
    }

    if (this.script.dropResponseAfter === this.pushCall) {
      throw new Error("connection reset after the server wrote");
    }
    return { outcomes, serverTime: this.script.serverTime ?? null };
  }

  async pull(since: string | null): Promise<SyncPullPage> {
    this.pullSince.push(since);
    this.pullCall += 1;
    const failure = this.script.pullErrors?.[this.pullCall - 1];
    if (failure !== undefined) throw failure;
    const page = this.script.pages?.[this.pullCall - 1] ?? {
      nextCursor: null,
      changes: [],
    };
    // A real server stamps every page with its own clock, and the client's
    // "last authorized exchange" is supposed to come from that stamp rather than
    // from the device. Pages written without one inherit the script's clock.
    return {
      ...page,
      serverTime: page.serverTime ?? this.script.serverTime ?? null,
    };
  }

  /** Allocates the revision the way a server's per-row counter does. */
  private record(operation: QueuedOperation, outcome: SyncPushOutcome) {
    if (outcome.status !== "applied") return outcome;
    const revision = this.allocate(outcome.revision);
    this.rows.set(`${operation.entity}:${operation.entityId}`, revision);
    this.newlyApplied.push(operation.id);
    return { ...outcome, revision };
  }

  private allocate(explicit?: number | null): number {
    const revision = explicit ?? this.revision + 1;
    this.revision = Math.max(revision, this.revision);
    return revision;
  }
}

function frame(
  entity: string,
  id: string,
  revision: number,
  data: Record<string, unknown>,
  deleted = false,
): SyncChangeFrame {
  return {
    entity,
    id,
    revision,
    deleted,
    updatedAt: "2026-10-15T10:00:00.000Z",
    data,
  };
}

function contactFrame(id: string, revision: number, firstName: string) {
  return frame("contact", id, revision, {
    tenantId: TENANT,
    firstName,
    type: "INDIVIDUAL",
    status: "ACTIVE",
  });
}

function issuedDocumentFrame(id: string, revision: number, number: string) {
  return frame("document", id, revision, {
    tenantId: TENANT,
    type: "QUOTATION",
    status: "ISSUED",
    number,
    currency: "KES",
    issueDate: "2026-10-15T10:00:00.000Z",
    subtotal: "4500.0000",
    taxableBase: "4500.0000",
    taxTotal: "0.0000",
    total: "4500.0000",
    issuedAt: "2026-10-15T10:00:00.000Z",
    roundingPolicy: "half-up-per-line-v1",
  });
}

function tenantFrame(status: string, extra: Record<string, unknown> = {}) {
  return frame("tenant", TENANT, 1, {
    tenantId: TENANT,
    name: "Amisi Water Works",
    slug: "amisi-water",
    status,
    currency: "KES",
    timezone: "Africa/Nairobi",
    locale: "en",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

describe("the sync contracts and the local schema agree", () => {
  it("offers exactly the conflict endings the conflict table permits", () => {
    const ddl = MIGRATIONS.flatMap((migration) => migration.statements).find(
      (statement) => statement.includes("CREATE TABLE conflict"),
    );
    const line = (ddl ?? "")
      .split("\n")
      .find((row) => row.includes("resolution") && row.includes("IN ("));
    const permitted = [...(line ?? "").matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === "string")
      .sort();

    // Three lists, one truth: the shared contract, the storage layer's own
    // constant, and the CHECK constraint that actually refuses a bad write.
    expect(permitted).toEqual([...CONFLICT_RESOLUTIONS].sort());
    expect([...CONTRACT_CONFLICT_RESOLUTIONS].sort()).toEqual(
      [...CONFLICT_RESOLUTIONS].sort(),
    );
    // There is deliberately no automatic resolution anywhere: an outcome the
    // user did not choose is an overwrite, not a resolution.
    expect(permitted).not.toContain("auto");
    expect(permitted).not.toContain("server_wins");
  });
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

describe("push: only what the server confirmed", () => {
  it("names the row an operation describes and offers the revision it last confirmed", async () => {
    const { db } = await provisioned();
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Njeri",
    });

    const first = new ScriptedServer({
      decide: () => ({ status: "applied", revision: 4 }),
    });
    await syncClient(db, first).run();

    await db.contacts.update(TENANT, contact.id, {
      firstName: "Njeri Wanjiru",
    });
    const second = new ScriptedServer({
      decide: () => ({ status: "applied", revision: 5 }),
    });
    await syncClient(db, second).run();

    const create = first.pushRequests[0]?.operations[0];
    expect(create?.entity).toBe("contact");
    expect(create?.entityId).toBe(contact.id);
    expect(create?.type).toBe("contact.create");
    expect(create?.baseRevision).toBeNull();
    expect(first.pushRequests[0]?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(first.pushRequests[0]?.clientId).toBe(await db.meta.clientId());

    // The headline of optimistic concurrency: the number the server handed over
    // on the first exchange is the number the next edit is offered against. An
    // update that arrived with no base revision is an update that cannot check.
    const update = second.pushRequests[0]?.operations[0];
    expect(update?.type).toBe("contact.update");
    expect(update?.baseRevision).toBe(4);
    expect(second.rows.get(`contact:${contact.id}`)).toBe(5);
    await db.close();
  });

  it("applies an offline create, stamps the row, and renews the offline window", async () => {
    const { db } = await provisioned();
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Wanjiru",
    });
    const operation = await onlyOperation(db);

    const server = new ScriptedServer({
      decide: () => ({ status: "applied", revision: 4 }),
      serverTime: SERVER_TIME,
    });
    const report = await syncClient(db, server).run();

    expect(report.halted).toBeNull();
    expect(report.pushed).toBe(1);
    expect(report.push.applied).toBe(1);
    expect(report.push.duplicates).toBe(0);
    expect(await db.outbox.findById(operation.id)).toMatchObject({
      status: "applied",
    });

    const row = await db.contacts.get(contact.id, TENANT);
    expect(row?.syncState).toBe("synced");
    expect(row?.baseRevision).toBe(4);
    expect(row?.lastError).toBeNull();

    const checkpoint = await db.checkpoints.get(TENANT);
    expect(checkpoint?.lastPushAt).toBeTruthy();
    expect(checkpoint?.lastError).toBeNull();

    // §8.2: a successful authorized exchange is what buys more offline time, and
    // it is measured from the server's clock rather than the device's.
    expect(report.authorization).toMatchObject({
      renewed: true,
      reason: "renewed",
      offlineExpiresAt: RENEWED_WINDOW,
      tenantStatus: "ACTIVE",
    });
    expect(await db.meta.get("last_authorized_at")).toBe(SERVER_TIME);
    expect(await db.meta.offlineCreation()).toMatchObject({ allowed: true });
    await db.close();
  });

  it("restarts, recovers the interrupted batch, and a duplicate retry applies nothing twice", async () => {
    const fixture = newDatabase();
    const db = await openDatabase(fixture.path);
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Kamau",
    });
    const operation = await onlyOperation(db);

    // The previous process claimed the batch and died before recording the
    // result — while the server had already written the row.
    const claimed = await db.outbox.claimPending("pid-4471", 20);
    expect(claimed).toHaveLength(1);
    await db.close();

    const server = new ScriptedServer({ serverTime: SERVER_TIME });
    server.preapply({
      id: operation.id,
      entity: operation.entity,
      entityId: operation.entityId,
      revision: 4,
    });

    // A new process on the same file: the directive's "restart the app and
    // recover", carried all the way into the exchange.
    const reopened = await openDatabase(fixture.path);
    const report = await syncClient(reopened, server, {
      generation: "relaunch",
    }).run();

    expect(report.recovered).toBe(1);
    expect(report.push.duplicates).toBe(1);
    expect(report.push.applied).toBe(0);
    // Nothing new reached the server's write path: the id was a retry, not a
    // second record.
    expect(server.newlyApplied).toHaveLength(0);
    expect(server.rows.get(`contact:${contact.id}`)).toBe(4);

    const queued = await reopened.outbox.findById(operation.id);
    expect(queued?.status).toBe("applied");
    const row = await reopened.contacts.get(contact.id, TENANT);
    expect(row?.syncState).toBe("synced");
    expect(row?.baseRevision).toBe(4);
    expect(await reopened.contacts.list(TENANT)).toHaveLength(1);

    // And the retry does not linger: a third launch has nothing to send.
    const again = await syncClient(reopened, server, {
      generation: "relaunch-2",
    }).run();
    expect(again.pushed).toBe(0);
    expect(server.pushRequests).toHaveLength(1);
    expect(await reopened.outbox.pendingCount(TENANT)).toBe(0);
    await reopened.close();
  });

  it("does not treat an operation the server said nothing about as a success", async () => {
    const { db } = await provisioned();
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Unanswered",
    });
    const operation = await onlyOperation(db);

    const server = new ScriptedServer({ decide: () => undefined });
    const report = await syncClient(db, server).run();

    expect(report.push.applied).toBe(0);
    expect(report.push.missingOutcome).toBe(1);
    expect(report.halted).toBeNull();

    const queued = await db.outbox.findById(operation.id);
    expect(queued?.status).toBe("pending");
    expect(queued?.attempts).toBe(1);
    expect(queued?.lastError).toContain("no outcome");

    // The row is untouched: no `synced`, no number, no claim of anything.
    const row = await db.contacts.get(contact.id, TENANT);
    expect(row?.syncState).toBe("local");
    expect(row?.baseRevision).toBeNull();
    expect(await db.outbox.pendingCount(TENANT)).toBe(1);
    await db.close();
  });

  it("keeps a refused draft, records the reason, and stops retrying it", async () => {
    const { db } = await provisioned();
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Njeri",
      phone: "+254700111222",
    });
    const operation = await onlyOperation(db);

    const server = new ScriptedServer({
      decide: () => ({
        status: "rejected",
        reason: "the tenant is suspended; writes are closed",
      }),
    });
    const report = await syncClient(db, server).run();

    expect(report.push.rejected).toBe(1);
    expect(report.push.applied).toBe(0);
    const queued = await db.outbox.findById(operation.id);
    expect(queued?.status).toBe("failed");
    expect(queued?.rejectedReason).toContain("suspended");

    const row = await db.contacts.get(contact.id, TENANT);
    expect(row?.syncState).toBe("rejected");
    // Preserved for controlled recovery: the data is still there, with the reason.
    expect(row?.firstName).toBe("Njeri");
    expect(row?.phone).toBe("+254700111222");
    expect(row?.lastError).toContain("suspended");

    // A permanent refusal is not retried: an operation whose answer cannot
    // change does not get to burn the battery or the server's time.
    const again = await syncClient(db, server).run();
    expect(again.pushed).toBe(0);
    expect(server.pushRequests).toHaveLength(1);
    expect(await db.outbox.pendingCount(TENANT)).toBe(0);
    await db.close();
  });

  it("releases the batch on an expired session without burning the queue", async () => {
    const { db } = await provisioned();
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Half-sent",
    });
    const operation = await onlyOperation(db);
    await db.checkpoints.recordPull({
      tenantId: TENANT,
      cursor: "cursor-from-the-old-session",
      serverTime: null,
    });
    const windowBefore = await db.meta.get("offline_expires_at");

    const server = new ScriptedServer({
      pushErrors: [new SyncUnauthorizedError("session revoked")],
    });
    const report = await syncClient(db, server).run();

    expect(report.halted).toBe("unauthorized");
    expect(report.push.released).toBe(1);
    expect(report.push.failedAttempts).toBe(0);

    const queued = await db.outbox.findById(operation.id);
    expect(queued?.status).toBe("pending");
    // The session expired; the operation did nothing wrong. Counting an attempt
    // here would eventually fail good drafts for a reason unrelated to them.
    expect(queued?.attempts).toBe(0);
    expect(queued?.generation).toBeNull();
    expect(queued?.nextAttemptAt).toBeNull();

    const row = await db.contacts.get(contact.id, TENANT);
    expect(row?.syncState).toBe("local");
    expect(row?.firstName).toBe("Half-sent");

    // A position a revoked session reached is not inherited by the next one; the
    // push record is the more recent fact, so it names the session.
    const checkpoint = await db.checkpoints.get(TENANT);
    expect(checkpoint?.cursor).toBeNull();
    expect(checkpoint?.lastError).toContain("unauthorized");

    // The run stops rather than asking a revoked session for changes.
    expect(server.pullSince).toHaveLength(0);
    expect(report.authorization.renewed).toBe(false);
    expect(await db.meta.get("offline_expires_at")).toBe(windowBefore);
    await db.close();
  });

  it("counts a protocol refusal as an attempt and still pulls", async () => {
    const { db } = await provisioned();
    await db.contacts.create({ tenantId: TENANT, firstName: "Unparseable" });

    const server = new ScriptedServer({
      pushErrors: [new SyncProtocolError("unrecognised operation envelope")],
      pages: [
        {
          nextCursor: null,
          changes: [
            contactFrame(
              "cccccccc-0000-4000-8000-000000000004",
              2,
              "Read anyway",
            ),
          ],
        },
      ],
    });
    const report = await syncClient(db, server).run();

    expect(report.halted).toBe("protocol_error");
    expect(report.lastPushError).toContain("unrecognised operation envelope");
    expect(report.push.failedAttempts).toBe(1);
    const queued = await onlyOperation(db);
    expect(queued.status).toBe("pending");
    expect(queued.attempts).toBe(1);

    // The wire worked; only the request was refused, so reading still happens.
    expect(report.pull.pages).toBe(1);
    expect(report.pull.applied).toBe(1);
    await expect(
      db.contacts.get("cccccccc-0000-4000-8000-000000000004", TENANT),
    ).resolves.toMatchObject({ syncState: "synced" });
    await db.close();
  });

  it("keeps both sides of a conflict and re-offers the local change against the server revision", async () => {
    const { db } = await provisioned();
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Wambui",
    });
    const original = await onlyOperation(db);

    const server = new ScriptedServer({
      decide: () => ({
        status: "conflict",
        conflictId: "svr-conflict-77",
        serverRevision: 7,
      }),
    });
    const report = await syncClient(db, server).run();

    expect(report.push.conflicts).toBe(1);
    expect(report.push.applied).toBe(0);
    expect(await db.outbox.findById(original.id)).toMatchObject({
      status: "conflict",
    });

    const open = await db.conflicts.listOpen(TENANT);
    expect(open).toHaveLength(1);
    const conflict = open[0];
    if (!conflict) throw new Error("The conflict was not recorded");
    expect(conflict).toMatchObject({
      operationId: original.id,
      entity: "contact",
      entityId: contact.id,
      serverRevision: 7,
      baseRevision: null,
    });
    expect((conflict.localPayload as { firstName?: string }).firstName).toBe(
      "Wambui",
    );

    const row = await db.contacts.get(contact.id, TENANT);
    expect(row?.syncState).toBe("conflict");
    expect(row?.firstName).toBe("Wambui");
    expect(row?.lastError).toContain("Server revision 7");

    // The disagreement is not an editing target: an edit here would choose a
    // side by accident rather than by decision.
    await expect(
      db.contacts.update(TENANT, contact.id, { firstName: "Overwritten" }),
    ).rejects.toThrow(/conflict/i);

    // The user's decision, expressed as an action: the local version is offered
    // again as a NEW operation against revision 7, and the server accepts it.
    const reappliedId = await db.contacts.reapplyAfterConflict(
      TENANT,
      contact.id,
    );
    const acceptor = new ScriptedServer({
      decide: () => ({ status: "applied", revision: 12 }),
    });
    const second = await syncClient(db, acceptor).run();

    expect(second.push.applied).toBe(1);
    const reapplied = await db.outbox.findById(reappliedId);
    expect(reapplied).toMatchObject({
      type: "contact.update",
      baseRevision: 7,
      status: "applied",
    });
    // Nothing was destroyed on the way: the refused operation and its record
    // both still exist.
    expect(await db.outbox.findById(original.id)).toMatchObject({
      status: "conflict",
    });
    expect(await db.conflicts.countOpen(TENANT)).toBe(1);

    const closed = await db.conflicts.resolve(conflict.id, "reapplied_local");
    expect(closed?.resolution).toBe("reapplied_local");
    expect(await db.conflicts.countOpen(TENANT)).toBe(0);
    // Closed, not deleted — the disagreement remains part of the record.
    await expect(db.conflicts.get(conflict.id)).resolves.toMatchObject({
      resolvedAt: expect.any(String),
      serverRevision: 7,
    });

    await expect(db.contacts.get(contact.id, TENANT)).resolves.toMatchObject({
      syncState: "synced",
      baseRevision: 12,
      firstName: "Wambui",
    });
    await db.close();
  });

  it("sends the queue in order and stops at the batch limit", async () => {
    const { db } = await provisioned();
    const first = await db.contacts.create({
      tenantId: TENANT,
      firstName: "One",
    });
    const second = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Two",
    });
    const third = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Three",
    });

    const server = new ScriptedServer({});
    const report = await syncClient(db, server, {
      batchLimit: 1,
      maxPushBatches: 2,
    }).run();

    expect(report.pushed).toBe(2);
    expect(server.pushRequests).toHaveLength(2);
    expect(
      server.pushRequests.map((request) => request.operations.length),
    ).toEqual([1, 1]);
    // Order is the contract: a line never travels before the document that
    // creates its parent, so the engine must not reorder the queue.
    expect(
      server.pushRequests.map((request) => request.operations[0]?.entityId),
    ).toEqual([first.id, second.id]);
    expect(await db.outbox.pendingCount(TENANT)).toBe(1);
    const queued = await db.outbox.list(TENANT);
    expect(queued[2]?.entityId).toBe(third.id);
    expect(queued[2]?.status).toBe("pending");
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

describe("pull: what the server said, and where the cursor stands", () => {
  it("walks the pages and resumes from the cursor the last page handed over", async () => {
    const { db } = await provisioned();
    const server = new ScriptedServer({
      serverTime: SERVER_TIME,
      pages: [
        {
          nextCursor: "p1",
          changes: [
            contactFrame("cccccccc-0000-4000-8000-100000000001", 1, "Page one"),
          ],
        },
        {
          nextCursor: "p2",
          changes: [
            contactFrame("cccccccc-0000-4000-8000-100000000002", 2, "Page two"),
          ],
        },
        {
          nextCursor: null,
          changes: [
            contactFrame(
              "cccccccc-0000-4000-8000-100000000003",
              3,
              "Page three",
            ),
          ],
        },
      ],
    });

    const report = await syncClient(db, server).run();
    expect(report.pull.pages).toBe(3);
    expect(report.pull.frames).toBe(3);
    expect(report.pull.applied).toBe(3);
    expect(server.pullSince).toEqual([null, "p1", "p2"]);

    const checkpoint = await db.checkpoints.get(TENANT);
    expect(checkpoint?.cursor).toBe("p2");
    expect(checkpoint?.lastPullAt).toBeTruthy();
    expect(checkpoint?.serverTime).toBe(SERVER_TIME);

    // The next launch asks for what it has not seen, not for everything again.
    await syncClient(db, server, { generation: "second-run" }).run();
    expect(server.pullSince).toEqual([null, "p1", "p2", "p2"]);
    await expect(db.contacts.list(TENANT)).resolves.toHaveLength(3);
    await db.close();
  });

  it("stops when the cursor does not move instead of pulling forever", async () => {
    const { db } = await provisioned();
    const stuck: SyncPullPage = { nextCursor: "stuck", changes: [] };
    const server = new ScriptedServer({ pages: [stuck, stuck] });

    const report = await syncClient(db, server).run();
    expect(report.halted).toBe("cursor_stalled");
    expect(report.pull.pages).toBe(2);
    expect(server.pullSince).toEqual([null, "stuck"]);
    // The stall is reported, not hidden: the caller can say why it stopped.
    expect(report.lastPullError).toContain("repeated a cursor");
    await expect(db.checkpoints.get(TENANT)).resolves.toMatchObject({
      cursor: "stuck",
    });
    await db.close();
  });

  it("aborts on a page it cannot store and leaves the cursor where it was", async () => {
    const { db } = await provisioned();
    const server = new ScriptedServer({
      pages: [
        {
          nextCursor: "p1",
          changes: [
            contactFrame("cccccccc-0000-4000-8000-200000000001", 1, "Stored"),
          ],
        },
        {
          nextCursor: "p2",
          changes: [
            frame("widget", "cccccccc-0000-4000-8000-200000000002", 1, {
              tenantId: TENANT,
            }),
          ],
        },
      ],
    });

    await expect(syncClient(db, server).run()).rejects.toThrow(
      /is not an entity this client knows how to store/i,
    );

    // The good page committed and moved the cursor; the refused page did not
    // advance it, so the next run asks for the same range again.
    await expect(db.checkpoints.get(TENANT)).resolves.toMatchObject({
      cursor: "p1",
    });
    await expect(
      db.contacts.get("cccccccc-0000-4000-8000-200000000001", TENANT),
    ).resolves.toMatchObject({ firstName: "Stored" });
    expect(await db.contacts.list(TENANT)).toHaveLength(1);
    await db.close();
  });

  it("lets a newer server copy replace a synchronized row, and recognises the echo of its own write", async () => {
    const { db } = await provisioned();
    const id = "cccccccc-0000-4000-8000-300000000001";

    const imported = await syncClient(
      db,
      new ScriptedServer({
        pages: [
          {
            nextCursor: "p1",
            changes: [contactFrame(id, 3, "Aisha (server)")],
          },
        ],
      }),
    ).run();
    expect(imported.pull.applied).toBe(1);
    await expect(db.contacts.get(id, TENANT)).resolves.toMatchObject({
      firstName: "Aisha (server)",
      syncState: "synced",
      baseRevision: 3,
    });

    const updated = await syncClient(
      db,
      new ScriptedServer({
        pages: [
          {
            nextCursor: "p2",
            changes: [contactFrame(id, 6, "Aisha (renamed)")],
          },
        ],
      }),
    ).run();
    expect(updated.pull.applied).toBe(1);
    await expect(db.contacts.get(id, TENANT)).resolves.toMatchObject({
      firstName: "Aisha (renamed)",
      baseRevision: 6,
    });

    // Now the device edits, the server accepts it at revision 9, and a page
    // still carrying revision 6 arrives. The revision comparison decides: the
    // accepted change survives, and it is not a conflict either.
    await db.contacts.update(TENANT, id, { firstName: "Aisha (device)" });
    const echoed = await syncClient(
      db,
      new ScriptedServer({
        decide: () => ({ status: "applied", revision: 9 }),
        pages: [
          {
            nextCursor: "p3",
            changes: [contactFrame(id, 6, "Aisha (renamed)")],
          },
        ],
      }),
    ).run();

    expect(echoed.push.applied).toBe(1);
    expect(echoed.pull.alreadyCurrent).toBe(1);
    expect(echoed.pull.conflicts).toBe(0);
    await expect(db.contacts.get(id, TENANT)).resolves.toMatchObject({
      firstName: "Aisha (device)",
      syncState: "synced",
      baseRevision: 9,
    });
    await db.close();
  });

  it("gives a document its number only when the server sends one", async () => {
    const { db } = await provisioned();
    const draft = await db.documents.createDraft({
      tenantId: TENANT,
      type: "QUOTATION",
      lines: [
        { description: "Pump service", quantity: "1", unitPrice: "4500.00" },
      ],
    });
    await db.documents.requestIssuance(TENANT, draft.id);

    // Before the exchange: a local label, no number, no issue date.
    expect(draft.number).toBeNull();
    expect(draft.reference).toMatch(/^LOCAL-/);
    expect(draft.status).toBe("DRAFT");
    expect(
      (await db.outbox.list(TENANT)).map((operation) => operation.type),
    ).toEqual(["document.draft.create", "document.issue"]);

    const server = new ScriptedServer({
      serverTime: SERVER_TIME,
      pages: [
        {
          nextCursor: null,
          changes: [issuedDocumentFrame(draft.id, 8, "QUO-2026-0007")],
        },
      ],
    });
    const report = await syncClient(db, server).run();

    expect(report.pushed).toBe(2);
    expect(report.push.applied).toBe(2);
    expect(report.pull.applied).toBe(1);

    const after = await db.documents.get(draft.id, TENANT);
    // The number is the server's, the revision is the server's, and the label
    // stops being a local one because it no longer has to be.
    expect(after).toMatchObject({
      number: "QUO-2026-0007",
      status: "ISSUED",
      syncState: "synced",
      baseRevision: 8,
      reference: "QUO-2026-0007",
    });
    expect(after?.issuedAt).toBe("2026-10-15T10:00:00.000Z");
    await db.close();
  });

  it("learns a suspension at the next exchange instead of pretending to enforce it offline", async () => {
    const { db } = await provisioned();
    // Work the device queued while the tenant was still active.
    const contact = await db.contacts.create({
      tenantId: TENANT,
      firstName: "Queued while active",
    });
    expect(await db.meta.offlineCreation()).toMatchObject({ allowed: true });

    const server = new ScriptedServer({
      serverTime: SERVER_TIME,
      decide: () => ({
        status: "rejected",
        reason: "tenant suspended: app_tenant_accepts_writes() is false",
      }),
      pages: [
        {
          nextCursor: null,
          changes: [
            tenantFrame("SUSPENDED", {
              suspendedAt: "2026-10-15T09:00:00.000Z",
              suspensionReason: "unpaid invoice",
            }),
          ],
        },
      ],
    });

    const report = await syncClient(db, server).run();

    // The draft is refused with the reason, and kept.
    expect(report.push.rejected).toBe(1);
    await expect(db.contacts.get(contact.id, TENANT)).resolves.toMatchObject({
      syncState: "rejected",
      firstName: "Queued while active",
    });

    // The status the server just described is now the device's cached fact, so
    // the UI stops inviting work that cannot be accepted. That is the whole of
    // what suspension can mean on a device: it arrives with the next exchange.
    await expect(db.meta.get("tenant_status")).resolves.toBe("SUSPENDED");
    expect(await db.meta.offlineCreation()).toMatchObject({
      allowed: false,
      reason: "tenant_suspended",
      tenantStatus: "SUSPENDED",
    });
    await expect(
      db.driver.get<{ status: string; suspension_reason: string | null }>(
        `SELECT status, suspension_reason FROM tenant_profile WHERE tenant_id = ?`,
        [TENANT],
      ),
    ).resolves.toMatchObject({
      status: "SUSPENDED",
      suspension_reason: "unpaid invoice",
    });
    await db.close();
  });

  it("cannot revive an expired session by renewing the offline window", async () => {
    const { db } = await provisioned({
      session: { tokenExpiresAt: "2026-10-15T09:00:00.000Z" },
    });
    expect(await db.meta.offlineCreation()).toMatchObject({
      allowed: false,
      reason: "session_expired",
    });

    const server = new ScriptedServer({ serverTime: SERVER_TIME });
    const report = await syncClient(db, server).run();

    // The engine renews what it can prove — the time of the last authorized
    // exchange — and nothing else. It does not own the auth token and cannot
    // refresh it, so §8.4 still holds after a successful run: an expired session
    // is not an offline-capable one.
    expect(report.authorization.renewed).toBe(true);
    expect(await db.meta.get("offline_expires_at")).toBe(RENEWED_WINDOW);
    expect(await db.meta.get("token_expires_at")).toBe(
      "2026-10-15T09:00:00.000Z",
    );
    expect(await db.meta.offlineCreation()).toMatchObject({
      allowed: false,
      reason: "session_expired",
    });
    await db.close();
  });
});
