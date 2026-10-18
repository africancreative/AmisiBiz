import type { ActionErrorCode } from "@/lib/errors";

/**
 * Errors raised by the contacts operation services (merge / import / export).
 *
 * Mirrors `DocumentServiceError` exactly — same code vocabulary, same mapping
 * onto the shared `ActionResult` codes — so the Server Actions in
 * `actions/contact.ts` can translate a service failure without leaking why an
 * authorization or tenant-isolation check failed.
 */
export type ContactServiceErrorCode =
  "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN";

export class ContactServiceError extends Error {
  readonly code: ContactServiceErrorCode;
  readonly field: string | undefined;

  constructor(code: ContactServiceErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ContactServiceError";
    this.code = code;
    this.field = field;
  }
}

/** Maps a contacts-service error onto the shared action error vocabulary. */
export function contactErrorActionCode(
  code: ContactServiceErrorCode,
): ActionErrorCode {
  switch (code) {
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "CONFLICT":
      return "CONFLICT";
    case "VALIDATION":
      return "VALIDATION_ERROR";
  }
}
