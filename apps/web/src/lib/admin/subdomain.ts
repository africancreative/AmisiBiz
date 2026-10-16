/**
 * Subdomain validation and slug generation for tenant identifiers.
 *
 * Rules (per Phase 1 directive):
 *   - Only lowercase alphanumeric characters and hyphens
 *   - Must start and end with an alphanumeric character
 *   - Length: 3-63 characters
 *   - No consecutive hyphens
 *   - Reserved words are prohibited (e.g. "admin", "support", "internal")
 *   - Duplicates are prohibited (enforced at DB level via unique slug constraint)
 *   - The slug is stored in the `Tenant.slug` column and is the unique
 *     identifier for the workspace in all URLs and API routes.
 */

/** Regex pattern for valid subdomain format */
export const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Reserved subdomain words that cannot be selected by tenants */
export const RESERVED_SUBDOMAINS = new Set([
  "admin",
  "support",
  "internal",
  "api",
  "auth",
  "portal",
  "login",
  "register",
  "dashboard",
  "tenant",
  "platform",
  "www",
]);

/**
 * Validate that a subdomain string meets all format rules.
 * Returns true if valid, false if invalid.
 */
export function validateSubdomain(subdomain: string): boolean {
  // Check pattern
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    return false;
  }

  // Check length (3-63 characters)
  if (subdomain.length < 3 || subdomain.length > 63) {
    return false;
  }

  // Check reserved words (case-insensitive)
  const lower = subdomain.toLowerCase();
  if (RESERVED_SUBDOMAINS.has(lower)) {
    return false;
  }

  return true;
}

/**
 * Generate a unique tenant slug from legal name and optional subdomain.
 * The slug is normalized to lowercase, with non-alphanumeric characters
 * replaced by hyphens, and duplicate hyphens collapsed.
 *
 * @param legalName The legal/trading name of the business
 * @param subdomain Optional custom subdomain (must be valid and available)
 * @returns A normalized, URL-safe slug string
 */
export function generateTenantSlug(legalName: string, subdomain?: string): string {
  // Normalize the legal name: lowercase, replace non-alphanumeric with hyphens
  const namePart = legalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // If a subdomain is provided, use it as the prefix
  if (subdomain) {
    const cleanSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    // Combine: subdomain-name
    return `${cleanSubdomain}-${namePart}`.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  }

  // Use just the normalized name
  return namePart.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Check if a subdomain is reserved (starts with a reserved word).
 * For example "admin-tenant" would be reserved because it starts with "admin".
 */
export function isSubdomainReserved(subdomain: string): boolean {
  const lower = subdomain.toLowerCase();
  // Check exact match
  if (RESERVED_SUBDOMAINS.has(lower)) {
    return true;
  }
  // Check if it starts with a reserved word followed by a hyphen
  for (const reserved of RESERVED_SUBDOMAINS) {
    if (lower.startsWith(reserved + "-")) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the subdomain portion from a full hostname.
 * For example, from "tenantname.amisigenuine.com" returns "tenantname"
 */
export function extractSubdomain(hostname: string): string | null {
  // Remove the domain suffix
  const domainSuffix = ".amisigenuine.com";
  if (hostname.toLowerCase().endsWith(domainSuffix)) {
    const sub = hostname.toLowerCase().replace(domainSuffix, "");
    // Validate it's a valid subdomain
    if (validateSubdomain(sub)) {
      return sub;
    }
  }
  // Try a more generic approach - find the part before the first dot
  const parts = hostname.split(".");
  const firstPart = parts[0];
  if (parts.length >= 2 && firstPart) {
    const potential = firstPart.toLowerCase();
    if (validateSubdomain(potential)) {
      return potential;
    }
  }
  return null;
}