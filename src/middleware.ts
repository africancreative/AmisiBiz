import createMiddleware from "next-intl/middleware";
import { auth } from "@/lib/auth/config";
import { routing } from "@/lib/i18n/routing";
import {
  extractSubdomain,
  getBaseDomain,
  isReservedSubdomain,
  resolveRequestHost,
} from "@/lib/tenancy/host";
import { NextResponse } from "next/server";

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

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Let Next.js handle internal routes and known static assets only.
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/health") ||
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
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
    });
    const subdomain = extractSubdomain(host, baseDomain);
    if (subdomain && isReservedSubdomain(subdomain)) {
      return new NextResponse("Not found", { status: 404 });
    }
  }

  // Apply i18n routing first
  const i18nResponse = i18nMiddleware(req);

  // Session is provided by the Auth.js middleware wrapper
  const session = req.auth;

  const locale = pathname.split("/")[1] ?? "en";
  const isAuthenticated = !!session?.user?.id;

  // Redirect unauthenticated users away from protected routes
  if (isProtectedRoute(pathname) && !isAuthenticated) {
    const loginUrl = new URL(`/${locale}/login`, req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from auth-only routes
  if (isAuthOnlyRoute(pathname) && isAuthenticated) {
    return NextResponse.redirect(new URL(`/${locale}/dashboard`, req.url));
  }

  return i18nResponse;
});

export const config = {
  // Run middleware on the Node.js runtime: the Auth.js session callback reads
  // from the database (user status re-check), which is not supported on Edge.
  runtime: "nodejs",
  // Match all pathnames except static assets and api/auth
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/|api/auth).*)"],
};
