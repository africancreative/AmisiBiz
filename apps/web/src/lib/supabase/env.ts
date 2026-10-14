/**
 * Supabase environment accessors and shared cookie options.
 *
 * The accessors live in `@amisibiz/database` (validated, lazy, shared with
 * every server-side surface); they are re-exported here so existing imports
 * keep one entry point. `NEXT_PUBLIC_*` values are browser-safe by design.
 * `SUPABASE_SECRET_KEY` is a server-only credential: it must never be
 * referenced from a client module — the secret-key client lives in
 * `server.ts`, guarded by the `server-only` import so a client import fails
 * at build time.
 */
export {
  getSupabasePublishableKey,
  getSupabaseSecretKey,
  getSupabaseUrl,
} from "@amisibiz/database";

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
