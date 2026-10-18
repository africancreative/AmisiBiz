import { NextRequest, NextResponse } from "next/server";
import { bootstrapScope, runInScope } from "@amisibiz/database";

/**
 * Public product page data:
 * `GET /api/public/product/<token>` (unauthenticated).
 *
 * Backed by the SECURITY DEFINER function `app_public_product_view(text)`,
 * which returns the minimized product payload for an ACTIVE, unexpired
 * PRODUCT link: item essentials, the ACTIVE variants' prices with explicit
 * currency, and only the brand fields a customer page needs. The json is
 * returned verbatim — this route adds no fields and strips none.
 *
 * Unknown, revoked, expired, wrong-kind and vanished-item tokens all raise
 * the function's own identical refusal; every failure answers with the same
 * generic 404 and never echoes internals.
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
        SELECT public.app_public_product_view(${token}) AS "result"`,
    );

    const result = rows[0]?.result;
    if (result === null || result === undefined) {
      return notFound();
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[GET /api/public/product/[token]]", err);
    return notFound();
  }
}
