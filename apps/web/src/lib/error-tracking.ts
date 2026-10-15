import { createLogger } from "@/lib/logger";

/**
 * Error reporting boundary.
 *
 * There is deliberately no error-tracking SaaS wired here: adding one would mean
 * a vendor account and a credential, and the project's rule is that an
 * integration is not claimed until its credentials and protocol are verified. So
 * this module defines the one function every boundary calls, emits a single
 * structured, redacted event through the shared logger, and returns a
 * correlation handle — the shape a real backend would consume, without pretending
 * one exists.
 *
 * The safety rule that matters: an error's `message` and `stack` can carry the
 * contents of a query, a token fragment or a customer's data. They are therefore
 * emitted ONLY in development. In production the event carries the error `name`
 * and Next.js's `digest` (a hash the framework attaches and shows to the user),
 * which is enough to correlate a user report with a server log line and nothing
 * more.
 */

const log = createLogger("error");

export type ErrorReportInput = {
  /** Next.js error digest, when the boundary passes one through. */
  digest?: string;
  /** Where the error was caught, e.g. "route:app/documents". */
  scope?: string;
  /** Extra, non-sensitive fields (already action-typed, never raw payloads). */
  context?: Record<string, unknown>;
};

export type ErrorReport = {
  /** Stable handle to quote in a support ticket / search a log sink for. */
  correlationId: string;
  name: string;
  digest?: string;
};

function errorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "UnknownError";
}

function isDevelopment(): boolean {
  try {
    return (
      typeof process !== "undefined" && process.env.NODE_ENV === "development"
    );
  } catch {
    return false;
  }
}

function detailFor(error: unknown): { message?: string; stack?: string } {
  if (!isDevelopment()) return {};
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

/**
 * Report an unexpected error. Never throws (a failing reporter must not mask the
 * original failure) and never returns the raw error, so a caller cannot
 * accidentally forward internals to the client.
 */
export function reportError(
  error: unknown,
  input: ErrorReportInput = {},
): ErrorReport {
  const name = errorName(error);
  const digest =
    input.digest ??
    (typeof error === "object" && error !== null && "digest" in error
      ? ((error as { digest?: unknown }).digest as string | undefined)
      : undefined);

  const correlationId = digest ?? name;

  try {
    log.error("Unhandled error", {
      scope: input.scope,
      digest,
      name,
      ...detailFor(error),
      ...(input.context ?? {}),
    });
  } catch {
    // Logging must never turn a handled error into an unhandled one.
  }

  return { correlationId, name, ...(digest ? { digest } : {}) };
}
