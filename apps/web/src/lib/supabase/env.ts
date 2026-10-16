/**
 * @deprecated Supabase auth has been removed. Authentication is now handled
 * entirely via Neon PostgreSQL + bcrypt + HMAC-signed HTTP-only cookie sessions.
 *
 * This file is kept as a tombstone. Nothing in the live codebase imports it.
 */

/** @deprecated No-op. */
export const SUPABASE_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
} as const;

/** @deprecated No-op. Always throws. */
export function getSupabaseUrl(): string {
  throw new Error("Supabase has been removed.");
}

/** @deprecated No-op. Always throws. */
export function getSupabasePublishableKey(): string {
  throw new Error("Supabase has been removed.");
}

/** @deprecated No-op. Always throws. */
export function getSupabaseSecretKey(): string {
  throw new Error("Supabase has been removed.");
}
