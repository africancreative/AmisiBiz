/**
 * Web application environment (app-shell scope).
 *
 * Database and Supabase credentials are validated in `@amisibiz/database`;
 * this module owns the remaining app-shell variables. Same contract: access
 * is lazy (importing is always safe) and every failure names the exact
 * variable.
 */

/**
 * Origin for absolute links (metadata, auth email redirects), trailing
 * slashes removed; null when unset outside production.
 *
 * Local development may omit it. In production an unset value is a
 * deployment misconfiguration and throws — the app never silently guesses a
 * production origin (wrong absolute links break auth emails and metadata).
 */
export function getAppUrlOrNull(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    process.env.VERCEL_URL?.trim();
  if (vercel) {
    const prefixed =
      vercel.startsWith("http://") || vercel.startsWith("https://")
        ? vercel
        : `https://${vercel}`;
    return prefixed.replace(/\/+$/, "");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not configured. Set it to the deployed origin (e.g. https://app.amisigenuine.com) — production never guesses its own origin.",
    );
  }
  return null;
}

/** Display name used in metadata and product surfaces. */
export function getAppName(): string {
  return process.env.NEXT_PUBLIC_APP_NAME?.trim() || "AmisiBiz";
}

/**
 * Policy gate: when true, only email-confirmed accounts may hold a session.
 * Off until email delivery is verified (see .env.example).
 */
export function emailVerificationRequired(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
}

/** Secret used for signing session cookies and tokens. */
export function getAuthSecret(): string {
  const explicit = process.env.AUTH_SECRET?.trim();
  if (explicit) return explicit;

  // Fallbacks on hosted platforms where database credentials exist
  const fallback =
    process.env.NEON_REALTIME_SECRET?.trim() ||
    process.env.POSTGRES_PASSWORD?.trim() ||
    process.env.PGPASSWORD?.trim();
  if (fallback) return fallback;

  return "amisibiz-development-secret-min-32-chars-long";
}
