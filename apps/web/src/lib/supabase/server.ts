import "server-only";

/**
 * @deprecated Supabase auth has been removed. Authentication is now handled
 * entirely via Neon PostgreSQL + bcrypt + HMAC-signed HTTP-only cookie sessions.
 *
 * This file is kept as a tombstone. Nothing in the live codebase imports it.
 */

/** @deprecated No-op — Supabase server client removed. */
export async function createServerSupabase(): Promise<never> {
  throw new Error(
    "createServerSupabase: Supabase auth has been removed. Use getSessionUser() from @/lib/auth/session-user instead.",
  );
}

/** @deprecated No-op — Supabase admin client removed. */
export function createAdminSupabase(): never {
  throw new Error(
    "createAdminSupabase: Supabase auth has been removed. Manage users directly via Prisma.",
  );
}
