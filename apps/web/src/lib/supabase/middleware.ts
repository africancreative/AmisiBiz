/**
 * @deprecated Supabase auth has been removed. Authentication is now handled
 * entirely via Neon PostgreSQL + bcrypt + HMAC-signed HTTP-only cookie sessions.
 *
 * This file is kept as a tombstone to satisfy any lingering TypeScript
 * references. Nothing in the live codebase imports it.
 */

import type { NextRequest } from "next/server";

export type SupabaseCookieToSet = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

export type MiddlewareCookieSink = (
  cookiesToSet: SupabaseCookieToSet[],
  headersToSet: Record<string, string>,
) => void;

/** @deprecated No-op — Supabase middleware client removed. */
export function createMiddlewareSupabase(
  _request: NextRequest,
  _onCookieWrite: MiddlewareCookieSink,
): never {
  throw new Error(
    "createMiddlewareSupabase: Supabase auth has been removed. Use the HMAC cookie session instead.",
  );
}

/** @deprecated Always returns false — Supabase auth cookies no longer exist. */
export function hasSupabaseAuthCookie(_request: NextRequest): boolean {
  return false;
}
