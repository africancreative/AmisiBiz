import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getSupabasePublishableKey, getSupabaseUrl } from "@/lib/supabase/env";
import {
  resolveVerifiedSession,
  type AppSessionUser,
} from "@/lib/auth/session-user";

/**
 * Session resolution for installed shells (Capacitor Android, Tauri Windows),
 * which cannot carry the web app's auth cookie and instead send
 * `Authorization: Bearer <user access token>`.
 *
 * This is not a second trust chain. Step 1 differs — the token arrives as a
 * header rather than a cookie, so it is verified with `getUser(token)` instead
 * of `getUser()` — and steps 2-3 are the *same function* the cookie path uses
 * (`resolveVerifiedSession`), which is also the function that opens the RLS
 * scope. A caller holding a token that GoTrue accepts but whose
 * `amisibiz_session_version` claim is stale is refused here exactly as they are
 * on the web.
 *
 * The publishable ("anon") key is used, never the secret key: this client
 * carries only the caller's own token.
 */

/** Extracts the token from `Authorization: Bearer …`, or null. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Resolves the caller's session from the request's bearer token, or null when
 * the header is absent, malformed, or the token does not survive verification.
 */
export async function getBearerSessionUser(
  request: Request,
): Promise<AppSessionUser | null> {
  const token = readBearerToken(request);
  if (!token) return null;

  const supabase = createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  return resolveVerifiedSession(data.user, token);
}
