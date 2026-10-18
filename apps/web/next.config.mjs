import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/lib/i18n/request.ts");

// Security response headers are defined in the typed TypeScript module so
// both this config and the test suite can import and assert the same values.
import { SECURITY_HEADERS } from "./src/lib/security/headers.ts";


/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Shared workspace packages ship TypeScript source (no build step); Next
  // compiles them as part of the app bundle.
  transpilePackages: [
    "@amisibiz/auth",
    "@amisibiz/database",
    "@amisibiz/domain",
    "@amisibiz/documents",
    "@amisibiz/sync",
    "@amisibiz/ui",
  ],
  // i18n handled by next-intl middleware + plugin
  // NOTE: `experimental.typedRoutes` is intentionally disabled — locale-prefixed
  // dynamic hrefs (e.g. `/${locale}/dashboard`) are not expressible as typed
  // routes without casting at every call site.
  async headers() {
    return [
      {
        // Apply to every route including static assets and API handlers.
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
