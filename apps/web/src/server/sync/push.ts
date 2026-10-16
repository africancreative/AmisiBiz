import { prisma } from "@amisibiz/database";
import type { SyncPushOutcome, SyncPushResult } from "@amisibiz/sync";
import { logger } from "@/lib/logger";
import {
  MAX_SYNC_OPERATIONS,
  SYNC_SCHEMA_VERSION,
  type SyncPushEnvelope,
  type SyncOperationInput,
} from "@/lib/validations/sync";
import {
  assertWritableContext,
  AuthorizationError,
  resolveTenantContext,
} from "@/server/auth/authorization";
import {
  SYNC_OPERATION_HANDLERS,
  readRowRevision,
} from "@/server/sync/registry";

/**
 * `POST /api/sync/push` — the server half of the offline operation replay.
 *
 * The flow is deliberately boring, because every interesting part of it is a rule
 * the directive already fixed:
 *
 * 1. **The batch is gated once, then each operation is authorized again.**
 *    `resolveTenantContext` proves membership and `assertWritableContext` applies
 *    the suspension / support-grant write gate — a suspended workspace's
 *    operations are `rejected` with the reason, never queued behind the backoff.
 *    Each operation then runs through its existing Server Action, which repeats
 *    authorization for that operation's own permission. One gate is not the
 *    other: the batch gate is whether the workspace is writable at all, the
 *    per-operation gate is whether *this* actor may do *that* thing.
 *
 * 2. **Idempotency is a receipt, not a heuristic.** A retried operation is
 *    answered from `SyncOperation(clientId, operationId)` — the client's own
 *    idempotency key — instead of being applied twice, so the client converges
 *    even when the first response was lost.
 *
 * 3. **Optimistic concurrency is checked before the write.** An operation that
 *    carries `baseRevision` is refused with `conflict` when the row has moved on,
 *    which is how "do not silently overwrite newer server data" is enforced
 *    rather than merely intended (design §7.4).
 *
 * 4. **A device clock is never consulted.** `serverTime` is the server's own
 *    clock; an operation's `createdAt` is display/debug data only.
 *
 * Nothing here recomputes business state: prices, totals, numbers and statuses
 * are the Server Actions' job, and this handler never writes a business row
 * directly.
 */

type PushParams = {
  _userId: string;
  tenantId: string;
  envelope: SyncPushEnvelope;
};

type BatchRefusal = { code: string; message: string };

export async function handleSyncPush({
  _userId,
  tenantId,
  envelope,
}: PushParams): Promise<SyncPushResult> {
  const serverTime = new Date().toISOString();
  const clientId = envelope.clientId;
  const operations = envelope.operations.slice(0, MAX_SYNC_OPERATIONS);

  // ── Schema compatibility ───────────────────────────────────────────────────
  // A client whose local schema the server cannot safely answer is refused in
  // band (`rejected` per operation) rather than 4xx'd, so the queue is marked
  // permanently failed instead of released-and-retried forever. An *absent*
  // version is accepted: the contract promises an older client that predates the
  // field still parses, and there is exactly one schema version today.
  if (
    envelope.schemaVersion !== undefined &&
    envelope.schemaVersion !== SYNC_SCHEMA_VERSION
  ) {
    await stampSyncAttempt(tenantId, false, "SCHEMA_VERSION_UNSUPPORTED");
    return refuseBatch(operations, "unsupported_schema_version", serverTime);
  }

  // ── The workspace-level gate ───────────────────────────────────────────────
  let refusal: BatchRefusal | null = null;
  try {
    const context = await resolveTenantContext(_userId, tenantId);
    await assertWritableContext(context);
  } catch (err) {
    refusal = describeBatchRefusal(err);
  }

  if (refusal) {
    await stampSyncAttempt(tenantId, false, refusal.code);
    return refuseBatch(operations, refusal.message, serverTime);
  }

  // ── Per-operation application ──────────────────────────────────────────────
  const outcomes: SyncPushResult["outcomes"] = [];
  for (const operation of operations) {
    outcomes.push({
      operationId: operation.id,
      outcome: await applyOperation({ clientId, _userId, tenantId, operation }),
    });
  }

  await stampSyncAttempt(tenantId, true, null);
  return { outcomes, serverTime };
}

async function applyOperation({
  clientId,
  _userId,
  tenantId,
  operation,
}: {
  clientId: string;
  _userId: string;
  tenantId: string;
  operation: SyncOperationInput;
}): Promise<SyncPushOutcome> {
  // A retry is answered from its receipt BEFORE anything else is considered, so
  // a permanently-rejected or conflicting operation stays that way instead of
  // being re-derived (and possibly answered differently) on the second attempt.
  const receipt = await prisma.syncOperation.findUnique({
    where: { clientId_operationId: { clientId, operationId: operation.id } },
    select: {
      outcome: true,
      revision: true,
      reason: true,
      conflictId: true,
    },
  });
  if (receipt) return replayOutcome(receipt);

  const outcome = await resolveOutcome({ _userId, tenantId, operation });

  await prisma.syncOperation.create({
    data: {
      clientId,
      operationId: operation.id,
      tenantId,
      _userId,
      entity: operation.entity,
      entityId: operation.entityId,
      outcome: outcome.status,
      revision:
        outcome.status === "applied" || outcome.status === "duplicate"
          ? (outcome.revision ?? null)
          : null,
      reason: outcome.status === "rejected" ? outcome.reason : null,
      conflictId: outcome.status === "conflict" ? outcome.conflictId : null,
    },
  });

  return outcome;
}

/** Works out the outcome of an operation that has no receipt yet. */
async function resolveOutcome({
  _userId,
  tenantId,
  operation,
}: {
  _userId: string;
  tenantId: string;
  operation: SyncOperationInput;
}): Promise<SyncPushOutcome> {
  const handler = SYNC_OPERATION_HANDLERS[operation.type];
  if (!handler) {
    return { status: "rejected", reason: "unsupported_operation_type" };
  }

  // The client states both `type` and `entity`; a disagreement is a contract
  // breach, not something to resolve by guessing which one is right.
  if (handler.entity !== operation.entity) {
    return { status: "rejected", reason: "entity_type_mismatch" };
  }

  if (operation.type.endsWith(".update") && operation.baseRevision == null) {
    // An edit the client cannot date is an edit the server cannot check, and an
    // unchecked write is exactly the silent overwrite the directive forbids.
    return { status: "rejected", reason: "missing_base_revision" };
  }

  const currentRevision = await readRowRevision(
    handler.entity,
    tenantId,
    operation.entityId,
  );

  if (
    operation.baseRevision != null &&
    currentRevision !== null &&
    operation.baseRevision !== currentRevision
  ) {
    return {
      status: "conflict",
      conflictId: operation.id,
      serverRevision: currentRevision,
    };
  }

  const result = await handler.run(
    handler.buildInput(operation, tenantId) as unknown,
    operation.entityId,
  );

  if (!result.success) {
    return { status: "rejected", reason: rejectionReason(result) };
  }

  const settledRevision = await readRowRevision(
    handler.entity,
    tenantId,
    operation.entityId,
  );

  return { status: "applied", revision: settledRevision };
}

type Receipt = {
  outcome: string;
  revision: number | null;
  reason: string | null;
  conflictId: string | null;
};

function replayOutcome(receipt: Receipt): SyncPushOutcome {
  switch (receipt.outcome) {
    case "applied":
    case "duplicate":
      // The stored `applied` IS this client's retry: it landed, and the answer
      // now is "you already did this".
      return { status: "duplicate", revision: receipt.revision ?? null };
    case "conflict":
      return {
        status: "conflict",
        conflictId: receipt.conflictId ?? "conflict",
        serverRevision: receipt.revision ?? null,
      };
    default:
      return { status: "rejected", reason: receipt.reason ?? "rejected" };
  }
}

function rejectionReason(result: {
  error: string;
  code?: string | undefined;
}): string {
  return result.code ? `${result.code}:${result.error}` : result.error;
}

function describeBatchRefusal(err: unknown): BatchRefusal {
  if (err instanceof AuthorizationError) {
    return { code: err.code, message: err.message };
  }
  logger.error("sync.push.batch_gate_failed", { error: err });
  return { code: "INTERNAL", message: "The push could not be authorized." };
}

/**
 * A refused batch answers every operation as `rejected` with the same reason.
 * The client marks each permanently failed (no retry), which is the honest
 * outcome for "this workspace is not writable right now" and for a schema the
 * server cannot answer.
 */
function refuseBatch(
  operations: { id: string }[],
  reason: string,
  serverTime: string,
): SyncPushResult {
  return {
    outcomes: operations.map((operation) => ({
      operationId: operation.id,
      outcome: { status: "rejected", reason },
    })),
    serverTime,
  };
}

/**
 * Stamps the workspace's sync indicator (`Tenant.lastSyncAt` /
 * `lastSyncErrorCode`) through the Phase 2 definer function, which refuses to
 * write outside the workspace's own context.
 *
 * Best-effort on purpose: the *evidence* of what was refused is the `AuditLog`
 * rows the Server Actions wrote and the `SyncOperation` receipts. This indicator
 * is a convenience read for the provider console (Phase 2's own comment says so),
 * and a missing convenience must not fail a sync the user actually asked for.
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
    logger.warn("sync.push.indicator_stamp_failed", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
