/**
 * Shared, typed error-handling conventions for AmisiBiz.
 *
 * Every Server Action returns an `ActionResult` instead of throwing to the
 * client, so failures carry a stable machine-readable `code` plus a
 * human-readable `error` and optional per-field messages for form rendering.
 */

export type ActionErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export type ActionResult<T = void> =
  | { success: true; data?: T | undefined }
  | {
      success: false;
      error: string;
      code?: ActionErrorCode;
      fieldErrors?: Record<string, string[]>;
    };

/** Base class for expected, user-safe application errors. */
export class AppError extends Error {
  readonly code: ActionErrorCode;

  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Build a successful action result. */
export function ok<T = void>(data?: T): ActionResult<T> {
  return { success: true, data };
}

/** Build a failed action result. */
export function fail(
  error: string,
  options?: { code?: ActionErrorCode; fieldErrors?: Record<string, string[]> },
): ActionResult<never> {
  return {
    success: false,
    error,
    ...(options?.code ? { code: options.code } : {}),
    ...(options?.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
  };
}

/**
 * Converts any thrown value into a safe `ActionResult`, logging unexpected
 * errors server-side without leaking internals to the client.
 */
export function toActionResult(
  error: unknown,
  fallbackMessage = "Something went wrong. Please try again later.",
  context?: string,
): ActionResult<never> {
  if (isAppError(error)) {
    return fail(error.message, { code: error.code });
  }
  console.error(context ? `[${context}] ${String(error)}` : "[action]", error);
  return fail(fallbackMessage, { code: "INTERNAL" });
}

/**
 * Extracts flattened field errors from a ZodError in a stable shape suitable
 * for rendering next to inputs.
 */
export function zodFieldErrors(error: {
  flatten: () => { fieldErrors: unknown };
}): Record<string, string[]> {
  return error.flatten().fieldErrors as Record<string, string[]>;
}
