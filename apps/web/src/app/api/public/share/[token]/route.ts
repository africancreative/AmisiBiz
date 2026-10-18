import { NextRequest, NextResponse } from "next/server";
import { bootstrapScope, runInScope } from "@amisibiz/database";

/**
 * Public share-link resolver:
 * `GET /api/public/share/<token>` (unauthenticated).
 *
 * The token is a RESOURCE key, never a tenant-routing key: the
 * SECURITY DEFINER function `app_public_share_link_resolve(text)` reads the
 * `ShareLink` row server-side and returns the minimized
 * `{tenantId, id, kind, itemId?, documentId?}` jsonb, bumping `viewCount`
 * inside the function. Anonymous readers have no RLS context and reach no
 * table — this function is the only door (design spec §0/§11).
 *
 * Refusals are deliberately indistinguishable: an unknown, revoked, expired
 * or malformed token all return the SAME generic 404, and a raising function
 * (the SQL `no_data_found` the function throws for all three) never echoes
 * its message. Guessing attacks learn nothing.
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

  // Format gate first, and it fails the SAME way a bad token fails in the
  // database: a probe cannot tell "too weird to ask" from "does not exist".
  if (!token || !TOKEN_PATTERN.test(token)) {
    return notFound();
  }

  try {
    // The token reaches SQL ONLY as a bound parameter of the function call;
    // there is no string interpolation anywhere on this path.
    const rows = await runInScope(
      bootstrapScope(),
      (tx) =>
        tx.$queryRaw<{ result: unknown }[]>`
        SELECT public.app_public_share_link_resolve(${token}) AS "result"`,
    );

    const result = rows[0]?.result;
    if (result === null || result === undefined) {
      return notFound();
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // The function raises for revoked/expired/unknown tokens; every exception
    // is the same generic 404 and the internals are logged only.
    console.error("[GET /api/public/share/[token]]", err);
    return notFound();
  }
}
