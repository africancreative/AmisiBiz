import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  getSupabasePublishableKey,
  getSupabaseUrl,
  SUPABASE_COOKIE_OPTIONS,
} from "./env";

/**
 * Administrative client re-exported from the shared database package.
 *
 * The re-export runs under this module's `server-only` guard, so a client
 * bundle importing the admin factory still fails the build (the constitution
 * forbids privileged credentials in browser or mobile bundles).
 */
export { createAdminSupabase } from "@amisibiz/database";

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
