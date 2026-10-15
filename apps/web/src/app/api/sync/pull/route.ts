import { NextResponse } from "next/server";
import { getBearerSessionUser } from "@/lib/auth/bearer-session";
import { runWithRequestSession } from "@/lib/auth/request-session";
import { logger } from "@/lib/logger";
import { syncPullQuerySchema } from "@/lib/validations/sync";
import { AuthorizationError } from "@/server/auth/authorization";
import { CursorError, handleSyncPull } from "@/server/sync/pull";

/**
 * `GET /api/sync/pull?tenantId=…&cursor=…&limit=…`
 *
 * Returns one page of server changes for the caller's replica. Authentication is
 * the same bearer chain as the push endpoint; the tenant is required and
 * authorized. (The design wrote this as a tenant-less request because the
 * session was assumed to name one workspace; a user may belong to several, so the
 * tenant travels explicitly and the *cursor is bound to it* — a cursor from
 * another workspace is refused, which is the security property the design's
 * wording was reaching for.)
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getBearerSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = syncPullQuerySchema.safeParse({
    tenantId: url.searchParams.get("tenantId") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: parseLimit(url.searchParams.get("limit")),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_query", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const page = await runWithRequestSession(user, () =>
      handleSyncPull({
        userId: user.id,
        tenantId: parsed.data.tenantId,
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      }),
    );
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof CursorError) {
      return NextResponse.json(
        { error: "invalid_cursor", detail: error.message },
        { status: 400 },
      );
    }
    if (error instanceof AuthorizationError) {
      // Never reveal whether the tenant exists: a denial is a flat 403.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    logger.error("sync.pull.failed", { error });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** `limit` is numeric on the wire; the schema then bounds it. */
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
