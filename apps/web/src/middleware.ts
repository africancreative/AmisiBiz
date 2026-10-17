import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/lib/i18n/routing";
import { verifySessionToken } from "@/lib/auth/token";
import {
  extractSubdomain,
  getBaseDomain,
  isReservedSubdomain,
  resolveRequestHost,
} from "@/lib/tenancy/host";

const i18nMiddleware = createMiddleware(routing);

// Routes that require authentication
const protectedRoutePatterns = [
  /^\/[a-z]{2}\/app(\/|$)/,
  /^\/[a-z]{2}\/admin(\/|$)/,
  /^\/[a-z]{2}\/dashboard/,
  /^\/[a-z]{2}\/settings/,
  /^\/[a-z]{2}\/team/,
  /^\/[a-z]{2}\/invoices/,
  /^\/[a-z]{2}\/crm/,
  /^\/[a-z]{2}\/inventory/,
  /^\/[a-z]{2}\/hr/,
  /^\/[a-z]{2}\/payroll/,
  /^\/[a-z]{2}\/purchasing/,
  /^\/[a-z]{2}\/accounting/,
  /^\/[a-z]{2}\/reports/,
  /^\/[a-z]{2}\/documents/,
  /^\/[a-z]{2}\/platform/,
];

// File extensions handled by Next.js as static assets. Only these may skip the
// auth/i18n pipeline — a naive `pathname.includes(".")` check is bypassable
// (e.g. `/en/dashboard.json`).
const STATIC_FILE_EXTENSIONS = [
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".css",
  ".js",
  ".map",
  ".txt",
  ".xml",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
];

// Routes accessible only when NOT authenticated
const authOnlyRoutePatterns = [
  /^\/[a-z]{2}\/login/,
  /^\/[a-z]{2}\/register/,
  /^\/[a-z]{2}\/forgot-password/,
];

function isProtectedRoute(pathname: string): boolean {
  return protectedRoutePatterns.some((pattern) => pattern.test(pathname));
}

function isAuthOnlyRoute(pathname: string): boolean {
  return authOnlyRoutePatterns.some((pattern) => pattern.test(pathname));
}

function isStaticAsset(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return STATIC_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function redirectTo(target: URL): NextResponse {
  return NextResponse.redirect(target);
}

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let Next.js handle internal routes, health checks, the auth callback and
  // known static assets only. (`/auth/callback` must NOT pass through the
  // i18n pipeline — it is not a locale-prefixed route.)
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/auth/") ||
    isStaticAsset(pathname)
  ) {
    return NextResponse.next();
  }

  // Host-based workspace routing. The base domain is configurable (never
  // hardcoded) and forwarded-host headers are only trusted behind an explicit
  // proxy. Requests on a reserved subdomain are rejected outright.
  const baseDomain = getBaseDomain();
  if (baseDomain) {
    const host = resolveRequestHost({
      host: request.headers.get("host"),
      forwardedHost: request.headers.get("x-forwarded-host"),
    });
    const subdomain = extractSubdomain(host, baseDomain);
    if (subdomain && isReservedSubdomain(subdomain)) {
      return new NextResponse("Not found", { status: 404 });
    }
  }

  // Run i18n routing first. For a locale-prefixed request this passes through;
  // otherwise next-intl returns a redirect (e.g. `/` → `/en`).
  const i18nResponse = i18nMiddleware(request);
  const isLocaleRedirect =
    i18nResponse.status >= 300 && i18nResponse.status < 400;

  const token = request.cookies.get("amisibiz_session")?.value;
  const session = token ? await verifySessionToken(token) : null;
  const userId = session?.userId ?? null;

  if (isLocaleRedirect) return i18nResponse;

  // Route gating uses the freshly validated user. Revocation (session-version)
  // enforcement happens in server components/actions — this gate only keeps
  // obviously anonymous traffic out of protected shells.
  const locale = pathname.split("/")[1] ?? "en";

  if (isProtectedRoute(pathname) && !userId) {
    const loginUrl = new URL(`/${locale}/login`, request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return redirectTo(loginUrl);
  }

  if (isAuthOnlyRoute(pathname) && userId) {
    return redirectTo(new URL(`/${locale}/dashboard`, request.url));
  }

  return NextResponse.next({ request });
}

export const config = {
  // Run middleware on the Node.js runtime for database-backed session checks.
  runtime: "nodejs",
  // Match all pathnames except Next.js internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
};
