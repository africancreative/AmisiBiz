/**
 * Stub for `next/headers` under Vitest.
 *
 * `cookies()` requires a live Next.js request scope that unit tests do not
 * have — throw loudly if anything calls it without an explicit module mock.
 * `headers()` returns an empty Headers, matching the inline mock used by
 * action tests.
 */
export function cookies(): never {
  throw new Error(
    "next/headers cookies() is not available in unit tests — mock the calling module instead",
  );
}

export function headers(): Headers {
  return new Headers();
}
