import type { ActionResult } from "@/lib/errors";

/**
 * Shared failure helpers for Server Actions.
 *
 * Every action in this directory returns an `ActionResult` instead of throwing,
 * and must never reveal whether a tenant/resource exists to a caller who is not
 * authorized for it. Centralising the two shapes that were previously copied
 * into each action file keeps the wording identical and makes the generic-data
 * position explicit (`ActionResult<never>` is assignable to every
 * `ActionResult<T>`).
 */

type FlattenableError = {
  flatten: () => { fieldErrors: Record<string, string[] | undefined> };
};

function isFlattenableError(error: unknown): error is FlattenableError {
  return (
    typeof error === "object" &&
    error !== null &&
    "flatten" in error &&
    typeof (error as FlattenableError).flatten === "function"
  );
}

/**
 * Authorization denial. The real reason (non-member, wrong role, inactive
 * tenant, forged tenant id) is logged server-side only; the client always gets
 * the same generic message so failures cannot be used to probe other tenants.
 */
export function authorizationFailure(
  error: unknown,
  context: string,
): ActionResult<never> {
  console.error(`[${context}] authorization denied`, error);
  return {
    success: false,
    error: "You are not permitted to perform this action.",
    code: "FORBIDDEN",
  };
}

/** Validation denial, carrying flattened per-field messages for forms. */
export function invalidInput(
  error: unknown,
  message = "Invalid input.",
): ActionResult<never> {
  const fieldErrors = isFlattenableError(error)
    ? (error.flatten().fieldErrors as Record<string, string[]>)
    : undefined;

  return {
    success: false,
    error: message,
    code: "VALIDATION_ERROR",
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}
