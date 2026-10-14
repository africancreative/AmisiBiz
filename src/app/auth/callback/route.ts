import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase/server";
import { sanitizeAppPath } from "@/lib/auth/redirects";

export const dynamic = "force-dynamic";

/**
 * Auth callback for every email link Supabase Auth sends (sign-up
 * confirmation, password recovery, email change):
 *
 * - PKCE flow: the link redirects here with `?code=...`; the code verifier
 *   cookie (written when the flow started) must be present in THIS browser.
 * - Token-hash flow (custom email templates using `{{ .TokenHash }}`):
 *   `?token_hash=...&type=...`; no cookie required — works across devices.
 *
 * `?next=` is the same-app path to land on after the session is established;
 * it is sanitised against open redirects before use.
 */

const ALLOWED_OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

function isAllowedOtpType(value: string | null): value is EmailOtpType {
  return (
    value !== null && (ALLOWED_OTP_TYPES as readonly string[]).includes(value)
  );
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = sanitizeAppPath(searchParams.get("next"), "/en/dashboard");

  // Failure pages live under the locale that the (sanitised) next path targets.
  const failureLocale = next.split("/")[1] ?? "en";

  const supabase = await createServerSupabase();

  let failed = false;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failed = Boolean(error);
    if (error) {
      console.error("[auth/callback] Code exchange failed:", error.message);
    }
  } else if (tokenHash && isAllowedOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    failed = Boolean(error);
    if (error) {
      console.error("[auth/callback] OTP verification failed:", error.message);
    }
  } else {
    // Nothing to exchange — a bare hit on the callback route.
    failed = true;
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;

  if (failed) {
    return NextResponse.redirect(
      new URL(`/${failureLocale}/login?error=link_expired`, baseUrl),
    );
  }

  return NextResponse.redirect(new URL(next, baseUrl));
}
