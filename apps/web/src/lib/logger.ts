import { redactValue } from "@/lib/redaction";

/**
 * Structured, redacting application logger.
 *
 * Why not `console.log`: the constitution requires that no secret or
 * unnecessary PII reaches a log sink. A logger gives that rule one enforcement
 * point instead of relying on every call site to remember it.
 *
 * The module is isomorphic on purpose. A client error boundary and a Server
 * Action must share the exact same redaction rule (and the same shape of output)
 * or an incident cannot be followed across the two. It therefore imports nothing
 * server-only — only the pure `redaction` helper.
 *
 * Output shape:
 *  - production: one JSON object per line, so a log platform can index `level`,
 *    `scope` and `digest` without a regex;
 *  - everywhere else: a readable `[scope] message` line followed by the
 *    (already redacted) context, which is what a developer wants in a terminal.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export type Logger = {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  /** A logger whose scope is `"<parent>:<child>"`, for sub-components. */
  child: (scope: string) => Logger;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function readEnv(key: string): string | undefined {
  // `process` is inlined by the bundler for the values Next.js exposes, and is
  // absent only in a bare browser context — where the lookup must not throw.
  try {
    return typeof process !== "undefined" ? process.env[key] : undefined;
  } catch {
    return undefined;
  }
}

function minimumLevel(): LogLevel {
  const configured = readEnv("LOG_LEVEL")?.toLowerCase();
  if (
    configured === "debug" ||
    configured === "info" ||
    configured === "warn" ||
    configured === "error"
  ) {
    return configured;
  }
  // Chatty in development, quiet in production. `log.warn`/`log.error` always
  // pass; `log.debug` is the one that disappears on a deployed build.
  return readEnv("NODE_ENV") === "production" ? "info" : "debug";
}

function isProduction(): boolean {
  return readEnv("NODE_ENV") === "production";
}

/** `console` methods are the transport; the shape is what this module owns. */
function emit(
  level: LogLevel,
  scope: string,
  message: string,
  context?: LogContext,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel()]) return;

  const safeContext =
    context && Object.keys(context).length > 0
      ? (redactValue(context) as LogContext)
      : undefined;

  const sink = level === "debug" ? console.debug : console[level];

  if (isProduction()) {
    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      scope,
      message,
    };
    if (safeContext) record.context = safeContext;
    sink(JSON.stringify(record));
    return;
  }

  if (safeContext) {
    sink(`[${scope}] ${message}`, safeContext);
  } else {
    sink(`[${scope}] ${message}`);
  }
}

/**
 * Create a logger bound to a scope (the feature area an event belongs to).
 * Always create one per module rather than passing a scope string at each call:
 * it keeps the strings consistent and greppable.
 */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, context) => emit("debug", scope, message, context),
    info: (message, context) => emit("info", scope, message, context),
    warn: (message, context) => emit("warn", scope, message, context),
    error: (message, context) => emit("error", scope, message, context),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

/** Root logger for one-off events that do not belong to a feature module. */
export const logger = createLogger("app");
