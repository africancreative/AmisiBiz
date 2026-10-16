import { NextResponse, type NextRequest } from "next/server";
import { sanitizeAppPath } from "@/lib/auth/redirects";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = sanitizeAppPath(searchParams.get("next"), "/en/dashboard");
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;
  return NextResponse.redirect(new URL(next, baseUrl));
}
