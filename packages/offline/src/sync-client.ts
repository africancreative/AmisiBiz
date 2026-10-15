import type {
  ConflictStore,
  OperationQueue,
  QueuedOperation,
  SyncChangeFrame,
  SyncPushOutcome,
  SyncPushRequest,
  SyncPushResult,
  SyncPullPage,
  SyncTransport,
} from "@amisibiz/sync";
import { SyncProtocolError, SyncUnauthorizedError } from "@amisibiz/sync";
import type { ConflictRepository } from "./exchange";
import type { LocalDb } from "./local-db";
import { CURRENT_SCHEMA_VERSION } from "./schema";
import { DEFAULT_OFFLINE_AUTHORITY_HOURS } from "./constants";
import type { LocalOutbox, OutboxOperation } from "./outbox";
import type { PullFrame } from "./changes";
import type { PullPage, PullPageResult } from "./pull";
import { newUuid } from "./ids";
import { readRowState, setSyncState } from "./sync-state";

/**
 * The synchronization client: the loop an installed app runs when it has a
 * network.
 *
 * This file deliberately owns *ordering and honesty*, not storage and not
 * policy. Everything it needs is already decided elsewhere — the outbox knows
 * how to claim work without two loops grabbing the same batch, `applyPullPage`
 * knows which rows a server frame may replace, the repositories know their
 * columns. What is left is the sequence the directive asks for, and the two
 * promises it has to keep while doing it:
 *
 *   1. **Never report a success the server did not confirm.** An operation is
 *      marked applied only from an `applied` or `duplicate` outcome. An
 *      operation the server said nothing about goes back to the queue for
 *      another attempt — it is not quietly counted as done, and the batch it
 *      travelled in is not assumed lost either.
 *   2. **Never lose either side of a disagreement.** A `conflict` outcome
 *      records both versions and marks the row `conflict`, which is the state
 *      that refuses an edit until someone decides. The same is true of a pull
 *      conflict, handled inside `applyPullPage`.
 *
 * The engine is the *client's* half only. It cannot authorize itself: whatever
 * credential the exchange runs on belongs to the shell, and the server decides
 * what it means (§6 of the design). A 401 here stops the run, invalidates the
 * pull cursor and leaves every local draft untouched.
 *
 * ## Why this lives in `@amisibiz/offline` and not in `@amisibiz/sync`
 *
 * `@amisibiz/sync` stays dependency-free so the server and both shells can
 * compile against the same contracts. The loop needs a durable queue, a tenant
 * binding, conflict records and a cursor — every one of which is a table this
 * package already owns. Putting the engine in the contracts package would mean
 * re-describing all of them as ports, and an interface that only one
 * implementation will ever satisfy is ceremony, not design. The contracts are
 * still the contract: `LocalOutbox` and `ConflictRepository` are checked
 * against them below, at compile time, so drift is a build failure rather than
 * a surprise at runtime.
 */

/**
 * Compile-time conformance. If the storage layer's queue or conflict store
 * stops matching the shared contract, `pnpm type-check` fails here instead of
 * the app discovering it during a sync.
 */
type AssertProvides<Target, Source extends Target> = Source;
export type OutboxConformsToQueue = AssertProvides<OperationQueue, LocalOutbox>;
export type ConflictsConformToStore = AssertProvides<
  ConflictStore,
  ConflictRepository
>;
/**
 * `PullFrame` and `SyncChangeFrame` describe the same row twice on purpose (see
 * `changes.ts`); this is what keeps the two descriptions from drifting.
 */
export type PullFramesConformToWire = AssertProvides<
  SyncChangeFrame,
  PullFrame
>;

export interface SyncClientOptions {
  /**
   * Claim token for this run. Default: a fresh UUID, which is what a crash
   * recovery pass needs — anything left `in_flight` under a *different*
   * generation is work a dead process was holding.
   */
  readonly generation?: string;
  /** Operations per push. Default 20: one round trip for a day's edits. */
  readonly batchLimit?: number;
  /** Refuses to spin: a run pushes at most this many batches. Default 10. */
  readonly maxPushBatches?: number;
  /** Refuses to spin: a run pulls at most this many pages. Default 100. */
  readonly maxPullPages?: number;
  /** Skip the pull half (a "send what I have" button). */
  readonly pull?: boolean;
  /**
   * Length of the offline creation window granted by a successful exchange
   * (design §8.2). Default `DEFAULT_OFFLINE_AUTHORITY_HOURS`; 0 means "reads
   * only while disconnected". The server decides what is real regardless.
   */
  readonly offlineAuthorityHours?: number;
  readonly now?: () => Date;
}

/** Tallies are read-only to callers and written by the loop. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface PushTally {
  readonly applied: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly conflicts: number;
  /** Operations the server returned no outcome for. Never counted as success. */
  readonly missingOutcome: number;
  /**
   * Operations the exchange carried but the server did not answer: a dropped
   * connection or a refused envelope. Each keeps its place in the queue with an
   * attempt counted, which is what the backoff and the attempt ceiling are for.
   */
  readonly failedAttempts: number;
  /** Operations released without an attempt because the session, not the operation, failed. */
  readonly released: number;
}

export interface PullTally {
  readonly pages: number;
  readonly frames: number;
  readonly applied: number;
  readonly alreadyCurrent: number;
  readonly conflicts: number;
}

/** Why the run stopped early. `null` means it ran to completion. */
export type SyncHalt =
  | "unauthorized"
  | "transport_failure"
  | "protocol_error"
  | "cursor_stalled"
  | null;

/**
 * The outcome of the bounded offline authorization renewal (design §8.2). A
 * successful exchange pushes back the window during which this device may keep
 * drafting; anything less leaves the previously cached window exactly where it
 * was, because a failed exchange proves nothing about authorization.
 */
export interface AuthorizationRenewal {
  readonly renewed: boolean;
  readonly reason: AuthorizationRenewalReason;
  readonly offlineExpiresAt: string | null;
  readonly tenantStatus: string | null;
}

export type AuthorizationRenewalReason =
  "renewed" | "no_session" | "nothing_exchanged" | "exchange_halted";

export interface SyncRunReport {
  readonly generation: string;
  readonly tenantId: string;
  /** Operations the previous process died on, now available again. */
  readonly recovered: number;
  readonly pushed: number;
  readonly push: PushTally;
  readonly pull: PullTally;
  readonly halted: SyncHalt;
  readonly lastPushError: string | null;
  readonly lastPullError: string | null;
  readonly authorization: AuthorizationRenewal;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export class SyncClient {
  private readonly db: LocalDb;
  private readonly transport: SyncTransport;
  private readonly fixedGeneration: string | null;
  private readonly batchLimit: number;
  private readonly maxPushBatches: number;
  private readonly maxPullPages: number;
  private readonly pullEnabled: boolean;
  private readonly offlineAuthorityHours: number;
  private readonly now: () => Date;

  constructor(
    db: LocalDb,
    transport: SyncTransport,
    options: SyncClientOptions = {},
  ) {
    this.db = db;
    this.transport = transport;
    this.fixedGeneration = options.generation ?? null;
    this.batchLimit = options.batchLimit ?? 20;
    this.maxPushBatches = options.maxPushBatches ?? 10;
    this.maxPullPages = options.maxPullPages ?? 100;
    this.pullEnabled = options.pull ?? true;
    this.offlineAuthorityHours =
      options.offlineAuthorityHours ?? DEFAULT_OFFLINE_AUTHORITY_HOURS;
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<SyncRunReport> {
    const tenantId = this.db.tenantId;
    if (tenantId === null) {
      throw new Error(
        "Cannot synchronize before the device is provisioned to a tenant",
      );
    }

    const generation = this.fixedGeneration ?? `run-${newUuid()}`;
    const startedAt = this.now().toISOString();
    const push = emptyPushTally();
    const pull = emptyPullTally();

    // Recovery first: work a previous process was holding is this run's work,
    // and it keeps its operation ids, so the server sees a retry rather than
    // new records.
    const recovered = await this.db.outbox.recoverInterrupted(generation);

    let pushed = 0;
    let exchanged = false;
    let serverTime: string | null = null;
    let pushAttempted = false;
    let halted: SyncHalt = null;
    let lastPushError: string | null = null;
    let lastPullError: string | null = null;

    for (let batch = 0; batch < this.maxPushBatches; batch += 1) {
      const claimed = await this.db.outbox.claimPending(
        generation,
        this.batchLimit,
      );
      if (claimed.length === 0) break;

      pushAttempted = true;
      pushed += claimed.length;
      const request: SyncPushRequest = {
        clientId: await this.db.meta.clientId(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        operations: claimed.map(queuedView),
      };

      let result: SyncPushResult;
      try {
        result = await this.transport.push(request);
      } catch (error) {
        if (error instanceof SyncUnauthorizedError) {
          // The session failed, not the work: no attempt is counted, and the
          // drafts keep their place in the queue.
          const ids = claimed.map((operation) => operation.id);
          await this.db.outbox.release(
            ids,
            "released: the sync session expired",
          );
          // The cursor goes with the session. A position a revoked session
          // reached is not a fact the next session should inherit, and pulling
          // from the start is what re-provisions the device from what the server
          // will now say about it.
          await this.db.checkpoints.invalidate(
            tenantId,
            "sync session expired; cursor dropped",
          );
          push.released += ids.length;
          halted = "unauthorized";
          lastPushError = "unauthorized";
          break;
        }
        const message = describe(error);
        if (error instanceof SyncProtocolError) {
          // The server understood the connection and refused the envelope. It
          // cannot say *which* operation it could not parse, so the engine does
          // not invent one: every operation in the batch keeps its place with an
          // attempt counted, and the run stops instead of walking into the same
          // refusal batch after batch.
          await Promise.all(
            claimed.map(async (operation) => {
              await this.db.outbox.markFailed(
                operation.id,
                `protocol refusal: ${message}`,
              );
            }),
          );
          push.failedAttempts += claimed.length;
          halted = "protocol_error";
          lastPushError = message;
          break;
        }
        // Something was sent or not sent; the operation cannot tell, and that
        // is exactly what an idempotent retry is for. Attempts and backoff are
        // the honest answer here.
        await Promise.all(
          claimed.map(async (operation) => {
            await this.db.outbox.markFailed(operation.id, message);
          }),
        );
        push.failedAttempts += claimed.length;
        halted = "transport_failure";
        lastPushError = message;
        break;
      }

      exchanged = true;
      if (typeof result.serverTime === "string") serverTime = result.serverTime;
      const outcomes = new Map(
        (result.outcomes ?? []).map((entry) => [
          entry.operationId,
          entry.outcome,
        ]),
      );
      for (const operation of claimed) {
        const outcome = outcomes.get(operation.id);
        if (!outcome) {
          push.missingOutcome += 1;
          await this.db.outbox.markFailed(
            operation.id,
            "the server returned no outcome for this operation",
          );
          continue;
        }
        await this.settle(tenantId, operation, outcome, push);
      }
    }

    if (pushAttempted) {
      await this.db.checkpoints.recordPush({ tenantId, error: lastPushError });
    }

    // A connectivity failure or a revoked session means the pull would fail for
    // the same reason; a protocol refusal does not, because the wire worked.
    if (
      this.pullEnabled &&
      halted !== "unauthorized" &&
      halted !== "transport_failure"
    ) {
      const outcome = await this.pull(tenantId, pull);
      // The push halt survives a successful pull. The run *did* stop: an
      // envelope was refused and a batch is still unsent, and a caller that asks
      // "why is this device behind" has to be told the truth even though reading
      // carried on afterwards. A pull halt only names the run when nothing
      // before it had already done so.
      if (halted === null) halted = outcome.halted;
      lastPullError = outcome.error;
      if (outcome.serverTime !== null) serverTime = outcome.serverTime;
      exchanged = exchanged || outcome.exchanged;
    }

    const authorization = await this.renewAuthorization({
      exchanged,
      halted,
      serverTime,
    });

    return {
      generation,
      tenantId,
      recovered: recovered.length,
      pushed,
      push,
      pull,
      halted,
      lastPushError,
      lastPullError,
      authorization,
      startedAt,
      finishedAt: this.now().toISOString(),
    };
  }

  /**
   * Turns one confirmed outcome into the two writes it implies: the queue row
   * and the data row. Both happen outside any transaction this method opens,
   * and the order matters — the queue is written first, so a crash between the
   * two leaves a row that still says `pending` while the server already holds
   * the change. The next pull then brings the authoritative version, instead of
   * the reverse failure: a row claiming `synced` for data the server never got.
   */
  private async settle(
    tenantId: string,
    operation: OutboxOperation,
    outcome: SyncPushOutcome,
    push: Mutable<PushTally>,
  ): Promise<void> {
    const { entity, entityId } = operation;

    if (outcome.status === "applied" || outcome.status === "duplicate") {
      await this.db.outbox.markApplied(operation.id);
      if (outcome.status === "applied") push.applied += 1;
      else push.duplicates += 1;
      await setSyncState(this.db.driver, entity, entityId, "synced", {
        ...(outcome.revision === undefined || outcome.revision === null
          ? {}
          : { baseRevision: outcome.revision }),
        lastError: null,
      });
      return;
    }

    if (outcome.status === "rejected") {
      await this.db.outbox.markRejected(operation.id, outcome.reason);
      push.rejected += 1;
      await setSyncState(this.db.driver, entity, entityId, "rejected", {
        lastError: outcome.reason,
      });
      return;
    }

    await this.db.outbox.markConflict(
      operation.id,
      `server conflict ${outcome.conflictId}`,
    );
    push.conflicts += 1;

    // The revision the server says it is on. When it does not say, the local
    // row's own base revision is the best available answer, and `0` means what
    // it literally means: this device has never held a server version of the
    // row, which is the normal case for a create that collided.
    const state = await readRowState(this.db.driver, entity, entityId);
    const against = outcome.serverRevision ?? state?.baseRevision ?? 0;
    await this.db.conflicts.open({
      tenantId,
      operationId: operation.id,
      entity,
      entityId,
      serverRevision: against,
      baseRevision: operation.baseRevision,
      serverSnapshot: null,
      localPayload: operation.payload,
    });
    await setSyncState(this.db.driver, entity, entityId, "conflict", {
      lastError: `Server revision ${against} collided with this unsent change`,
    });
  }

  /**
   * Pulls until the server says it is caught up.
   *
   * The cursor is the server's to hand out and the checkpoint's to hold; this
   * loop only refuses two things: looping forever on a cursor that never moves,
   * and continuing after a page the client cannot interpret. A
   * `PullContractError` is allowed to propagate — the page already rolled back,
   * the cursor did not move, and "the server sent something we cannot store" is
   * a fact the caller has to hear rather than a tally number.
   */
  private async pull(
    tenantId: string,
    pull: Mutable<PullTally>,
  ): Promise<{
    halted: SyncHalt;
    error: string | null;
    exchanged: boolean;
    serverTime: string | null;
  }> {
    const checkpoint = await this.db.checkpoints.get(tenantId);
    let cursor = checkpoint?.cursor ?? null;
    let exchanged = false;
    let serverTime: string | null = null;

    for (let page = 0; page < this.maxPullPages; page += 1) {
      let remote: SyncPullPage;
      try {
        remote = await this.transport.pull(cursor);
      } catch (error) {
        if (error instanceof SyncUnauthorizedError) {
          // The cursor is dropped deliberately: after a new session the server
          // may be able to say more than it could before, and the next run has
          // to ask from the beginning rather than from a position a revoked
          // session once held.
          await this.db.checkpoints.invalidate(
            tenantId,
            "sync session expired; cursor dropped",
          );
          return {
            halted: "unauthorized",
            error: "unauthorized",
            exchanged,
            serverTime,
          };
        }
        return {
          halted: null,
          error: describe(error),
          exchanged,
          serverTime,
        };
      }

      const result: PullPageResult = await this.db.applyPullPage(
        toPullPage(remote),
      );
      exchanged = true;
      pull.pages += 1;
      pull.frames += result.frames;
      pull.applied += result.applied;
      pull.alreadyCurrent += result.alreadyCurrent;
      pull.conflicts += result.conflicts;
      if (typeof remote.serverTime === "string") serverTime = remote.serverTime;

      if (remote.nextCursor === null) {
        return { halted: null, error: null, exchanged, serverTime };
      }
      if (remote.nextCursor === cursor) {
        return {
          halted: "cursor_stalled",
          error: "the server repeated a cursor; the pull stopped",
          exchanged,
          serverTime,
        };
      }
      cursor = remote.nextCursor;
    }

    return {
      halted: "cursor_stalled",
      error: `stopped after ${this.maxPullPages} pull pages — the server has more than one run will carry`,
      exchanged,
      serverTime,
    };
  }

  /**
   * Pushes back the offline authorization window after an exchange that
   * succeeded, and caches the tenant status the server just described.
   *
   * Two limits are worth stating plainly (§8.1). The engine cannot refresh the
   * auth *token* — that is the shell's sign-in, and an expired token ends
   * offline creation immediately rather than quietly. And writing the status
   * here is how a suspension reaches a device: not by interrupting it, which
   * nothing can do while it is dark, but by recording what the server said the
   * last time it was asked.
   */
  private async renewAuthorization(input: {
    exchanged: boolean;
    halted: SyncHalt;
    serverTime: string | null;
  }): Promise<AuthorizationRenewal> {
    const current = {
      offlineExpiresAt: await this.db.meta.get("offline_expires_at"),
      tenantStatus: await this.db.meta.get("tenant_status"),
    };

    const refusal = (reason: AuthorizationRenewalReason) => ({
      renewed: false,
      reason,
      ...current,
    });

    if (!input.exchanged) return refusal("nothing_exchanged");
    if (input.halted === "unauthorized") return refusal("exchange_halted");
    if ((await this.db.meta.get("session_user_id")) === null) {
      return refusal("no_session");
    }

    const at = parseInstant(input.serverTime) ?? this.now().toISOString();
    const offlineExpiresAt = new Date(
      Date.parse(at) + this.offlineAuthorityHours * 3_600_000,
    ).toISOString();

    await this.db.meta.set("last_authorized_at", at);
    await this.db.meta.set("offline_expires_at", offlineExpiresAt);

    // The tenant profile is pull-only and was just refreshed, so this is the
    // server's own status rather than anything the device inferred.
    const profile = await this.db.driver.get<{ status: string | null }>(
      `SELECT status FROM tenant_profile WHERE tenant_id = ?`,
      [this.db.tenantId ?? ""],
    );
    const tenantStatus = profile?.status ?? current.tenantStatus;
    if (tenantStatus !== null) {
      await this.db.meta.set("tenant_status", tenantStatus);
    }

    return {
      renewed: true,
      reason: "renewed",
      offlineExpiresAt,
      tenantStatus,
    };
  }
}

/** The wire shape of one queued operation, as the shared contract defines it. */
function queuedView(operation: OutboxOperation): QueuedOperation {
  return {
    id: operation.id,
    type: operation.type,
    entity: operation.entity,
    entityId: operation.entityId,
    payload: operation.payload,
    createdAt: operation.createdAt,
    attempts: operation.attempts,
    status: operation.status,
    lastError: operation.lastError,
    baseRevision: operation.baseRevision,
  };
}

function toPullPage(page: SyncPullPage): PullPage {
  const changes: readonly SyncChangeFrame[] = page.changes ?? [];
  return {
    changes,
    nextCursor: page.nextCursor,
    serverTime: page.serverTime ?? null,
  };
}

function emptyPushTally(): Mutable<PushTally> {
  return {
    applied: 0,
    duplicates: 0,
    rejected: 0,
    conflicts: 0,
    missingOutcome: 0,
    failedAttempts: 0,
    released: 0,
  };
}

function emptyPullTally(): Mutable<PullTally> {
  return { pages: 0, frames: 0, applied: 0, alreadyCurrent: 0, conflicts: 0 };
}

/** A server timestamp is only usable if it parses; a device clock is the fallback. */
function parseInstant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
