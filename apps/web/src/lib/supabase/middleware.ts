import { createServerClient } from "@supabase/ssr";
import type { CookieOptionsWithName } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import {
  getSupabasePublishableKey,
  getSupabaseUrl,
  SUPABASE_COOKIE_OPTIONS,
} from "./env";

/** A cookie the Supabase client wants to persist, with serialization options. */
export type SupabaseCookieToSet = {
  name: string;
  value: string;
  options: CookieOptionsWithName;
};

/**
 * Sink invoked by the middleware client whenever Supabase rotates the session.
 * The middleware owns response construction (it must also run i18n and route
 * gating), so instead of binding the client to a single response we hand the
 * cookies back to the caller.
 */
export type MiddlewareCookieSink = (
  cookiesToSet: SupabaseCookieToSet[],
  headersToSet: Record<string, string>,
) => void;

/**
 * Supabase client for `src/middleware.ts`.
 *
 * Must NOT import `server-only`: middleware bundles do not run under the
 * React Server Components condition, so that guard would throw at runtime.
 * This module therefore never references `SUPABASE_SECRET_KEY` either — the
 * middleware only ever carries the publishable key.
 */
export function createMiddlewareSupabase(
  request: NextRequest,
  onCookieWrite: MiddlewareCookieSink,
) {
  return createServerClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    cookieOptions: { ...SUPABASE_COOKIE_OPTIONS },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headersToSet) {
        onCookieWrite(cookiesToSet, headersToSet ?? {});
      },
    },
  });
}

/**
 * True when the request carries a Supabase auth cookie. Anonymous visitors
 * can skip the network-bound `getUser()` round trip in the middleware.
 */
export function hasSupabaseAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some(
      (cookie) =>
        cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token"),
    );
}
