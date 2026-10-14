import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import {
  getSupabasePublishableKey,
  getSupabaseSecretKey,
  getSupabaseUrl,
  SUPABASE_COOKIE_OPTIONS,
} from "./env";

/**
 * Request-scoped Supabase client for Server Components, Server Actions and
 * Route Handlers. Never share an instance across requests — the session is
 * read from (and written to) the incoming request's cookies.
 *
 * Security notes:
 * - The secret key is NEVER used here; this client only ever carries the
 *   publishable key and the user's own session.
 * - Cookie writes are best-effort: in a Server Component render the cookie
 *   store is read-only. Middleware performs the authoritative token refresh on
 *   every request, so a failed write here cannot strand the session.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    cookieOptions: { ...SUPABASE_COOKIE_OPTIONS },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Component render: cookies are read-only. The middleware
          // refresh path persists the rotated session on this response.
        }
      },
    },
  });
}

/**
 * Administrative client authenticated with the project secret key
 * (`SUPABASE_SECRET_KEY`, server-only). Used exclusively for GoTrue admin
 * operations: session revocation, metadata (session-version claim) sync and
 * account bootstrap in the seed.
 *
 * Never import this into anything reachable from a client bundle — the
 * `server-only` guard at the top of this module enforces that at build time.
 */
export function createAdminSupabase() {
  return createClient(getSupabaseUrl(), getSupabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
