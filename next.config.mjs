import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/lib/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  // i18n handled by next-intl middleware + plugin
  // NOTE: `experimental.typedRoutes` is intentionally disabled — locale-prefixed
  // dynamic hrefs (e.g. `/${locale}/dashboard`) are not expressible as typed
  // routes without casting at every call site.
};

export default withNextIntl(nextConfig);
