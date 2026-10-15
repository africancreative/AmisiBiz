import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import type { AppSessionUser } from "@amisibiz/auth";

/**
 * A request-scoped override of the *cookie* session, for the one surface that
 * cannot use cookies: the sync API, which an installed shell calls with an
 * `Authorization: Bearer` header.
 *
 * The directive requires the installed-shell trust chain to be **factored, not
 * duplicated** (offline-client design §6). This file is the factoring seam: the
 * bearer route verifies the token exactly as the cookie path does
 * (`resolveVerifiedSession`), then runs the rest of the request inside
 * `runWithRequestSession`, so the Server Actions the sync service delegates to
 * see the same actor through the same `getSessionUser()` they always call.
 *
 * It is deliberately narrow:
 * - The value can only be a session that already passed token validation and the
 *   session-version check — a raw user id is not accepted here.
 * - Outside a `runWithRequestSession` scope the store is undefined and
 *   `getSessionUser()` falls through to cookies, so nothing about the web app
 *   changes.
 * - Nothing in the browser can reach it: the module is `server-only`.
 */
type RequestSessionStore = { readonly user: AppSessionUser | null };

const storage = new AsyncLocalStorage<RequestSessionStore>();

/**
 * The override for the current request, or `undefined` when this request is not
 * running inside `runWithRequestSession`. `undefined` and `null` are different
 * answers: `null` means "a bearer scope is active and it resolved nobody", which
 * must not fall back to cookies.
 */
export function currentRequestSessionUser(): AppSessionUser | null | undefined {
  const store = storage.getStore();
  return store ? store.user : undefined;
}

/** Runs `fn` with `user` as the session `getSessionUser()` will resolve. */
export function runWithRequestSession<T>(
  user: AppSessionUser | null,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ user }, fn);
}
