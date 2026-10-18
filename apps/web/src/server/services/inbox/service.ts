import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import {
  isVerified,
  sendIsDelivered,
  type IntegrationOutcome,
  type SendReceipt,
} from "@amisibiz/integrations";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { buildAdapterForRow } from "@/server/services/integrations/connections";
import {
  SOCIAL_AUDIT_ACTIONS,
  SocialServiceError,
} from "@/server/services/integrations/errors";
import { createLead } from "@/server/services/leads/service";
import { convertLead } from "@/server/services/leads/conversion";
import { appendActivity } from "@/server/services/activities/service";
import type {
  AssignConversationInput,
  ConverseSessionInput,
  ConverseTemplateInput,
  ConversationToLeadInput,
  CreateNoteInput,
  ListConversationsInput,
} from "@/lib/validations/inbox";

/**
 * Shared inbox (AGENT 03 module B — `inbox/service.ts`).
 *
 * Reads and thread operations are tenant-pinned through the authorization
 * context (never a payload `tenantId`). The two honesty rules this file is
 * built around:
 *
 *  - **Outbound send is a gated, honest operation.** A reply goes out ONLY
 *    through an `INBOX_CONVERSE`-authorized action, and ONLY after a SERVER-side
 *    window + opt-out check:
 *      * the 24h customer-service window is computed from `Conversation.lastInboundAt`
 *        — a free-form session message is refused once the window has closed
 *        (never a client-asserted "still open");
 *      * an opt-out (a STOP/unsubscribe snapshot on the thread) suppresses ALL
 *        outbound sends.
 *    The provider call runs through the connection's adapter; we record an
 *    OUTBOUND `ConversationMessage` and mark it DELIVERED ONLY when
 *    `sendIsDelivered(outcome)` is true — i.e. the provider actually returned a
 *    verified receipt. A mock or an unconfigured channel can never make a send
 *    look delivered; the failure surfaces to the operator.
 *  - **Response time is computed, never stored.** First-response latency is
 *    derived from `firstResponseAt − lastInboundAt` at read time; `unreadCount`,
 *    `lastInboundAt`/`lastOutboundAt`/`firstResponseAt`/`closedAt` are all
 *    server-maintained and never client-set.
 *
 * Conversion reuses the 2A/2B engines (`createLead` / `convertLead`) rather than
 * reimplementing them, so contact and document rules cannot drift; the lead's
 * source is forced to SOCIAL here.
 */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type ConversationRow = Prisma.ConversationGetPayload<
  Record<string, never>
>;

/* --------------------------------- window ----------------------------------- */

/** Whether the 24h customer-service window is open, from the LAST inbound. */
export function windowOpen(
  lastInboundAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() <= TWENTY_FOUR_HOURS_MS;
}

/* -------------------------------- list/read --------------------------------- */

export interface ConversationListItem {
  readonly conversation: ConversationRow;
  readonly responseTimeMs: number | null;
}

/** Derives first-response latency; null when no exchange happened yet. */
function deriveResponseMs(row: {
  firstResponseAt: Date | null;
  lastInboundAt: Date | null;
}): number | null {
  if (!row.firstResponseAt || !row.lastInboundAt) return null;
  const ms = row.firstResponseAt.getTime() - row.lastInboundAt.getTime();
  return ms >= 0 ? ms : null;
}

export async function listConversations(
  authz: TenantAuthzContext,
  query: Omit<ListConversationsInput, "tenantId">,
): Promise<{ conversations: ConversationListItem[]; total: number }> {
  // Undefined keeps the filter OFF the where-input entirely — with
  // exactOptionalPropertyTypes an explicit `assignedToUserId: undefined`
  // would not type-check; `me`/`unassigned` resolve to a concrete id/null.
  const assigneeValue =
    query.assignee === undefined
      ? undefined
      : query.assignee === "me"
        ? authz.userId
        : query.assignee === "unassigned"
          ? null
          : query.assignee;

  const where: Prisma.ConversationWhereInput = {
    tenantId: authz.tenantId,
    ...(query.channel ? { channel: query.channel } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(assigneeValue === undefined ? {} : { assignedToUserId: assigneeValue }),
    ...(query.unread === true ? { unreadCount: { gt: 0 } } : {}),
    ...(query.unread === false ? { unreadCount: 0 } : {}),
    ...(query.labelId
      ? {
          labels: {
            some: { labelId: query.labelId, tenantId: authz.tenantId },
          },
        }
      : {}),
    ...(query.q
      ? {
          messages: {
            some: {
              tenantId: authz.tenantId,
              textPlain: { contains: query.q, mode: "insensitive" },
            },
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [
        { lastInboundAt: { sort: "desc", nulls: "last" } },
        { id: "desc" },
      ],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.conversation.count({ where }),
  ]);

  return {
    conversations: rows.map((conversation) => ({
      conversation,
      responseTimeMs: deriveResponseMs(conversation),
    })),
    total,
  };
}

export async function getConversation(
  authz: TenantAuthzContext,
  conversationId: string,
): Promise<{
  conversation: ConversationRow;
  messages: Prisma.ConversationMessageGetPayload<Record<string, never>>[];
  notes: Prisma.ConversationNoteGetPayload<Record<string, never>>[];
  labels: { id: string; name: string; color: string | null }[];
  responseTimeMs: number | null;
}> {
  const conversation = await loadConversation(authz, conversationId);

  const [messages, notes, labelRows] = await Promise.all([
    prisma.conversationMessage.findMany({
      where: { conversationId, tenantId: authz.tenantId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.conversationNote.findMany({
      where: { conversationId, tenantId: authz.tenantId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.conversationLabel.findMany({
      where: { conversationId, tenantId: authz.tenantId },
      include: { label: { select: { id: true, name: true, color: true } } },
    }),
  ]);

  // Opening a thread clears its unread badge — a server-owned counter change.
  if (conversation.unreadCount > 0) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
    });
  }

  return {
    conversation,
    messages,
    notes,
    labels: labelRows.map((row) => row.label),
    responseTimeMs: deriveResponseMs(conversation),
  };
}

/* ---------------------------------- notes ----------------------------------- */

export async function createNote(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreateNoteInput, "tenantId">,
): Promise<Prisma.ConversationNoteGetPayload<Record<string, never>>> {
  await loadConversation(authz, input.conversationId);
  const note = await prisma.conversationNote.create({
    data: {
      tenantId: authz.tenantId,
      conversationId: input.conversationId,
      body: input.body.trim(),
      authorId: actorId,
    },
  });
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONVERSATION_NOTE,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "ConversationNote",
    resourceId: note.id,
    metadata: { conversationId: input.conversationId },
  });
  return note;
}

/* ------------------------------ assign / status ----------------------------- */

export async function assignConversation(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<AssignConversationInput, "tenantId">,
): Promise<ConversationRow> {
  const conversation = await loadConversation(authz, input.conversationId);
  if (input.assignedToUserId !== null) {
    await assertActiveMember(authz, input.assignedToUserId);
  }
  const result = await prisma.conversation.updateMany({
    where: { id: input.conversationId, tenantId: authz.tenantId },
    data: { assignedToUserId: input.assignedToUserId },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Conversation not found.");
  }
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONVERSATION_ASSIGNED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Conversation",
    resourceId: input.conversationId,
    metadata: {
      fromUserId: conversation.assignedToUserId,
      toUserId: input.assignedToUserId,
    },
  });
  return loadConversation(authz, input.conversationId);
}

/**
 * Set OPEN/PENDING (reopen-family) or CLOSED (close). CLOSED stamps `closedAt`;
 * reopening clears it. Status is never a free client field beyond this enum.
 */
export async function setStatus(
  authz: TenantAuthzContext,
  actorId: string,
  conversationId: string,
  status: "OPEN" | "PENDING" | "CLOSED",
): Promise<ConversationRow> {
  const conversation = await loadConversation(authz, conversationId);
  const data: Prisma.ConversationUpdateInput = { status };
  if (status === "CLOSED") {
    data.closedAt = new Date();
  } else if (conversation.status === "CLOSED") {
    // Reopening an already-closed thread clears the close stamp.
    data.closedAt = null;
  }
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, tenantId: authz.tenantId },
    data,
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Conversation not found.");
  }
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONVERSATION_STATUS,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Conversation",
    resourceId: conversationId,
    metadata: { from: conversation.status, to: status },
  });
  return loadConversation(authz, conversationId);
}

export async function closeConversation(
  authz: TenantAuthzContext,
  actorId: string,
  conversationId: string,
): Promise<ConversationRow> {
  return setStatus(authz, actorId, conversationId, "CLOSED");
}

export async function reopenConversation(
  authz: TenantAuthzContext,
  actorId: string,
  conversationId: string,
): Promise<ConversationRow> {
  return setStatus(authz, actorId, conversationId, "OPEN");
}

/* ------------------------------ outbound send ------------------------------- */

export interface SendResult {
  readonly delivered: boolean;
  readonly providerMessageId: string | null;
  readonly messageStatus: "DELIVERED" | "SENT" | "FAILED";
  readonly reason: string | null;
}

/**
 * A free-form session reply, gated server-side by the 24h window + opt-out.
 * A closed window is a POLICY refusal, not a permission miss; an opt-out thread
 * suppresses the send entirely. The recorded OUTBOUND message is marked
 * DELIVERED only on a provider-verified receipt.
 */
export async function sendSessionMessage(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<ConverseSessionInput, "tenantId">,
): Promise<SendResult> {
  const conversation = await loadConversation(authz, input.conversationId);

  if (!windowOpen(conversation.lastInboundAt)) {
    throw new SocialServiceError(
      "POLICY",
      "The 24-hour service window has closed, so a free-form reply cannot be " +
        "sent. Use an approved template to reopen the conversation.",
    );
  }
  await assertNotOptedOut(conversation);

  const { adapter } = buildAdapterForRow(await loadConnection(conversation));
  const outcome = await adapter.sendSessionMessage(
    conversation.externalId,
    input.text.trim(),
  );

  return recordOutbound(authz, actorId, conversation, outcome, {
    aiDraft: false,
    text: input.text.trim(),
  });
}

/** A template send (WhatsApp only; Messenger/IG report unsupported honestly). */
export async function sendTemplate(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<ConverseTemplateInput, "tenantId">,
): Promise<SendResult> {
  const conversation = await loadConversation(authz, input.conversationId);
  await assertNotOptedOut(conversation);

  const { adapter } = buildAdapterForRow(await loadConnection(conversation));
  const outcome = await adapter.sendTemplate(
    conversation.externalId,
    input.templateName.trim(),
    input.languageCode,
    input.variables,
  );

  return recordOutbound(authz, actorId, conversation, outcome, {
    aiDraft: false,
    text: `template:${input.templateName}`,
  });
}

interface RecordOutboundArgs {
  aiDraft: boolean;
  text: string;
}

async function recordOutbound(
  authz: TenantAuthzContext,
  actorId: string,
  conversation: ConversationRow,
  outcome: IntegrationOutcome<SendReceipt>,
  meta: RecordOutboundArgs,
): Promise<SendResult> {
  // Narrow through the real outcome union (verification.ts): only `Verified`
  // carries `.value`, so `isVerified` — the contract's own predicate — is what
  // grants access to the provider receipt. `sendIsDelivered` stays the delivery
  // verdict; an Unverified/Declined/Failed outcome can never read a receipt and
  // is never recorded as delivered.
  const verified = isVerified(outcome);
  const delivered = sendIsDelivered(outcome);
  const providerMessageId = verified ? outcome.value.providerMessageId : null;

  const status: SendResult["messageStatus"] = delivered
    ? "DELIVERED"
    : verified
      ? "SENT"
      : "FAILED";

  // Record the attempt honestly. A send that the provider did NOT confirm is
  // stored FAILED (never silently dropped, never marked delivered), so the
  // operator can see and retry it.
  await prisma.conversationMessage.create({
    data: {
      tenantId: authz.tenantId,
      conversationId: conversation.id,
      connectionId: conversation.connectionId,
      direction: "OUTBOUND",
      providerMessageId,
      body: { kind: "outbound", delivered, status: outcome.status },
      textPlain: meta.text,
      status,
      statusAt: new Date(),
      // Snapshot the opt-out state at send time (the gate already ran above).
      optOutSnapshot: false,
      aiDraft: meta.aiDraft,
      authorId: actorId,
    },
  });

  // First response stamps the response-time basis (server-owned).
  if (!conversation.firstResponseAt) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { firstResponseAt: new Date() },
    });
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastOutboundAt: new Date() },
  });

  await appendActivity(authz, actorId, {
    eventType: "INBOX_MESSAGE_SENT",
    leadId: conversation.leadId,
    contactId: conversation.contactId,
    payload: { conversationId: conversation.id, delivered },
    source: "service:inbox.converse",
    sourceKey: `conversation:${conversation.id}:sent:${Date.now()}`,
  });
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONVERSATION_MESSAGE_SENT,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Conversation",
    resourceId: conversation.id,
    metadata: { delivered, status: outcome.status },
  });

  return {
    delivered,
    providerMessageId,
    messageStatus: status,
    reason: delivered
      ? null
      : "reason" in outcome
        ? String(outcome.reason ?? "provider refused")
        : "detail" in outcome
          ? String(outcome.detail ?? "provider refused")
          : "provider did not confirm delivery",
  };
}

/* ----------------------------- convert to lead ------------------------------ */

/**
 * Convert a conversation to a lead, reusing the 2A `createLead` engine (source
 * forced to SOCIAL). Optionally raise a quotation/order through the same 2A
 * conversion (which itself reuses the 2B documents engine), so nothing about
 * contact/document rules is reimplemented here. The lead is linked back onto the
 * conversation (`leadId`) — a server-owned pointer.
 */
export async function conversationToLead(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<ConversationToLeadInput, "tenantId">,
): Promise<{
  leadId: string;
  documentId: string | null;
  documentCreated: boolean;
  needsDraftEditor: boolean;
}> {
  const conversation = await loadConversation(authz, input.conversationId);

  const { lead, created } = await createLead(authz, actorId, {
    source: "SOCIAL",
    firstName: input.firstName,
    lastName: input.lastName,
    companyName: input.companyName,
    email: input.email,
    // The customer's provider key is the only durable identity we have; it is
    // stored as the lead's phone so dedupe can match a returning enquiry.
    phone: conversation.externalId,
    currency: input.currency,
    // Idempotency: the conversation id is the retry identity for the lead.
    idempotencyKey: `conversation:${conversation.id}`,
    sourceDetail: `inbox-conversation:${conversation.id}`,
  });

  // Link the lead onto the thread (idempotent; a replay keeps the same lead).
  if (conversation.leadId !== lead.id) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { leadId: lead.id },
    });
  }

  if (!input.createDraft) {
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.CONVERSATION_CONVERTED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "Conversation",
      resourceId: conversation.id,
      metadata: { leadId: lead.id, created },
    });
    return {
      leadId: lead.id,
      documentId: null,
      documentCreated: false,
      needsDraftEditor: false,
    };
  }

  // Raise the draft through the 2A conversion (new contact + document). No
  // line data exists on a raw enquiry, so the engine honestly reports
  // needsDraftEditor rather than faking a quotation. The contact blob is
  // re-validated by the conversion engine against `createContactSchema`, so
  // contact rules cannot drift from `createContactAction`.
  const conversion = await convertLead(authz, actorId, {
    leadId: lead.id,
    mode: "newContact",
    contact: {
      type: "INDIVIDUAL",
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      companyName: input.companyName || null,
      email: input.email || null,
      phone: conversation.externalId,
    },
    createDraft: input.createDraft,
  });

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONVERSATION_CONVERTED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Conversation",
    resourceId: conversation.id,
    metadata: {
      leadId: lead.id,
      documentCreated: conversion.documentCreated,
      needsDraftEditor: conversion.needsDraftEditor,
    },
  });

  return {
    leadId: lead.id,
    documentId: conversion.documentId,
    documentCreated: conversion.documentCreated,
    needsDraftEditor: conversion.needsDraftEditor,
  };
}

/* ---------------------------------- helpers --------------------------------- */

async function loadConversation(
  authz: TenantAuthzContext,
  conversationId: string,
): Promise<ConversationRow> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId: authz.tenantId },
  });
  if (!conversation) {
    throw new SocialServiceError("NOT_FOUND", "Conversation not found.");
  }
  return conversation;
}

async function loadConnection(conversation: ConversationRow) {
  const connection = await prisma.integrationConnection.findFirst({
    where: { id: conversation.connectionId },
  });
  if (!connection) {
    throw new SocialServiceError(
      "PROVIDER_UNAVAILABLE",
      "The channel behind this conversation is no longer available.",
    );
  }
  return connection;
}

/** An opt-out snapshot on the newest thread message suppresses outbound sends. */
async function assertNotOptedOut(conversation: ConversationRow): Promise<void> {
  const latest = await prisma.conversationMessage.findFirst({
    where: { conversationId: conversation.id, tenantId: conversation.tenantId },
    orderBy: { createdAt: "desc" },
    select: { optOutSnapshot: true },
  });
  if (latest?.optOutSnapshot) {
    throw new SocialServiceError(
      "POLICY",
      "This contact has opted out of messaging; outbound sends are suppressed.",
    );
  }
}

async function assertActiveMember(
  authz: TenantAuthzContext,
  userId: string,
): Promise<void> {
  const membership = await prisma.tenantMember.findFirst({
    where: { tenantId: authz.tenantId, userId, user: { status: "ACTIVE" } },
    select: { userId: true },
  });
  if (!membership) {
    throw new SocialServiceError(
      "VALIDATION",
      "The selected person is not an active member of this business.",
      "assignedToUserId",
    );
  }
}
