import type { ActionErrorCode } from "@/lib/errors";

/**
 * Shared service error for the AGENT 03 social-commerce surfaces
 * (integrations, inbox, marketing).
 *
 * It mirrors `CrmServiceError` from the leads engine: services throw this and
 * the Server Actions map it onto the `ActionResult` vocabulary, so an expected
 * refusal (not found, illegal transition, closed window, disconnected
 * integration) is distinguishable from an unexpected internal fault and never
 * leaks an internal message or a credential to the client.
 */

export type SocialServiceErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  /** The provider/integration is unavailable or refused — operator-visible. */
  | "PROVIDER_UNAVAILABLE"
  /** A policy refusal that is not a permission miss (closed window, opt-out). */
  | "POLICY";

export class SocialServiceError extends Error {
  readonly code: SocialServiceErrorCode;
  readonly field: string | undefined;

  constructor(code: SocialServiceErrorCode, message: string, field?: string) {
    super(message);
    this.name = "SocialServiceError";
    this.code = code;
    this.field = field;
  }
}

/** Maps a social service error onto the shared action error vocabulary. */
export function socialErrorActionCode(
  code: SocialServiceErrorCode,
): ActionErrorCode {
  switch (code) {
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "CONFLICT":
      return "CONFLICT";
    case "VALIDATION":
      return "VALIDATION_ERROR";
    case "POLICY":
      return "FORBIDDEN";
    case "PROVIDER_UNAVAILABLE":
      return "INTERNAL";
  }
}

/** Canonical audit action names for the social-commerce surfaces. */
export const SOCIAL_AUDIT_ACTIONS = {
  CONNECTION_CONNECTED: "integration.connected",
  CONNECTION_VERIFIED: "integration.verified",
  CONNECTION_DISCONNECTED: "integration.disconnected",
  WEBHOOK_PARKED: "webhook.parked",
  WEBHOOK_APPLIED: "webhook.applied",
  WEBHOOK_FORGED: "webhook.forgedRejected",
  CONVERSATION_ASSIGNED: "inbox.conversationAssigned",
  CONVERSATION_STATUS: "inbox.conversationStatus",
  CONVERSATION_NOTE: "inbox.noteAdded",
  CONVERSATION_MESSAGE_SENT: "inbox.messageSent",
  CONVERSATION_CONVERTED: "inbox.conversationConverted",
  LABEL_CREATED: "inbox.labelCreated",
  LABEL_UPDATED: "inbox.labelUpdated",
  LABEL_DELETED: "inbox.labelDeleted",
  LABEL_ATTACHED: "inbox.labelAttached",
  QUICK_REPLY_CREATED: "inbox.quickReplyCreated",
  QUICK_REPLY_UPDATED: "inbox.quickReplyUpdated",
  QUICK_REPLY_DELETED: "inbox.quickReplyDeleted",
  CAMPAIGN_CREATED: "marketing.campaignCreated",
  CAMPAIGN_UPDATED: "marketing.campaignUpdated",
  CAMPAIGN_STATUS: "marketing.campaignStatus",
  CONTENT_POST_CREATED: "marketing.contentPostCreated",
  CONTENT_POST_REVIEWED: "marketing.contentPostReviewed",
  CONTENT_POST_SCHEDULED: "marketing.contentPostScheduled",
  PUBLISH_JOB_QUEUED: "marketing.publishJobQueued",
  MEDIA_UPLOADED: "marketing.mediaUploaded",
  MEDIA_DELETED: "marketing.mediaDeleted",
} as const;
