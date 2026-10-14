import { routing } from "@/lib/i18n/routing";

/**
 * Sanitises a redirect target received from an email link (`?next=...`).
 *
 * Only same-app absolute paths inside one of the configured locales are
 * accepted — anything else (absolute URLs, protocol-relative `//host` paths,
 * backslash tricks, control characters) falls back to the caller's default.
 * This is the only barrier against open-redirect abuse on the auth callback.
 */
export function sanitizeAppPath(
  candidate: string | null | undefined,
  fallback: string,
): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//") || candidate.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;

  const isLocalized = routing.locales.some(
    (locale) =>
      candidate === `/${locale}` || candidate.startsWith(`/${locale}/`),
  );
  if (!isLocalized) return fallback;

  return candidate;
}
