"use server";

import { requireAuth } from "@/lib/auth/helpers";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  authorizeTenant,
  AuthorizationError,
} from "@/server/auth/authorization";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  assignConversationSchema,
  attachLabelSchema,
  conversationLocatorSchema,
  converseSessionSchema,
  converseTemplateSchema,
  conversationToLeadSchema,
  createLabelSchema,
  createNoteSchema,
  createQuickReplySchema,
  deleteLabelSchema,
  deleteQuickReplySchema,
  listConversationsSchema,
  listLabelsSchema,
  listQuickRepliesSchema,
  setConversationStatusSchema,
  updateLabelSchema,
  updateQuickReplySchema,
} from "@/lib/validations/inbox";
import {
  assignConversation,
  closeConversation,
  conversationToLead,
  createNote,
  getConversation,
  listConversations,
  reopenConversation,
  sendSessionMessage,
  sendTemplate,
  setStatus,
  type ConversationListItem,
  type ConversationRow,
  type SendResult,
} from "@/server/services/inbox/service";
import {
  attachLabel,
  createLabel,
  deleteLabel,
  detachLabel,
  listLabels,
  updateLabel,
  type LabelRow,
} from "@/server/services/inbox/labels";
import {
  createQuickReply,
  deleteQuickReply,
  listQuickReplies,
  updateQuickReply,
  type QuickReplyRow,
} from "@/server/services/inbox/quick-replies";
import {
  socialErrorActionCode,
  SocialServiceError,
} from "@/server/services/integrations/errors";
import type { Prisma } from "@prisma/client";

/**
 * Shared inbox Server Actions (AGENT 03 module C).
 *
 * Same pipeline as `actions/lead.ts`: authenticate → validate (server-owned
 * keys stripped: `unreadCount`, `lastInboundAt`/`lastOutboundAt`/
 * `firstResponseAt`/`closedAt`, `providerMessageId`, `optOutSnapshot`, `aiDraft`
 * provenance and every id never survive a payload) → `authorizeTenant` with the
 * verb-specific permission → delegate to the inbox services, which take the
 * authorized context and never a client `tenantId`.
 *
 * Permission wiring:
 *  - list / thread read → INBOX_READ
 *  - note / assign / status / close / reopen / labels / quick replies /
 *    convert-to-lead → INBOX_MANAGE
 *  - the ONLY outbound send verbs (session reply, template) → INBOX_CONVERSE.
 *    Outbound honesty (the 24h window, opt-out suppression and delivered-only-
 *    on-provider-confirmation rules) is enforced INSIDE the send services, never
 *    from a client-asserted field; a closed window arrives as a POLICY refusal.
 */

function inboxActionFailure(
  error: unknown,
  context: string,
): ActionResult<never> {
  if (error instanceof SocialServiceError) {
    return fail(error.message, {
      code: socialErrorActionCode(error.code),
      ...(error.field
        ? { fieldErrors: { [error.field]: [error.message] } }
        : {}),
    });
  }
  if (error instanceof AuthorizationError) {
    return authorizationFailure(error, context);
  }
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again later.", {
    code: "INTERNAL",
  });
}

/* ---------------------------------- reads ----------------------------------- */

export async function listConversationsAction(rawInput: unknown): Promise<
  ActionResult<{
    conversations: ConversationListItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = listConversationsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "listConversationsAction");
  }

  try {
    const { conversations, total } = await listConversations(context, query);
    return {
      success: true,
      data: {
        conversations,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    return inboxActionFailure(err, "listConversationsAction");
  }
}

export async function getConversationAction(rawInput: unknown): Promise<
  ActionResult<{
    conversation: ConversationRow;
    messages: Prisma.ConversationMessageGetPayload<Record<string, never>>[];
    notes: Prisma.ConversationNoteGetPayload<Record<string, never>>[];
    labels: { id: string; name: string; color: string | null }[];
    responseTimeMs: number | null;
  }>
> {
  const session = await requireAuth();

  const parsed = conversationLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, conversationId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getConversationAction");
  }

  try {
    const thread = await getConversation(context, conversationId);
    return { success: true, data: thread };
  } catch (err) {
    return inboxActionFailure(err, "getConversationAction");
  }
}

/* --------------------------------- thread ops ------------------------------- */

export async function createNoteAction(rawInput: unknown): Promise<
  ActionResult<{
    note: Prisma.ConversationNoteGetPayload<Record<string, never>>;
  }>
> {
  const session = await requireAuth();

  const parsed = createNoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "createNoteAction");
  }

  try {
    const note = await createNote(context, session.user.id, data);
    return { success: true, data: { note } };
  } catch (err) {
    return inboxActionFailure(err, "createNoteAction");
  }
}

export async function assignConversationAction(
  rawInput: unknown,
): Promise<ActionResult<{ conversation: ConversationRow }>> {
  const session = await requireAuth();

  const parsed = assignConversationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "assignConversationAction");
  }

  try {
    const conversation = await assignConversation(
      context,
      session.user.id,
      data,
    );
    return { success: true, data: { conversation } };
  } catch (err) {
    return inboxActionFailure(err, "assignConversationAction");
  }
}

export async function setConversationStatusAction(
  rawInput: unknown,
): Promise<ActionResult<{ conversation: ConversationRow }>> {
  const session = await requireAuth();

  const parsed = setConversationStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, conversationId, status } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "setConversationStatusAction");
  }

  try {
    const conversation = await setStatus(
      context,
      session.user.id,
      conversationId,
      status,
    );
    return { success: true, data: { conversation } };
  } catch (err) {
    return inboxActionFailure(err, "setConversationStatusAction");
  }
}

export async function closeConversationAction(
  rawInput: unknown,
): Promise<ActionResult<{ conversation: ConversationRow }>> {
  const session = await requireAuth();

  const parsed = conversationLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, conversationId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "closeConversationAction");
  }

  try {
    const conversation = await closeConversation(
      context,
      session.user.id,
      conversationId,
    );
    return { success: true, data: { conversation } };
  } catch (err) {
    return inboxActionFailure(err, "closeConversationAction");
  }
}

export async function reopenConversationAction(
  rawInput: unknown,
): Promise<ActionResult<{ conversation: ConversationRow }>> {
  const session = await requireAuth();

  const parsed = conversationLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, conversationId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "reopenConversationAction");
  }

  try {
    const conversation = await reopenConversation(
      context,
      session.user.id,
      conversationId,
    );
    return { success: true, data: { conversation } };
  } catch (err) {
    return inboxActionFailure(err, "reopenConversationAction");
  }
}

/* ------------------------------- outbound send ------------------------------ */

/**
 * A free-form session reply. Gated by INBOX_CONVERSE and enforced server-side
 * inside the send service (24h window + opt-out); the request carries ONLY body
 * text — no window flag, no delivered claim.
 */
export async function converseSessionAction(
  rawInput: unknown,
): Promise<ActionResult<SendResult>> {
  const session = await requireAuth();

  const parsed = converseSessionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid reply.");
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_CONVERSE,
    );
  } catch (err) {
    return authorizationFailure(err, "converseSessionAction");
  }

  try {
    const result = await sendSessionMessage(context, session.user.id, data);
    return { success: true, data: result };
  } catch (err) {
    return inboxActionFailure(err, "converseSessionAction");
  }
}

export async function converseTemplateAction(
  rawInput: unknown,
): Promise<ActionResult<SendResult>> {
  const session = await requireAuth();

  const parsed = converseTemplateSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid template request.");
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_CONVERSE,
    );
  } catch (err) {
    return authorizationFailure(err, "converseTemplateAction");
  }

  try {
    const result = await sendTemplate(context, session.user.id, data);
    return { success: true, data: result };
  } catch (err) {
    return inboxActionFailure(err, "converseTemplateAction");
  }
}

/* ------------------------------- convert to lead ---------------------------- */

export async function conversationToLeadAction(rawInput: unknown): Promise<
  ActionResult<{
    leadId: string;
    documentId: string | null;
    documentCreated: boolean;
    needsDraftEditor: boolean;
  }>
> {
  const session = await requireAuth();

  const parsed = conversationToLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid conversion request.");
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    // INBOX_MANAGE: converting a thread reuses the 2A lead engine, which
    // re-authorizes LEADS_CREATE itself; the inbox verb gates the surface.
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "conversationToLeadAction");
  }

  try {
    const result = await conversationToLead(context, session.user.id, data);
    return { success: true, data: result };
  } catch (err) {
    return inboxActionFailure(err, "conversationToLeadAction");
  }
}

/* ---------------------------------- labels ---------------------------------- */

export async function listLabelsAction(
  rawInput: unknown,
): Promise<ActionResult<{ labels: LabelRow[] }>> {
  const session = await requireAuth();

  const parsed = listLabelsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      parsed.data.tenantId,
      PERMISSIONS.INBOX_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "listLabelsAction");
  }

  try {
    const labels = await listLabels(context);
    return { success: true, data: { labels } };
  } catch (err) {
    return inboxActionFailure(err, "listLabelsAction");
  }
}

export async function createLabelAction(
  rawInput: unknown,
): Promise<ActionResult<{ label: LabelRow }>> {
  const session = await requireAuth();

  const parsed = createLabelSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "createLabelAction");
  }

  try {
    const label = await createLabel(context, session.user.id, data);
    return { success: true, data: { label } };
  } catch (err) {
    return inboxActionFailure(err, "createLabelAction");
  }
}

export async function updateLabelAction(
  rawInput: unknown,
): Promise<ActionResult<{ label: LabelRow }>> {
  const session = await requireAuth();

  const parsed = updateLabelSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateLabelAction");
  }

  try {
    const label = await updateLabel(context, session.user.id, data);
    return { success: true, data: { label } };
  } catch (err) {
    return inboxActionFailure(err, "updateLabelAction");
  }
}

export async function deleteLabelAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = deleteLabelSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "deleteLabelAction");
  }

  try {
    await deleteLabel(context, session.user.id, data);
    return { success: true };
  } catch (err) {
    return inboxActionFailure(err, "deleteLabelAction");
  }
}

export async function attachLabelAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = attachLabelSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "attachLabelAction");
  }

  try {
    await attachLabel(context, session.user.id, data);
    return { success: true };
  } catch (err) {
    return inboxActionFailure(err, "attachLabelAction");
  }
}

export async function detachLabelAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = attachLabelSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "detachLabelAction");
  }

  try {
    await detachLabel(context, session.user.id, data);
    return { success: true };
  } catch (err) {
    return inboxActionFailure(err, "detachLabelAction");
  }
}

/* ------------------------------- quick replies ------------------------------ */

export async function listQuickRepliesAction(
  rawInput: unknown,
): Promise<ActionResult<{ quickReplies: QuickReplyRow[] }>> {
  const session = await requireAuth();

  const parsed = listQuickRepliesSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      parsed.data.tenantId,
      PERMISSIONS.INBOX_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "listQuickRepliesAction");
  }

  try {
    const quickReplies = await listQuickReplies(context);
    return { success: true, data: { quickReplies } };
  } catch (err) {
    return inboxActionFailure(err, "listQuickRepliesAction");
  }
}

export async function createQuickReplyAction(
  rawInput: unknown,
): Promise<ActionResult<{ quickReply: QuickReplyRow }>> {
  const session = await requireAuth();

  const parsed = createQuickReplySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "createQuickReplyAction");
  }

  try {
    const quickReply = await createQuickReply(context, session.user.id, data);
    return { success: true, data: { quickReply } };
  } catch (err) {
    return inboxActionFailure(err, "createQuickReplyAction");
  }
}

export async function updateQuickReplyAction(
  rawInput: unknown,
): Promise<ActionResult<{ quickReply: QuickReplyRow }>> {
  const session = await requireAuth();

  const parsed = updateQuickReplySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateQuickReplyAction");
  }

  try {
    const quickReply = await updateQuickReply(context, session.user.id, data);
    return { success: true, data: { quickReply } };
  } catch (err) {
    return inboxActionFailure(err, "updateQuickReplyAction");
  }
}

export async function deleteQuickReplyAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = deleteQuickReplySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INBOX_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "deleteQuickReplyAction");
  }

  try {
    await deleteQuickReply(context, session.user.id, data);
    return { success: true };
  } catch (err) {
    return inboxActionFailure(err, "deleteQuickReplyAction");
  }
}
