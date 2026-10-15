import type { ActionErrorCode } from "@/lib/errors";

/**
 * Errors raised by the document engine.
 *
 * The engine is called from Server Actions and from API route handlers, and
 * both need the same thing: a stable, machine-readable reason that maps onto the
 * shared `ActionResult` codes without leaking why an authorization check failed.
 * `field` is present only for a genuine input problem, so a form can point at the
 * offending row.
 */
export type DocumentServiceErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IMMUTABLE"
  | "ILLEGAL_TRANSITION"
  | "NUMBERING"
  | "FORBIDDEN";

export class DocumentServiceError extends Error {
  readonly code: DocumentServiceErrorCode;
  readonly field: string | undefined;

  constructor(code: DocumentServiceErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DocumentServiceError";
    this.code = code;
    this.field = field;
  }
}

/** Maps an engine error onto the shared action error vocabulary. */
export function documentErrorActionCode(
  code: DocumentServiceErrorCode,
): ActionErrorCode {
  switch (code) {
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "IMMUTABLE":
    case "ILLEGAL_TRANSITION":
    case "CONFLICT":
      return "CONFLICT";
    case "NUMBERING":
      return "INTERNAL";
    case "VALIDATION":
      return "VALIDATION_ERROR";
  }
}
