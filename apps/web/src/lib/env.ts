/**
 * Web application environment (app-shell scope).
 *
 * Database connection variables are validated in `@amisibiz/database`; this
 * module owns the remaining app-shell variables. Same contract: access is lazy
 * (importing is always safe) and every failure names the exact variable.
 */

/** Development-only placeholder session secret. Never accepted in production. */
const DEV_AUTH_SECRET = "amisibiz-development-secret-min-32-chars-long";

/** Minimum accepted length for `AUTH_SECRET` (characters). */
export const AUTH_SECRET_MIN_LENGTH = 32;

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
      "NEXT_PUBLIC_APP_URL is not configured. Set NEXT_PUBLIC_APP_URL in your production environment variables (e.g. https://app.amisigenuine.com).",
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

/**
 * Secret used for signing session cookies and tokens.
 *
 * Only an explicit `AUTH_SECRET` (min 32 chars) is accepted. In production a
 * missing or short secret refuses to boot; outside production a fixed
 * development placeholder keeps local setup frictionless — sessions signed
 * with it are worthless outside the developer's machine. There are NO hosting
 * alias fallbacks (NEXTAUTH_SECRET / JWT_SECRET) and the secret is never
 * derived from database credentials: a signing key must stay independent of
 * infrastructure secrets that rotate or leak together.
 */
export function getAuthSecret(): string {
  const explicit = process.env.AUTH_SECRET?.trim();
  if (explicit) {
    if (explicit.length < AUTH_SECRET_MIN_LENGTH) {
      throw new Error(
        `AUTH_SECRET is too short: must be at least ${AUTH_SECRET_MIN_LENGTH} characters.`,
      );
    }
    return explicit;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `AUTH_SECRET is not configured. Set AUTH_SECRET (at least ${AUTH_SECRET_MIN_LENGTH} characters) in your environment variables.`,
    );
  }

  return DEV_AUTH_SECRET;
}
