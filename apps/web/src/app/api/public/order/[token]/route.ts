import { NextRequest, NextResponse } from "next/server";
import { bootstrapScope, runInScope } from "@amisibiz/database";

/**
 * Public order-status page data:
 * `GET /api/public/order/<token>` (unauthenticated).
 *
 * Backed by the SECURITY DEFINER function `app_public_order_status(text)`,
 * which answers only for an ACTIVE, unexpired ORDER_STATUS link whose target
 * is an ORDER document in a non-DRAFT status: number, status, explicit
 * currency, total, dates and the line-derived delivery ratio. A draft order
 * is never public information, and nothing else about the workspace leaks.
 *
 * Every refusal (unknown, revoked, expired, wrong kind, draft, cancelled-
 * underneath) raises the function's identical no-data error; the route maps
 * all of them to the same generic 404 without echoing internals.
 */

const TOKEN_PATTERN = /^[0-9A-Za-z_-]{1,128}$/;

function notFound(): NextResponse {
  return NextResponse.json(
    { success: false, error: "Not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!token || !TOKEN_PATTERN.test(token)) {
    return notFound();
  }

  try {
    const rows = await runInScope(
      bootstrapScope(),
      (tx) =>
        tx.$queryRaw<{ result: unknown }[]>`
        SELECT public.app_public_order_status(${token}) AS "result"`,
    );

    const result = rows[0]?.result;
    if (result === null || result === undefined) {
      return notFound();
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[GET /api/public/order/[token]]", err);
    return notFound();
  }
}
