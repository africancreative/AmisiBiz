import { NextResponse, type NextRequest } from "next/server";
import { sanitizeAppPath } from "@/lib/auth/redirects";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  verifyPasswordResetToken,
} from "@/lib/auth/token";
import { bootstrapScope, prisma, runInScope } from "@amisibiz/database";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;
  const type = searchParams.get("type");
  const token = searchParams.get("token");

  // Recovery flow: consume password reset token and establish session
  if (type === "recovery" || (token && !type)) {
    const rawNext = searchParams.get("next") || "/en/reset-password";
    const next = sanitizeAppPath(rawNext, "/en/reset-password");

    if (!token) {
      return NextResponse.redirect(new URL(next, baseUrl));
    }

    const payload = await verifyPasswordResetToken(token);
    if (!payload) {
      // Invalid or expired signature
      return NextResponse.redirect(new URL(next, baseUrl));
    }

    // Verify user status and revocation version
    const user = await runInScope(bootstrapScope(), () =>
      prisma.user.findUnique({
        where: { id: payload.userId },
        select: {
          id: true,
          status: true,
          sessionVersion: true,
          platformRole: true,
        },
      }),
    );

    if (
      !user ||
      user.status !== "ACTIVE" ||
      user.sessionVersion !== payload.sessionVersion
    ) {
      // User deleted, suspended, or token already used (sessionVersion incremented)
      return NextResponse.redirect(new URL(next, baseUrl));
    }

    // Establish authenticated recovery session
    const sessionToken = await createSessionToken({
      userId: user.id,
      sessionVersion: user.sessionVersion,
      platformRole: user.platformRole,
    });

    const response = NextResponse.redirect(new URL(next, baseUrl));
    response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });

    return response;
  }

  const next = sanitizeAppPath(searchParams.get("next"), "/en/dashboard");
  return NextResponse.redirect(new URL(next, baseUrl));
}
