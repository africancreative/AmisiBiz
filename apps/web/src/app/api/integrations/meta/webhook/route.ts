import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { bootstrapScope, runInScope } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import {
  metaAppSecret,
  verifyMetaSignature,
} from "@/server/services/integrations/crypto";
import { SOCIAL_AUDIT_ACTIONS } from "@/server/services/integrations/errors";
import {
  ingestVerifiedWebhook,
  metaHandshake,
  type ProviderName,
} from "@/server/services/integrations/webhooks";

/**
 * Meta webhooks endpoint (AGENT 03 module D — inbound door).
 *
 * Exports ONLY the HTTP handlers plus `dynamic`/`runtime` config: a non-handler
 * export breaks `next build`, so every helper lives in the webhook service.
 *
 *   GET  — the subscription handshake (`hub.mode`/`hub.verify_token`/
 *          `hub.challenge`). `metaHandshake` compares the SHA-256 hash of the
 *          supplied verify string to a stored `webhookVerifyTokenHash` and
 *          echoes the challenge ONLY on a match; anything else is a 403.
 *   POST — authenticity FIRST: the `X-Hub-Signature-256` HMAC is verified over
 *          the RAW body (constant-time, keyed on the app secret). A valid
 *          envelope routes by the provider object type and fans out under the
 *          bootstrap scope (see the ingestion-gap note in `webhooks.ts`). A
 *          FORGED signature is dropped with a 200 (so Meta stops retrying
 *          garbage) plus an audit — it NEVER reaches the event tables.
 *
 * This route never logs the raw body, the signature, the app secret or any
 * credential; only stable ids are audited.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Meta's top-level `object` discriminator → the connection's provider name. */
function providerFromObject(object: unknown): ProviderName | null {
  if (object === "whatsapp_business_account") return "META_WHATSAPP";
  if (object === "page") return "META_FB_PAGE";
  if (object === "instagram" || object === "instagram_permission") {
    return "META_INSTAGRAM";
  }
  return null;
}

/* --------------------------------- handshake -------------------------------- */

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  const result = await metaHandshake({
    mode: params.get("hub.mode"),
    token: params.get("hub.verify_token"),
    challenge: params.get("hub.challenge"),
  });

  if (!result.ok || result.challenge === undefined) {
    // No match (or a malformed handshake): echo nothing, 403. The reason is
    // never disclosed beyond the status.
    return new NextResponse("Verification failed", { status: 403 });
  }

  return new NextResponse(result.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/* -------------------------------- ingestion --------------------------------- */

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The RAW body is what the signature covers: read it as text ONCE and parse
  // from that same string, so the HMAC and the payload can never diverge.
  const rawBody = await request.text();

  const signature = request.headers.get("X-Hub-Signature-256");
  const authentic = verifyMetaSignature(rawBody, signature, metaAppSecret());

  if (!authentic) {
    // Forgery or misconfiguration: accept-and-drop so Meta stops retrying, but
    // persist NOTHING to the event tables and fan out NOTHING.
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.WEBHOOK_FORGED,
      tenantId: null,
      resource: "IntegrationWebhookEvent",
      metadata: { reason: "signature_mismatch" },
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Authentic but unparseable: nothing to route; ack so Meta stops retrying.
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const provider = providerFromObject(payload.object);
  if (!provider) {
    // Authentic but not one of our channels: acknowledged, not stored.
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Event id is Meta's retry identity. The delivery header is preferred; a
  // stable hash of the raw body is the fallback so dedup still holds across a
  // retry of an identical payload that arrives without the header.
  const eventId = request.headers.get("X-Hub-Event-Id") ?? hashOf(rawBody);

  try {
    await runInScope(bootstrapScope(), () =>
      ingestVerifiedWebhook({
        provider,
        eventId,
        deliveryId: request.headers.get("X-Hub-Message-Rate-Limit-Window"),
        payload,
      }),
    );
  } catch (err) {
    // A genuine processing fault: 500 so Meta retries (the dedup spine makes a
    // retry safe). The internals are logged, never returned.
    console.error("[POST /api/integrations/meta/webhook]", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

/* ---------------------------------- helpers --------------------------------- */

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
