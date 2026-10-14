/**
 * Hostname routing utilities for AmisiBiz tenant subdomains.
 *
 * The production base domain is configurable (never hardcoded): set
 * `APP_BASE_DOMAIN` (server) / `NEXT_PUBLIC_APP_BASE_DOMAIN` (client). Tenant
 * workspaces are then served from `<slug>.<baseDomain>` (e.g.
 * `acme.amisigenuine.com`).
 */

/** Subdomains that must never be claimed by a tenant workspace. */
export const RESERVED_SUBDOMAINS: readonly string[] = [
  "www",
  "app",
  "admin",
  "api",
  "auth",
  "account",
  "accounts",
  "mail",
  "smtp",
  "email",
  "static",
  "assets",
  "cdn",
  "img",
  "images",
  "docs",
  "status",
  "support",
  "help",
  "billing",
  "dashboard",
  "platform",
  "login",
  "logout",
  "register",
  "signin",
  "signup",
  "verify",
  "reset",
  "test",
  "staging",
  "dev",
  "demo",
  "localhost",
];

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Returns the configured base domain (lower-cased, port stripped) or null. */
export function getBaseDomain(): string | null {
  const raw =
    process.env.APP_BASE_DOMAIN ??
    process.env.NEXT_PUBLIC_APP_BASE_DOMAIN ??
    "";
  const domain = normalizeHost(raw);
  return domain.length > 0 ? domain : null;
}

/** Lower-cases a host, strips any port and a trailing dot. */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return "";
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

export function isReservedSubdomain(subdomain: string): boolean {
  return RESERVED_SUBDOMAINS.includes(normalizeHost(subdomain));
}

/** Validates a workspace slug (format + reserved names). */
export function isValidSlug(slug: string): boolean {
  if (typeof slug !== "string") return false;
  const value = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(value)) return false;
  return !isReservedSubdomain(value);
}

/**
 * Extracts a tenant subdomain from a host relative to the base domain.
 * Returns null when the host is the base domain itself, is not under the base
 * domain, or uses a multi-label prefix (e.g. "a.b.base").
 */
export function extractSubdomain(
  host: string,
  baseDomain: string | null = getBaseDomain(),
): string | null {
  const normalized = normalizeHost(host);
  if (!normalized || !baseDomain) return null;
  if (normalized === baseDomain) return null;
  const suffix = `.${baseDomain}`;
  if (!normalized.endsWith(suffix)) return null;
  const prefix = normalized.slice(0, -suffix.length);
  if (!prefix || prefix.includes(".")) return null;
  return prefix;
}

/** Builds the canonical workspace hostname for a slug. */
export function buildTenantHostname(
  slug: string,
  baseDomain: string | null = getBaseDomain(),
): string | null {
  if (!baseDomain) return null;
  return `${slug}.${baseDomain}`;
}

/**
 * Resolves the effective request host.
 *
 * Forwarded-host headers are attacker-controllable and are therefore IGNORED
 * unless the deployment explicitly declares a trusted proxy (`TRUST_PROXY`).
 */
export function resolveRequestHost(input: {
  host: string | null | undefined;
  forwardedHost?: string | null;
  trustProxy?: boolean;
}): string {
  const trustProxy = input.trustProxy ?? process.env.TRUST_PROXY === "true";
  if (trustProxy && input.forwardedHost) {
    const first = input.forwardedHost.split(",")[0];
    return normalizeHost(first);
  }
  return normalizeHost(input.host);
}
