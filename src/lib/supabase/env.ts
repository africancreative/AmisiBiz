/**
 * Supabase environment accessors and shared cookie options.
 *
 * `NEXT_PUBLIC_*` values are browser-safe by design. `SUPABASE_SECRET_KEY` is
 * a server-only credential: it must never be referenced from a client module.
 * The secret-key client lives in `server.ts`, which is guarded by the
 * `server-only` import so a client import fails at build time.
 */

export function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.");
  }
  return url;
}

export function getSupabasePublishableKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not configured.");
  }
  return key;
}

export function getSupabaseSecretKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) {
    throw new Error("SUPABASE_SECRET_KEY is not configured.");
  }
  return key;
}

/**
 * Defaults applied to every Supabase auth cookie written by a server client.
 *
 * - `httpOnly` — the browser never reads tokens with JavaScript; all Supabase
 *   calls happen server-side through `@supabase/ssr` clients.
 * - `sameSite: "lax"` — cookies are not sent on cross-site POSTs (CSRF surface
 *   reduction) while still surviving top-level navigations (needed for the
 *   email-link callback).
 * - `secure` in production only, so plain-HTTP local development works.
 */
export const SUPABASE_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
} as const;
