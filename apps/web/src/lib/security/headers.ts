/**
 * Production HTTP security headers for AmisiBiz.
 *
 * Extracted into a typed TypeScript module so both `next.config.mjs` and the
 * test suite can import and assert the exact values without relying on the
 * untyped `.mjs` config file.
 *
 * Content-Security-Policy is NOT set here: Next.js App Router embeds
 * nonce-based inline scripts whose hashes change per-request. A static CSP
 * would either break the runtime or require `unsafe-inline`, defeating its
 * purpose. If a CSP is added in a future phase it must be generated
 * dynamically in middleware and applied via `nextResponse.headers`.
 */

export type SecurityHeader = { key: string; value: string };

/**
 * The full set of security response headers. Applied to every route by
 * `next.config.mjs`; also directly tested in the Agent 01 acceptance suite.
 */
export const SECURITY_HEADERS: readonly SecurityHeader[] = [
  // Prevent browsers from MIME-sniffing the response type.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Deny all framing — the platform admin and tenant app must never be embedded.
  { key: "X-Frame-Options", value: "DENY" },

  // Send only the origin on cross-origin navigations; full URL on same-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Disable legacy XSS auditor (modern browsers ignore it; IE behaviour is to
  // block the page on detection, which is a DoS vector — safer to set to 0).
  { key: "X-XSS-Protection", value: "0" },

  // Opt browsers into HSTS for 2 years. includeSubDomains covers tenant
  // subdomains. preload allows future submission to the HSTS preload list.
  // NOTE: only effective over HTTPS; the header is discarded over plain HTTP.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },

  // Disable client-side DNS prefetching to reduce information leakage.
  { key: "X-DNS-Prefetch-Control", value: "off" },

  // Minimise access to potentially sensitive browser features.
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  },
];
