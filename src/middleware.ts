import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/lib/i18n/routing";
import {
  createMiddlewareSupabase,
  hasSupabaseAuthCookie,
  type SupabaseCookieToSet,
} from "@/lib/supabase/middleware";
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

/** Copies Set-Cookie state from the refresh into a gate redirect. */
function redirectKeepingAuthCookies(
  target: URL,
  cookiesToSet: SupabaseCookieToSet[],
): NextResponse {
  const response = NextResponse.redirect(target);
  cookiesToSet.forEach(({ name, value, options }) => {
    response.cookies.set(name, value, options);
  });
  return response;
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

  // Supabase session refresh. Cookies Supabase rotates are collected here and
  // applied to whichever response we end up returning — never dropped.
  const refreshedCookies: SupabaseCookieToSet[] = [];
  const refreshedHeaders: Record<string, string> = {};
  const supabase = createMiddlewareSupabase(
    request,
    (cookiesToSet, headers) => {
      refreshedCookies.push(...cookiesToSet);
      Object.assign(refreshedHeaders, headers);
    },
  );

  let userId: string | null = null;
  if (hasSupabaseAuthCookie(request)) {
    try {
      const { data } = await supabase.auth.getUser();
      userId = data?.user?.id ?? null;
    } catch (error) {
      // Auth service unreachable/erroring: fail closed (anonymous).
      console.error("[middleware] Supabase getUser failed:", error);
      userId = null;
    }
  }

  // Locale-normalisation redirect: no downstream render happens, so attach any
  // refreshed cookies and return it.
  if (isLocaleRedirect) {
    refreshedCookies.forEach(({ name, value, options }) => {
      i18nResponse.cookies.set(name, value, options);
    });
    Object.keys(refreshedHeaders).forEach((key) => {
      i18nResponse.headers.set(key, refreshedHeaders[key] ?? "");
    });
    return i18nResponse;
  }

  // Route gating uses the freshly validated user. Revocation (session-version)
  // enforcement happens in server components/actions — this gate only keeps
  // obviously anonymous traffic out of protected shells.
  const locale = pathname.split("/")[1] ?? "en";

  if (isProtectedRoute(pathname) && !userId) {
    const loginUrl = new URL(`/${locale}/login`, request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return redirectKeepingAuthCookies(loginUrl, refreshedCookies);
  }

  if (isAuthOnlyRoute(pathname) && userId) {
    return redirectKeepingAuthCookies(
      new URL(`/${locale}/dashboard`, request.url),
      refreshedCookies,
    );
  }

  // Pass-through: build the response AFTER the refresh so the cookies it
  // rotated are also visible to this render (request-override), not only to
  // the next request.
  const response = NextResponse.next({ request });
  refreshedCookies.forEach(({ name, value, options }) => {
    response.cookies.set(name, value, options);
  });
  Object.keys(refreshedHeaders).forEach((key) => {
    response.headers.set(key, refreshedHeaders[key] ?? "");
  });
  return response;
}

export const config = {
  // Run middleware on the Node.js runtime: the Supabase session refresh and
  // @supabase/ssr cookie handling expect the server runtime.
  runtime: "nodejs",
  // Match all pathnames except Next.js internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
};
