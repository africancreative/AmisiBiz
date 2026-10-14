import { createClient } from "@supabase/supabase-js";
import { getSupabaseSecretKey, getSupabaseUrl } from "./env";

/**
 * Administrative client authenticated with the project secret key
 * (`SUPABASE_SECRET_KEY`, server-only). Used exclusively for GoTrue admin
 * operations: session revocation, metadata (session-version claim) sync and
 * account bootstrap in the seed.
 *
 * NEVER import this module into anything reachable from a client bundle —
 * the web app re-exports it from `src/lib/supabase/server.ts`, which carries
 * the `server-only` build-time guard; mobile and desktop bundles must never
 * embed the secret key (constitution: no privileged credentials in
 * client-side bundles).
 */
export function createAdminSupabase() {
  return createClient(getSupabaseUrl(), getSupabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
