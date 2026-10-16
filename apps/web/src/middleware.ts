import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/lib/i18n/routing";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/token";
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

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/auth/") ||
    isStaticAsset(pathname)
  ) {
    return NextResponse.next();
  }

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

  const i18nResponse = i18nMiddleware(request);
  const isLocaleRedirect =
    i18nResponse.status >= 300 && i18nResponse.status < 400;

  // Database session check via signed HTTP-only cookie
  let userId: string | null = null;
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie) {
    try {
      const payload = await verifySessionToken(sessionCookie);
      userId = payload?.userId ?? null;
    } catch {
      userId = null;
    }
  }

  if (isLocaleRedirect) {
    return i18nResponse;
  }

  const locale = pathname.split("/")[1] ?? "en";

  if (isProtectedRoute(pathname) && !userId) {
    const loginUrl = new URL(`/${locale}/login`, request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthOnlyRoute(pathname) && userId) {
    return NextResponse.redirect(new URL(`/${locale}/dashboard`, request.url));
  }

  return i18nResponse;
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
};
