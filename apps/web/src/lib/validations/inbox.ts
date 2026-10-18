import { z } from "zod";

/**
 * Inbox validation (AGENT 03).
 *
 * Server-owned fields are never client-set and are stripped by these object
 * schemas (Zod drops unknown keys): `tenantId` is a re-authorized locator;
 * `id`, `unreadCount`, `lastInboundAt` / `lastOutboundAt` / `firstResponseAt`,
 * `closedAt`, `status` on create, `providerMessageId`, `aiDraft` provenance and
 * `optOutSnapshot` are all absent from every payload. Outbound send carries ONLY
 * body text — the 24h window, opt-out and template rules are computed
 * server-side and are never trusted from the client.
 */

const uuid = z.string().uuid("Invalid ID");

export const CONVERSATION_CHANNELS = [
  "WHATSAPP",
  "MESSENGER",
  "INSTAGRAM",
] as const;
export const conversationChannelSchema = z.enum(CONVERSATION_CHANNELS);
export type ConversationChannelValue = z.infer<
  typeof conversationChannelSchema
>;

export const CONVERSATION_STATUSES = ["OPEN", "PENDING", "CLOSED"] as const;
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export type ConversationStatusValue = z.infer<typeof conversationStatusSchema>;

export const listConversationsSchema = z.object({
  tenantId: uuid,
  channel: conversationChannelSchema.optional(),
  status: conversationStatusSchema.optional(),
  assignee: z
    .union([uuid, z.literal("unassigned"), z.literal("me")])
    .optional(),
  labelId: uuid.optional(),
  unread: z.boolean().optional(),
  q: z.string().max(100).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;

export const conversationLocatorSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
});
export type ConversationLocatorInput = z.infer<
  typeof conversationLocatorSchema
>;

/** An internal note (never a message; lives in its own table). */
export const createNoteSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
  body: z.string().trim().min(1, "A note cannot be empty").max(4000),
});
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const assignConversationSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
  /** `null` unassigns. */
  assignedToUserId: uuid.nullable(),
});
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;

export const setConversationStatusSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
  /** CLOSED is reached via close; PENDING/OPEN via reopen — never free-form. */
  status: z.enum(["OPEN", "PENDING"]),
});
export type SetConversationStatusInput = z.infer<
  typeof setConversationStatusSchema
>;

/* ---------------------------------- labels ---------------------------------- */

export const createLabelSchema = z.object({
  tenantId: uuid,
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Colour must be a 6-digit hex code")
    .optional(),
});
export type CreateLabelInput = z.infer<typeof createLabelSchema>;

export const updateLabelSchema = z.object({
  tenantId: uuid,
  labelId: uuid,
  name: z.string().trim().min(1).max(60).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Colour must be a 6-digit hex code")
    .nullable()
    .optional(),
});
export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;

export const deleteLabelSchema = z.object({
  tenantId: uuid,
  labelId: uuid,
});
export type DeleteLabelInput = z.infer<typeof deleteLabelSchema>;

export const listLabelsSchema = z.object({ tenantId: uuid });

export const attachLabelSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
  labelId: uuid,
});
export type AttachLabelInput = z.infer<typeof attachLabelSchema>;

/* ------------------------------- quick replies ------------------------------ */

export const createQuickReplySchema = z.object({
  tenantId: uuid,
  shortcut: z.string().trim().min(1).max(40),
  body: z.string().trim().min(1).max(4000),
  position: z.number().int().min(0).max(1000).optional(),
  // `aiProvenance` is deliberately ABSENT: provenance is a server-set flag.
});
export type CreateQuickReplyInput = z.infer<typeof createQuickReplySchema>;

export const updateQuickReplySchema = z.object({
  tenantId: uuid,
  quickReplyId: uuid,
  shortcut: z.string().trim().min(1).max(40).optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export type UpdateQuickReplyInput = z.infer<typeof updateQuickReplySchema>;

export const deleteQuickReplySchema = z.object({
  tenantId: uuid,
  quickReplyId: uuid,
});
export type DeleteQuickReplyInput = z.infer<typeof deleteQuickReplySchema>;

export const listQuickRepliesSchema = z.object({ tenantId: uuid });

/* --------------------------------- outbound ------------------------------- */

/**
 * An outbound session reply. The ONLY client input is the body text: the
 * window state, opt-out suppression and template-only rule are enforced
 * server-side against `Conversation.lastInboundAt` and the contact's opt-out,
 * never from the request.
 */
export const converseSessionSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
  text: z.string().trim().min(1, "A reply cannot be empty").max(4096),
  // A staff-entered reply is not an AI draft; `aiDraft` is not settable here.
});
export type ConverseSessionInput = z.infer<typeof converseSessionSchema>;

export const converseTemplateSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
  templateName: z.string().trim().min(1).max(200),
  languageCode: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(_[A-Z]{2})?$/, "Invalid language code"),
  variables: z.array(z.string().trim().max(200)).max(20).default([]),
});
export type ConverseTemplateInput = z.infer<typeof converseTemplateSchema>;

/* -------------------------------- conversion ------------------------------- */

/**
 * Convert a conversation to a lead (and optionally a draft). The lead detail
 * fields mirror the 2A lead surface; the source is forced to SOCIAL here and
 * `tenantId` is a re-authorized locator. The 2A/2B engines are reused, not
 * reimplemented, so contact/document rules cannot drift.
 */
export const conversationToLeadSchema = z.object({
  tenantId: uuid,
  conversationId: uuid,
  firstName: z.string().max(100).trim().optional().or(z.literal("")),
  lastName: z.string().max(100).trim().optional().or(z.literal("")),
  companyName: z.string().max(200).trim().optional().or(z.literal("")),
  email: z
    .string()
    .trim()
    .email("Invalid email")
    .max(254)
    .optional()
    .or(z.literal("")),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Currency must be ISO-3")
    .default("KES"),
  /** Optional draft raised through the 2B documents engine. */
  createDraft: z.enum(["quotation", "order"]).optional(),
});
export type ConversationToLeadInput = z.infer<typeof conversationToLeadSchema>;
