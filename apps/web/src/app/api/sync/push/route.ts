import { z } from "zod";
import { NextResponse } from "next/server";
import { getBearerSessionUser } from "@/lib/auth/bearer-session";
import { runWithRequestSession } from "@/lib/auth/request-session";
import { logger } from "@/lib/logger";
import { syncPushEnvelopeSchema } from "@/lib/validations/sync";
import { handleSyncPush } from "@/server/sync/push";

/**
 * `POST /api/sync/push` — the sync endpoint for installed shells.
 *
 * Route-handler responsibilities, deliberately thin: read the bearer token,
 * validate the envelope, and hand the work to `handleSyncPush`. Authentication
 * is `Authorization: Bearer <user access token>` (the same trust chain as the web
 * cookie, factored in `bearer-session.ts`); the tenant travels in the
 * `X-Amisibiz-Tenant` header, which is transport metadata and is *authorized*,
 * never trusted.
 *
 * `runWithRequestSession` makes the resolved actor visible to the Server Actions
 * the sync service delegates to, which is what lets the sync layer reuse the one
 * copy of every mutation instead of reimplementing it.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getBearerSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const tenantId = readTenantId(request);
  if (!tenantId) {
    return NextResponse.json(
      { error: "missing_tenant", detail: "X-Amisibiz-Tenant is required." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = syncPushEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    // A protocol refusal (400) tells the client the wire is fine but the envelope
    // is not, which is a different repair from "the server decided against this
    // operation" (an in-band `rejected`).
    return NextResponse.json(
      { error: "invalid_envelope", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = await runWithRequestSession(user, () =>
      handleSyncPush({ userId: user.id, tenantId, envelope: parsed.data }),
    );
    return NextResponse.json(result);
  } catch (error) {
    logger.error("sync.push.failed", { error });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/**
 * The workspace the batch targets. Shaped like a UUID here only so a malformed
 * header is a 400 rather than a database error; the handler authorizes it, and an
 * id the caller is not a member of is refused there.
 */
const tenantIdSchema = z.string().uuid();

function readTenantId(request: Request): string | null {
  const header = request.headers.get("x-amisibiz-tenant")?.trim();
  if (!header) return null;
  const parsed = tenantIdSchema.safeParse(header);
  return parsed.success ? parsed.data : null;
}
