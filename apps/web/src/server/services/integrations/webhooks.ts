import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import { hashWebhookVerifyString } from "@/server/services/integrations/crypto";
import { SOCIAL_AUDIT_ACTIONS } from "@/server/services/integrations/errors";
import { appendMarketingEvent } from "@/server/services/marketing/events";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Webhook ingestion (AGENT 03 module B — `webhooks.ts`).
 *
 * This is the trusted inbound door for Meta's three channels. The order of
 * operations IS the security contract, and every branch is honest about what it
 * did:
 *
 *  1. **Authenticity FIRST.** The route verifies `X-Hub-Signature-256` (an
 *     HMAC-SHA256 over the RAW body keyed on the app secret, constant-time
 *     compared) before this file is ever consulted. A forged signature is
 *     dropped with a 200 (so Meta stops retrying garbage) plus an audit — it
 *     NEVER touches the event tables or fans out.
 *  2. **Dedup is Meta's retry spine.** `(provider, eventId)` is globally unique
 *     (migration §4); a duplicate insert is swallowed and NOTHING re-fans-out.
 *     Meta retries the same eventId for up to 7 days, so duplicates are a
 *     guarantee, not an edge case.
 *  3. **Routing by the provider external id.** A payload is resolved to a
 *     connection by `(provider, providerExternalId)` — the phone-number id,
 *     page id or IG account id the connection registered.
 *  4. **Authentic-but-unroutable PARKS.** If the signature is valid but the
 *     external id maps to no connection, the envelope is stored with
 *     `routingStatus = PARKED` and NO tenant; it is not dropped and not applied.
 *  5. **Fan-out on an APPLIED event.** Inbound messages upsert the
 *     `Conversation` (by `connectionId`+`externalId`) and its
 *     `ConversationMessage` rows (idempotent by `providerMessageId`), and an
 *     inbound first-contact emits an `ENQUIRY_SUBMITTED` marketing event through
 *     the single writer (consent-gated like every other event).
 *
 * PHASE-2 INGESTION GAP (owner ask): the parked (NULL-tenant) envelope and the
 * cross-tenant routing/annotation writes are NOT reachable by the `amisibiz_app`
 * RLS role — migration §3/§59 explicitly defers the global write/route path to a
 * Phase-2 SECURITY DEFINER ingestion function that has not been created. This
 * module is written against that definer's contract and runs its writes under
 * `runInScope(bootstrapScope(), …)` in the route; until the definer exists these
 * writes cannot land on the real cluster. The LOGIC (signature, dedup, routing,
 * parked vs applied, forged drop, fan-out) is fully unit-tested against mocked
 * delegates.
 */

/** The Prisma executor a webhook write runs on (root client or a tx). */
type Db = PrismaClient | Prisma.TransactionClient;

/** The three Meta channel providers a webhook can carry, by connection provider. */
export type ProviderName = "META_WHATSAPP" | "META_FB_PAGE" | "META_INSTAGRAM";

/* ------------------------------- handshake ---------------------------------- */

export interface HandshakeResult {
  readonly ok: boolean;
  /** The `hub.challenge` echoed back ONLY when the verify string matched. */
  readonly challenge?: string;
}

/**
 * Meta's GET subscription handshake: `hub.mode=subscribe`, `hub.verify_token`,
 * `hub.challenge`. The token is compared to a stored SHA-256 hash
 * (`webhookVerifyTokenHash`, mirroring `Invitation.tokenHash`); a match echoes
 * the challenge unchanged, anything else echoes nothing (the route 403s).
 */
export async function metaHandshake(args: {
  mode?: string | null;
  token?: string | null;
  challenge?: string | null;
}): Promise<HandshakeResult> {
  if (args.mode !== "subscribe" || !args.token || !args.challenge) {
    return { ok: false };
  }
  // Lookup is a definer-gated read (the raw hash is not tenant-visible); the
  // route supplies the already-hashed candidate. We compare hashes, never the
  // raw token, and echo the challenge verbatim on a match.
  const candidateHash = hashWebhookVerifyString(args.token);
  const connection = await prisma.integrationConnection.findFirst({
    where: { webhookVerifyTokenHash: candidateHash },
    select: { id: true },
  });
  if (!connection) {
    return { ok: false };
  }
  return { ok: true, challenge: args.challenge };
}

/* ---------------------------- payload normalization -------------------------- */

export interface NormalizedInbound {
  readonly providerExternalId: string | null;
  readonly messages: readonly InboundMessage[];
}
interface InboundMessage {
  readonly providerMessageId: string | null;
  /** The customer's provider key (phone/PSID/IG-scoped id). */
  readonly externalId: string;
  readonly text: string;
  readonly timestampIso: string;
  readonly optOut: boolean;
}

/**
 * Read `{ id: string }` out of an untrusted nested payload object (`unknown`).
 * Proper narrowing instead of dotted access on `unknown`, which would compile
 * against `{}` and never actually type-check the shape.
 */
function nestedId(value: unknown): string | null {
  return typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
    ? value.id
    : null;
}

/**
 * Extract the routing id and inbound messages from a Meta envelope. The three
 * object types (whatsapp_business_account / page / instagram) differ in shape;
 * each branch reads only the fields it documents. This never logs or returns the
 * raw body — only the normalized projection.
 */
export function normalizeMetaPayload(
  provider: "META_WHATSAPP" | "META_FB_PAGE" | "META_INSTAGRAM",
  payload: unknown,
): NormalizedInbound {
  const root = payload as Record<string, unknown>;
  const entries = Array.isArray(root.entry) ? (root.entry as unknown[]) : [];
  const messages: InboundMessage[] = [];
  let routingId: string | null = null;

  for (const entryRaw of entries) {
    const entry = entryRaw as Record<string, unknown>;
    const entryId = typeof entry.id === "string" ? entry.id : null;
    const changes = Array.isArray(entry.changes)
      ? (entry.changes as unknown[])
      : [];

    for (const changeRaw of changes) {
      const change = changeRaw as Record<string, unknown>;
      const value = (change.value ?? {}) as Record<string, unknown>;

      if (provider === "META_WHATSAPP") {
        const metadata = (value.metadata ?? {}) as Record<string, unknown>;
        if (typeof metadata.phone_number_id === "string") {
          routingId = metadata.phone_number_id;
        }
        const waMessages = Array.isArray(value.messages)
          ? (value.messages as unknown[])
          : [];
        for (const mRaw of waMessages) {
          const m = mRaw as Record<string, unknown>;
          const textBlob = (m.text ?? {}) as Record<string, unknown>;
          messages.push({
            providerMessageId: typeof m.id === "string" ? m.id : null,
            externalId:
              typeof m.from === "string" ? m.from : (entryId ?? "unknown"),
            text: typeof textBlob.body === "string" ? textBlob.body : "",
            timestampIso:
              typeof m.timestamp === "string"
                ? m.timestamp
                : new Date().toISOString(),
            optOut: isOptOutKeyword(m),
          });
        }
      } else if (provider === "META_FB_PAGE") {
        // Messenger: routing id is the page id in entry.id; sender is the PSID.
        if (entryId) routingId = entryId;
        const pageMessages = Array.isArray(value.messages)
          ? (value.messages as unknown[])
          : [];
        for (const mRaw of pageMessages) {
          const m = mRaw as Record<string, unknown>;
          const sender = nestedId(m.sender);
          messages.push({
            providerMessageId: typeof m.mid === "string" ? m.mid : null,
            externalId: sender ?? "unknown",
            text: typeof m.text === "string" ? m.text : "",
            timestampIso: m.timestamp
              ? new Date(Number(m.timestamp)).toISOString()
              : new Date().toISOString(),
            optOut: typeof m.text === "string" ? isStopText(m.text) : false,
          });
        }
      } else {
        // Instagram: routing id is the IG account id (entry.id / recipient_id).
        const igId =
          typeof value.recipient_id === "string" ? value.recipient_id : entryId;
        if (igId) routingId = igId;
        const igMessages = Array.isArray(value.messages)
          ? (value.messages as unknown[])
          : [];
        for (const mRaw of igMessages) {
          const m = mRaw as Record<string, unknown>;
          messages.push({
            providerMessageId: typeof m.id === "string" ? m.id : null,
            externalId: nestedId(m.from) ?? "unknown",
            text: typeof m.text === "string" ? m.text : "",
            timestampIso: new Date().toISOString(),
            optOut: typeof m.text === "string" ? isStopText(m.text) : false,
          });
        }
      }
    }
  }

  return { providerExternalId: routingId, messages };
}

/** WhatsApp opt-out signal (the provider flags a user-initiated stop). */
function isOptOutKeyword(message: Record<string, unknown>): boolean {
  const flags = message.interactive as
    { button_reply?: { payload?: string } } | undefined;
  const payload = flags?.button_reply?.payload?.toUpperCase();
  return payload === "STOP" || payload === "UNSUBSCRIBE";
}
function isStopText(text: string): boolean {
  const t = text.trim().toUpperCase();
  return t === "STOP" || t === "UNSUBSCRIBE" || t === "OPTOUT";
}

/* --------------------------------- ingest ----------------------------------- */

export interface IngestResult {
  readonly duplicate: boolean;
  readonly routed: "APPLIED" | "PARKED";
  readonly conversationCount: number;
  readonly messageCount: number;
}

/**
 * Persist a verified webhook envelope and, when it routes, fan it out. The
 * caller (route) has ALREADY verified the signature; this function assumes an
 * authentic envelope and decides PARKED vs APPLIED.
 */
export async function ingestVerifiedWebhook(args: {
  provider: "META_WHATSAPP" | "META_FB_PAGE" | "META_INSTAGRAM";
  eventId: string;
  deliveryId?: string | null;
  payload: unknown;
}): Promise<IngestResult> {
  const db = prisma as unknown as Db;
  const normalized = normalizeMetaPayload(args.provider, args.payload);

  // Route resolution: which tenant/connection owns this external id?
  const connection = normalized.providerExternalId
    ? await db.integrationConnection.findFirst({
        where: {
          provider: args.provider,
          providerExternalId: normalized.providerExternalId,
        },
        select: { id: true, tenantId: true },
      })
    : null;

  const now = new Date();
  const envelope = {
    provider: args.provider,
    eventId: args.eventId,
    deliveryId: args.deliveryId ?? null,
    payload: args.payload as Prisma.InputJsonValue,
  };

  // DEDUP: attempt to persist the raw envelope first. A P2002 means Meta retried
  // this eventId; the FIRST delivery already handled it, so nothing re-runs.
  let webhookRowId: string;
  try {
    const row = await db.integrationWebhookEvent.create({
      data: {
        ...envelope,
        tenantId: connection?.tenantId ?? null,
        routingStatus: connection ? "APPLIED" : "PARKED",
        appliedAt: connection ? now : null,
      },
      select: { id: true },
    });
    webhookRowId = row.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        duplicate: true,
        routed: connection ? "APPLIED" : "PARKED",
        conversationCount: 0,
        messageCount: 0,
      };
    }
    throw error;
  }

  if (!connection) {
    // Authentic but unroutable: PARKED, no tenant, no fan-out. Audited.
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.WEBHOOK_PARKED,
      // No user actor for an inbound webhook; the delivery itself is the subject.
      tenantId: null,
      resource: "IntegrationWebhookEvent",
      resourceId: webhookRowId,
      metadata: { provider: args.provider, routingStatus: "PARKED" },
    });
    return {
      duplicate: false,
      routed: "PARKED",
      conversationCount: 0,
      messageCount: 0,
    };
  }

  // APPLIED: fan out inbound messages into Conversation + ConversationMessage.
  const channel = channelForProvider(args.provider);
  let conversationCount = 0;
  let messageCount = 0;

  for (const message of normalized.messages) {
    const conversation = await upsertConversation(db, {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      channel,
      externalId: message.externalId,
      inboundAt: new Date(message.timestampIso),
    });
    conversationCount += 1;

    const inserted = await insertInboundMessage(db, {
      tenantId: connection.tenantId,
      conversationId: conversation.id,
      connectionId: connection.id,
      providerMessageId: message.providerMessageId,
      text: message.text,
      optOut: message.optOut,
      payload: message as unknown as Prisma.InputJsonValue,
    });
    if (inserted) messageCount += 1;

    // First inbound on a thread is an ENQUIRY_SUBMITTED marketing event; the
    // single writer dedups it (uniqueEventId = providerMessageId) and applies
    // the consent gate. Only the FIRST message of a fresh conversation counts.
    if (conversation.isNew && message.providerMessageId) {
      await appendMarketingEvent(
        { tenantId: connection.tenantId } as unknown as TenantAuthzContext,
        {
          eventType: "ENQUIRY_SUBMITTED",
          uniqueEventId: `enq_${message.providerMessageId}`,
          occurredAt: new Date(message.timestampIso),
          sourceMeta: { channel, referrerClass: "social" },
        },
      );
    }
  }

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.WEBHOOK_APPLIED,
    tenantId: connection.tenantId,
    resource: "IntegrationWebhookEvent",
    resourceId: webhookRowId,
    metadata: {
      provider: args.provider,
      routingStatus: "APPLIED",
      messageCount,
    },
  });

  return {
    duplicate: false,
    routed: "APPLIED",
    conversationCount,
    messageCount,
  };
}

/* --------------------------------- helpers ---------------------------------- */

function channelForProvider(
  provider: "META_WHATSAPP" | "META_FB_PAGE" | "META_INSTAGRAM",
): "WHATSAPP" | "MESSENGER" | "INSTAGRAM" {
  if (provider === "META_WHATSAPP") return "WHATSAPP";
  if (provider === "META_FB_PAGE") return "MESSENGER";
  return "INSTAGRAM";
}

interface ConversationRef {
  id: string;
  isNew: boolean;
}

async function upsertConversation(
  db: Db,
  args: {
    tenantId: string;
    connectionId: string;
    channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM";
    externalId: string;
    inboundAt: Date;
  },
): Promise<ConversationRef> {
  const existing = await db.conversation.findFirst({
    where: { connectionId: args.connectionId, externalId: args.externalId },
    select: { id: true },
  });
  if (existing) {
    await db.conversation.update({
      where: { id: existing.id },
      data: {
        lastInboundAt: args.inboundAt,
        // A new inbound message reopens the unread counter for the staff side.
        unreadCount: { increment: 1 },
      },
    });
    return { id: existing.id, isNew: false };
  }
  const created = await db.conversation.create({
    data: {
      tenantId: args.tenantId,
      connectionId: args.connectionId,
      channel: args.channel,
      externalId: args.externalId,
      status: "OPEN",
      lastInboundAt: args.inboundAt,
      unreadCount: 1,
    },
    select: { id: true },
  });
  return { id: created.id, isNew: true };
}

/** Insert an inbound message idempotently; returns false on a provider retry. */
async function insertInboundMessage(
  db: Db,
  args: {
    tenantId: string;
    conversationId: string;
    connectionId: string;
    providerMessageId: string | null;
    text: string;
    optOut: boolean;
    payload: Prisma.InputJsonValue;
  },
): Promise<boolean> {
  try {
    await db.conversationMessage.create({
      data: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        connectionId: args.connectionId,
        direction: "INBOUND",
        providerMessageId: args.providerMessageId,
        body: args.payload,
        textPlain: args.text,
        status: "READ",
        // An inbound opt-out request snapshots onto the row so the outbound gate
        // can honour STOP without re-parsing history.
        optOutSnapshot: args.optOut,
        aiDraft: false,
      },
    });
    return true;
  } catch (error) {
    // (connectionId, providerMessageId) unique → Meta re-delivered this message.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

/** Re-exported so the route can build a fresh dedup-safe delivery id if needed. */
export function newDeliveryId(): string {
  return randomBytes(8).toString("hex");
}
