/**
 * The transport's failure taxonomy.
 *
 * The engine has to decide between two answers that look the same from here —
 * "send it again later" and "stop sending" — and it must not make that decision
 * by matching error text. A dropped connection and a revoked session are
 * different facts, and treating the second like the first is how a device
 * spends a battery arguing with a server that already said no.
 */

/** Base class: something went wrong talking to the server. */
export class SyncTransportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SyncTransportError";
    this.status = status;
  }
}

/**
 * 401/403: the session this exchange was authorized under is no longer valid.
 *
 * Retrying cannot help. The client stops the run, clears its pull cursor so the
 * next authorized exchange re-provisions from a known-good point, and leaves
 * every local draft exactly where it is.
 */
export class SyncUnauthorizedError extends SyncTransportError {
  constructor(
    message = "The sync session is no longer authorized",
    status = 401,
  ) {
    super(message, status);
    this.name = "SyncUnauthorizedError";
  }
}

/**
 * 5xx or a refused write the client may safely offer again later.
 *
 * The engine's answer to this class: count one attempt per operation, back off,
 * stop this run and offer the same ids later. The retry is safe because the
 * operation id is an idempotency key.
 */
export class SyncRetryableError extends SyncTransportError {
  constructor(
    message = "The server could not process the exchange",
    status = 500,
  ) {
    super(message, status);
    this.name = "SyncRetryableError";
  }
}

/**
 * 4xx that is not an auth refusal: the request itself is wrong (a payload the
 * server's schema rejects, an unknown operation type).
 *
 * This is a refusal of the *batch*, not of one operation, and the distinction
 * decides the handling. A server that cannot parse the envelope cannot say which
 * operation it choked on, so the client does not invent one: every operation in
 * the batch keeps its place with one attempt counted, and the run stops rather
 * than walking into the same refusal batch after batch. Reading still happens —
 * the wire worked, only what this device sent was refused.
 */
export class SyncProtocolError extends SyncTransportError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = "SyncProtocolError";
  }
}
