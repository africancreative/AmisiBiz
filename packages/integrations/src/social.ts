import {
  failed,
  isVerified,
  unverified,
  verifiedByProvider,
  type Failed,
  type IntegrationOutcome,
  type Verified,
} from "./verification";

/**
 * Social-commerce channel boundary (AGENT 03 module A).
 *
 * This module extends `@amisibiz/integrations` exactly the way the eTIMS,
 * payment and POS ports already do: it carries the *shape* of a provider
 * exchange and the honesty rule that a stand-in can never confirm anything.
 * The rules it keeps, inherited from `./verification.ts` and the register
 * hardening contracts:
 *
 *  - **Every method returns `IntegrationOutcome<T>`.** Only a real provider
 *    answer (source `"provider"`) can be `verified`; the mock below is
 *    physically incapable of producing one, so no driven-through-mock message
 *    or publish can ever be recorded as delivered or live.
 *  - **No I/O lives in this package.** The concrete network call and the
 *    AES cipher are *injected* (`SocialTransport`, `CipherPrimitives`) and are
 *    supplied by the server runtime, which owns credentials. Nothing here
 *    reads an environment variable, opens a socket, or handles a bearer.
 *    This is the same posture as the other adapters: the boundary is a
 *    contract; wiring a real provider is the caller's, owner-gated concern.
 *  - **Raw provider payloads stop at the adapter edge.** Each method parses
 *    the Graph envelope into a normalized domain type; the caller never sees
 *    a provider-native blob.
 *  - **Timeout bounds (register hardening rule #1, ≤ 10 000 ms).** Every
 *    request the adapters build carries an explicit `timeoutMs`; the injected
 *    transport must enforce it. `GRAPH_REQUEST_TIMEOUT_MS` caps it at the
 *    mandated ceiling.
 *  - **Rate limits are respected, not guessed.** A `429` (or a `Retry-After`
 *    hint) is classified `RATE_LIMIT` so the caller can back off; nothing is
 *    auto-retried past an `AUTH` class (a revoked credential must not be
 *    hammered).
 *
 * Credential reality (design spec §0): this workspace has no access bearer and
 * no phone-number id, so the live adapters are exercised only against a fake
 * transport in tests. No claim is made that live messaging or live publishing
 * works; the capability labels below are the honest ceiling.
 */

/* ------------------------------ normalized types ---------------------------- */

/** A message projected into AmisiBiz's own shape; never the provider blob. */
export type NormalizedMessage = {
  /** The provider's id for this message, used for idempotent inbound upsert. */
  readonly providerMessageId: string | null;
  readonly direction: "inbound" | "outbound";
  /** The customer's provider-side key (a phone number, a PSID, an IG-scoped id). */
  readonly externalId: string;
  readonly text: string;
  /** ISO-8601 UTC when the provider says the message was sent. */
  readonly timestampIso: string;
  /** Opaque media descriptors; the caller resolves them against the connection. */
  readonly mediaRefs: readonly unknown[];
};

/** A receipt for an outbound send. `providerMessageId` proves delivery. */
export type SendReceipt = {
  readonly providerMessageId: string;
  readonly state: "sent" | "queued" | "failed";
};

/** A reference back from a publish: the id the provider assigned the post. */
export type PublishedRef = {
  readonly providerRef: string;
  /** Any permalinks the provider returned; present only for a real publish. */
  readonly permalinks: readonly string[];
};

/** Facts a `verifyConnection` probe establishes about the credential. */
export type ConnectionFacts = {
  readonly phoneNumberId: string | null;
  readonly pageId: string | null;
  readonly instagramUserId: string | null;
  readonly grantedScopes: readonly string[];
  /** ISO-8601 UTC expiry the provider reports for the credential, if any. */
  readonly expiresAt: string | null;
};

/**
 * Whether a capability is real in this build. The labels mirror design spec
 * §1 verbatim so the setup screen can render them honestly per tenant.
 *  - `SANDBOX_ONLY`       — contract + tests exist; no live credential.
 *  - `REQUIRES_APPROVAL`  — needs a Meta app-review / permission grant.
 *  - `UNSUPPORTED`        — prohibited by the constitution (no code path).
 * `LIVE` is reserved for a future build that actually holds the credential.
 */
export type ProviderCapabilityStatus =
  "SANDBOX_ONLY" | "REQUIRES_APPROVAL" | "UNSUPPORTED" | "LIVE";

export type ProviderCapability = {
  readonly key: string;
  readonly status: ProviderCapabilityStatus;
  readonly label: string;
  readonly blocker: string;
};

/* --------------------------------- budgets ---------------------------------- */

/**
 * Register hardening rule #1: every outbound provider request must enforce an
 * explicit timeout capped at 10 000 ms. The adapters stamp this on every
 * request they build; the transport enforces it.
 */
export const GRAPH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Documented provider rate ceilings (from the fetched primary docs, 2026-10-18),
 * carried as constants so the publish queue budgets against a real number
 * instead of a guess. Messaging concurrency is provider-reported per tier and
 * is therefore declared as `null` (reactive back-off only), not invented here.
 */
export const IG_API_POSTS_PER_24H = 100;
export const FB_PAGE_POSTS_CONCURRENCY = null;
export const WHATSAPP_MESSAGING_TIER_LIMIT = null;

/**
 * The publish retry ladder (design spec §3). Exposed package-side so both the
 * adapter documentation and the server publish runner read the same schedule:
 * attempt delays 1m / 5m / 25m / 2h / 6h, then the job is ABANDONED.
 */
export const PUBLISH_RETRY_LADDER_MS: readonly number[] = [
  60_000, 300_000, 1_500_000, 7_200_000, 21_600_000,
];
export const PUBLISH_MAX_ATTEMPTS = PUBLISH_RETRY_LADDER_MS.length;

/** The failure taxonomy a publish attempt lands in (mirrors PublishJob enum). */
export type SocialErrorClass =
  "AUTH" | "RATE_LIMIT" | "PERMISSION" | "CONTENT" | "NETWORK" | "UNKNOWN";

/* -------------------------------- transport --------------------------------- */

/** The request an adapter asks the injected transport to make. */
export type SocialHttpRequest = {
  readonly method: "GET" | "POST";
  /** Fully-built URL. The adapter only ever concatenates an injected base —
   *  this package holds no host literal. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
};

/** The minimal response shape the transport hands back. */
export type SocialHttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
};

/**
 * The HTTP primitive the server injects. Kept as a function type so this
 * package stays free of any global: no socket, no `AbortSignal`, no `fetch`
 * reference ever appears here. The server's implementation enforces
 * `timeoutMs` and returns the raw status/headers/body.
 */
export type SocialTransport = (
  request: SocialHttpRequest,
) => Promise<SocialHttpResponse>;

/* -------------------------------- credential -------------------------------- */

/**
 * The construction input for a live adapter. A caller builds it ONLY from
 * server-held values (the decrypted credential + the connection metadata); a
 * missing bearer or missing provider-side id is an unconfigured state, never a
 * simulated success. `graphBaseUrl` is supplied by the caller (no host literal
 * lives in this package).
 */
export type ChannelCredential = {
  readonly graphBaseUrl: string;
  readonly apiVersion: string;
  readonly transport: SocialTransport;
  /** The long-lived access credential. Empty ⇒ unconfigured. */
  readonly bearer: string;
  readonly phoneNumberId?: string;
  readonly pageId?: string;
  readonly instagramUserId?: string;
};

/* --------------------------------- interface -------------------------------- */

/** The one port every social channel — live or mock — satisfies. */
export interface SocialChannelAdapter {
  readonly name: string;
  readonly isLive: boolean;
  capabilities(): readonly ProviderCapability[];
  verifyConnection(
    credential: ChannelCredential,
  ): Promise<IntegrationOutcome<ConnectionFacts>>;
  fetchConversationPage(
    externalId: string,
    pageCursor?: string,
  ): Promise<IntegrationOutcome<readonly NormalizedMessage[]>>;
  sendSessionMessage(
    externalId: string,
    text: string,
  ): Promise<IntegrationOutcome<SendReceipt>>;
  sendTemplate(
    externalId: string,
    templateName: string,
    languageCode: string,
    variables: readonly string[],
  ): Promise<IntegrationOutcome<SendReceipt>>;
  markConversation(
    externalId: string,
    state: "read",
  ): Promise<IntegrationOutcome<unknown>>;
  publishPost(
    text: string,
    mediaRefs: readonly string[],
  ): Promise<IntegrationOutcome<PublishedRef>>;
}

/* ----------------------------- shared graph logic --------------------------- */

/** Truncate + strip to a bounded, provider-safe error detail (no credential). */
function safeDetail(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/**
 * Classify a Graph response into the shared error taxonomy. Kept as a pure
 * helper (exported) so the server publish runner can decide whether a
 * PublishJob should stop the ladder (AUTH) or back off (RATE_LIMIT) using the
 * SAME rule the adapters apply.
 */
export function classifyGraphResponse(
  status: number,
  body: string,
  headers: Readonly<Record<string, string | undefined>>,
): SocialErrorClass {
  if (status === 429 || headers["retry-after"] !== undefined) {
    return "RATE_LIMIT";
  }
  let code: number | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    // Only the numeric code drives classification; the human message is
    // extracted separately (graphMessage) so this stays a pure classifier.
    code = (parsed as { error?: { code?: number } }).error?.code;
  } catch {
    // Non-JSON body: status-driven rules below still classify it.
  }
  // Graph auth codes: 100/190 invalid or expired credential, 340 revoked.
  if (status === 401 || code === 190 || code === 340 || code === 102) {
    return "AUTH";
  }
  if (status === 403 || code === 10 || code === 200 || code === 368) {
    return "PERMISSION";
  }
  if (status >= 400 && status < 500 && code === undefined) {
    return "CONTENT";
  }
  if (status === 0 || status >= 500) {
    return "NETWORK";
  }
  return "UNKNOWN";
}

/** Extract a short human message from a Graph error blob for a safe detail. */
function graphMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const err = (parsed as { error?: { message?: string; code?: number } })
      .error;
    const code = err?.code !== undefined ? ` (code ${err.code})` : "";
    return `${err?.message ?? "provider error"}${code}`;
  } catch {
    return "provider error";
  }
}

/**
 * A shared base carrying the transport call, the timeout stamp and the
 * unconfigured guard. Concrete channels implement the Graph-specific request
 * building and response parsing. `isLive` is true here: a mock never extends
 * this class, so a stand-in cannot accidentally gain a real HTTP path.
 */
abstract class BaseGraphAdapter implements SocialChannelAdapter {
  abstract readonly name: string;
  readonly isLive = true;

  protected readonly credential: ChannelCredential;

  constructor(credential: ChannelCredential) {
    this.credential = credential;
  }

  abstract capabilities(): readonly ProviderCapability[];

  protected get configured(): boolean {
    return this.credential.bearer.trim().length > 0;
  }

  protected get base(): string {
    return this.credential.graphBaseUrl.replace(/\/+$/, "");
  }

  /** Refusal for an unconfigured channel: a failure, never a fake success. */
  protected unconfigured(detail: string): Failed {
    return failed("manual", `${this.name}: not configured — ${detail}`);
  }

  protected async post(
    path: string,
    payload: unknown,
  ): Promise<SocialHttpResponse> {
    const url = `${this.base}/${this.credential.apiVersion}${path}`;
    return this.credential.transport({
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.credential.bearer}`,
      },
      body: JSON.stringify(payload),
      timeoutMs: GRAPH_REQUEST_TIMEOUT_MS,
    });
  }

  protected async get(
    path: string,
    query: Record<string, string | undefined>,
  ): Promise<SocialHttpResponse> {
    // Build the query string by hand: this package holds no URL global (it
    // stays platform-neutral), and the caller supplies the base host.
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined)
        parts.push(`${key}=${encodeURIComponent(value)}`);
    }
    const qs = parts.join("&");
    const url = `${this.base}/${this.credential.apiVersion}${path}${
      qs ? `?${qs}` : ""
    }`;
    return this.credential.transport({
      method: "GET",
      url,
      headers: { Authorization: `Bearer ${this.credential.bearer}` },
      timeoutMs: GRAPH_REQUEST_TIMEOUT_MS,
    });
  }

  /**
   * A transport exception is observed by us (the client), never a provider
   * answer; classified NETWORK so the caller can back off. The message is
   * stripped so a thrown error never carries the bearer.
   */
  protected networkFailure(err: unknown): Failed {
    const raw = err instanceof Error ? err.message : String(err);
    return failed("client", `${this.name}: transport error ${safeDetail(raw)}`);
  }

  /** Translate a non-2xx Graph response into a classified failure. */
  protected providerFailure(res: SocialHttpResponse): Failed {
    const cls = classifyGraphResponse(res.status, res.body, res.headers);
    return failed(
      "provider",
      `${this.name}: ${cls} ${safeDetail(graphMessage(res.body))}`,
    );
  }

  protected parse(body: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  // Default: a generic Graph identity probe of the current user/app. The
  // concrete channels refine what they read out of it. The bearer travels only
  // in the Authorization header (no credential appears in a URL query).
  async verifyConnection(
    credential: ChannelCredential,
  ): Promise<IntegrationOutcome<ConnectionFacts>> {
    if (credential.bearer.trim().length === 0) {
      return this.unconfigured("no access credential supplied");
    }
    try {
      const url = `${credential.graphBaseUrl.replace(/\/+$/, "")}/${
        credential.apiVersion
      }/me?fields=id,name`;
      const res = await credential.transport({
        method: "GET",
        url,
        headers: { Authorization: `Bearer ${credential.bearer}` },
        timeoutMs: GRAPH_REQUEST_TIMEOUT_MS,
      });
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      return verifiedByProvider(
        `verify:${this.name}`,
        this.factsFromVerify(res.body),
      );
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  protected factsFromVerify(_body: string): ConnectionFacts {
    return {
      phoneNumberId: this.credential.phoneNumberId ?? null,
      pageId: this.credential.pageId ?? null,
      instagramUserId: this.credential.instagramUserId ?? null,
      grantedScopes: [],
      expiresAt: null,
    };
  }

  abstract fetchConversationPage(
    externalId: string,
    pageCursor?: string,
  ): Promise<IntegrationOutcome<readonly NormalizedMessage[]>>;

  abstract sendSessionMessage(
    externalId: string,
    text: string,
  ): Promise<IntegrationOutcome<SendReceipt>>;

  abstract sendTemplate(
    externalId: string,
    templateName: string,
    languageCode: string,
    variables: readonly string[],
  ): Promise<IntegrationOutcome<SendReceipt>>;

  abstract markConversation(
    externalId: string,
    state: "read",
  ): Promise<IntegrationOutcome<unknown>>;

  abstract publishPost(
    text: string,
    mediaRefs: readonly string[],
  ): Promise<IntegrationOutcome<PublishedRef>>;
}

/* ------------------------------ WhatsApp (Meta) ----------------------------- */

/**
 * WhatsApp Cloud API channel. Messaging goes to `/{phoneNumberId}/messages`;
 * templates are the only message type allowed once the 24h customer-service
 * window closes. Publishing is not a WhatsApp concept, so `publishPost`
 * reports UNSUPPORTED rather than faking it.
 */
export class MetaWhatsAppAdapter extends BaseGraphAdapter {
  readonly name = "meta-whatsapp";

  constructor(credential: ChannelCredential) {
    super(credential);
    if (
      !credential.phoneNumberId ||
      credential.phoneNumberId.trim().length === 0
    ) {
      // Deliberately NOT throwing: an unconfigured adapter is a state the
      // setup screen renders. Every method then returns a failure.
    }
  }

  capabilities(): readonly ProviderCapability[] {
    return [
      {
        key: "whatsapp_inbound",
        status: "SANDBOX_ONLY",
        label: "WhatsApp webhook receive (inbound + status)",
        blocker: "needs credential + Meta app in Live mode",
      },
      {
        key: "whatsapp_session_reply",
        status: "SANDBOX_ONLY",
        label: "WhatsApp session replies (24h window)",
        blocker: "same credential gap",
      },
      {
        key: "whatsapp_templates",
        status: "REQUIRES_APPROVAL",
        label: "WhatsApp templates",
        blocker: "Meta template review per template",
      },
      {
        key: "whatsapp_marketing_outbound",
        status: "REQUIRES_APPROVAL",
        label: "WhatsApp marketing-initiated outbound",
        blocker: "opt-in rules + template approval",
      },
      {
        key: "whatsapp_web_automation",
        status: "UNSUPPORTED",
        label: "WhatsApp Web automation",
        blocker: "prohibited by the constitution (no code path)",
      },
    ];
  }

  private get hasPhone(): boolean {
    return (
      !!this.credential.phoneNumberId &&
      this.credential.phoneNumberId.trim().length > 0
    );
  }

  async fetchConversationPage(
    externalId: string,
    pageCursor?: string,
  ): Promise<IntegrationOutcome<readonly NormalizedMessage[]>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPhone) return this.unconfigured("no phone number id");
    try {
      const res = await this.get(`/${this.credential.phoneNumberId}/messages`, {
        // Read the thread with the customer. The Cloud API exposes this
        // through the conversation lookup by customer id.
        contact_user_ids: JSON.stringify([externalId]),
        ...(pageCursor ? { after: pageCursor } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      return verifiedByProvider(
        `page:${this.credential.phoneNumberId}:${externalId}`,
        this.normalizeMessages(res.body, externalId),
      );
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  private normalizeMessages(
    body: string,
    externalId: string,
  ): readonly NormalizedMessage[] {
    const parsed = this.parse(body);
    const list = Array.isArray(parsed.data) ? (parsed.data as unknown[]) : [];
    return list.map((raw) => {
      const item = raw as Record<string, unknown>;
      const ts = String(item.timestamp ?? new Date().toISOString());
      const types = item.types as { text?: { body?: string } } | undefined;
      const text =
        typeof types?.text?.body === "string"
          ? types.text.body
          : String(item.body ?? "");
      return {
        providerMessageId: typeof item.id === "string" ? item.id : null,
        direction: "inbound" as const,
        externalId,
        text,
        timestampIso: ts,
        mediaRefs: Array.isArray(item.media) ? (item.media as unknown[]) : [],
      } satisfies NormalizedMessage;
    });
  }

  async sendSessionMessage(
    externalId: string,
    text: string,
  ): Promise<IntegrationOutcome<SendReceipt>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPhone) return this.unconfigured("no phone number id");
    const payload = {
      messaging_product: "whatsapp",
      to: externalId,
      type: "text",
      text: { body: text },
    };
    return this.sendMessages(payload, "session");
  }

  async sendTemplate(
    externalId: string,
    templateName: string,
    languageCode: string,
    variables: readonly string[],
  ): Promise<IntegrationOutcome<SendReceipt>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPhone) return this.unconfigured("no phone number id");
    const payload = {
      messaging_product: "whatsapp",
      to: externalId,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components:
          variables.length > 0
            ? [
                {
                  type: "body",
                  parameters: variables.map((value) => ({
                    type: "text",
                    text: value,
                  })),
                },
              ]
            : [],
      },
    };
    return this.sendMessages(payload, "template");
  }

  private async sendMessages(
    payload: unknown,
    kind: string,
  ): Promise<IntegrationOutcome<SendReceipt>> {
    try {
      const res = await this.post(
        `/${this.credential.phoneNumberId}/messages`,
        payload,
      );
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      const parsed = this.parse(res.body);
      const messages = Array.isArray(parsed.messages)
        ? (parsed.messages as unknown[])
        : [];
      const first = messages[0] as { id?: string } | undefined;
      const id = first?.id;
      if (typeof id !== "string" || id.length === 0) {
        // No provider id ⇒ nothing was confirmed. Report a failure, never an
        // optimistic receipt.
        return failed(
          "provider",
          `${this.name}: provider returned no message id for ${kind} send`,
        );
      }
      return verifiedByProvider(id, {
        providerMessageId: id,
        state: "sent",
      });
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  async markConversation(
    externalId: string,
    state: "read",
  ): Promise<IntegrationOutcome<unknown>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPhone) return this.unconfigured("no phone number id");
    try {
      const res = await this.post(
        `/${this.credential.phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          status: state,
          message_id: externalId,
        },
      );
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      return verifiedByProvider(`read:${externalId}`, { marked: state });
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  async publishPost(): Promise<IntegrationOutcome<PublishedRef>> {
    return failed(
      "manual",
      `${this.name}: publishPost is not a WhatsApp capability (UNSUPPORTED)`,
    );
  }
}

/* ------------------------------- FB Page (Meta) ----------------------------- */

/**
 * Facebook Page channel: Messenger inbox + Page feed publishing. Publishing
 * requires pages_manage_posts + Page Publishing Authorization, hence the
 * REQUIRES_APPROVAL label. Messenger send uses the per-customer conversation
 * id (PSID).
 */
export class MetaFbPageAdapter extends BaseGraphAdapter {
  readonly name = "meta-fb-page";

  capabilities(): readonly ProviderCapability[] {
    return [
      {
        key: "messenger_inbox",
        status: "REQUIRES_APPROVAL",
        label: "FB Page inbox (Messenger Platform)",
        blocker: "pages_messaging + app review + Page access",
      },
      {
        key: "fb_comments",
        status: "REQUIRES_APPROVAL",
        label: "FB Page comments & interaction events",
        blocker: "pages_manage_engagement review",
      },
      {
        key: "fb_publish",
        status: "REQUIRES_APPROVAL",
        label: "FB Page publishing",
        blocker: "pages_manage_posts + Page Publishing Authorization",
      },
    ];
  }

  private get hasPage(): boolean {
    return !!this.credential.pageId && this.credential.pageId.trim().length > 0;
  }

  async fetchConversationPage(
    externalId: string,
    pageCursor?: string,
  ): Promise<IntegrationOutcome<readonly NormalizedMessage[]>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPage) return this.unconfigured("no page id");
    try {
      const res = await this.get(`/${this.credential.pageId}/conversations`, {
        fields: "messages{message,from,created_time}",
        ...(pageCursor ? { after: pageCursor } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      return verifiedByProvider(
        `conv:${this.credential.pageId}:${externalId}`,
        this.normalizeMessages(res.body, externalId),
      );
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  private normalizeMessages(
    body: string,
    externalId: string,
  ): readonly NormalizedMessage[] {
    const parsed = this.parse(body);
    const data = Array.isArray(parsed.data) ? (parsed.data as unknown[]) : [];
    // Conversation → flatten the nested message edges into normalized rows.
    const out: NormalizedMessage[] = [];
    for (const conv of data) {
      const messagesField = (conv as { messages?: { data?: unknown[] } })
        .messages?.data;
      if (!Array.isArray(messagesField)) continue;
      for (const raw of messagesField) {
        const item = raw as Record<string, unknown>;
        const from = item.from as { id?: string } | undefined;
        const inbound = from?.id !== this.credential.pageId;
        out.push({
          providerMessageId: typeof item.id === "string" ? item.id : null,
          direction: inbound ? "inbound" : "outbound",
          externalId,
          text: String(item.message ?? ""),
          timestampIso: String(item.created_time ?? new Date().toISOString()),
          mediaRefs: [],
        });
      }
    }
    return out;
  }

  async sendSessionMessage(
    externalId: string,
    text: string,
  ): Promise<IntegrationOutcome<SendReceipt>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPage) return this.unconfigured("no page id");
    try {
      const res = await this.post(`/${this.credential.pageId}/messages`, {
        recipient: { id: externalId },
        message: { text },
      });
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      const parsed = this.parse(res.body);
      const mid =
        typeof parsed.message_id === "string" ? parsed.message_id : null;
      if (!mid) {
        return failed(
          "provider",
          `${this.name}: provider returned no message id`,
        );
      }
      return verifiedByProvider(mid, {
        providerMessageId: mid,
        state: "sent",
      });
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  async sendTemplate(): Promise<IntegrationOutcome<SendReceipt>> {
    return failed(
      "manual",
      `${this.name}: structured templates are a WhatsApp capability; Messenger uses tagged messages, not templates`,
    );
  }

  async markConversation(
    externalId: string,
    state: "read",
  ): Promise<IntegrationOutcome<unknown>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPage) return this.unconfigured("no page id");
    try {
      const res = await this.post(
        `/${this.credential.pageId}/conversations/${externalId}/read`,
        {},
      );
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      return verifiedByProvider(`read:${externalId}`, { marked: state });
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  async publishPost(
    text: string,
    mediaRefs: readonly string[],
  ): Promise<IntegrationOutcome<PublishedRef>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasPage) return this.unconfigured("no page id");
    try {
      const res = await this.post(`/${this.credential.pageId}/feed`, {
        message: text,
        ...(mediaRefs.length > 0 ? { published: true } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      const parsed = this.parse(res.body);
      const id = typeof parsed.id === "string" ? parsed.id : null;
      if (!id) {
        return failed("provider", `${this.name}: provider returned no post id`);
      }
      return verifiedByProvider(id, { providerRef: id, permalinks: [] });
    } catch (err) {
      return this.networkFailure(err);
    }
  }
}

/* ------------------------------- Instagram ---------------------------------- */

/**
 * Instagram channel. Two stacks: content publishing (container → publish, the
 * documented two-call flow with a 100 API-posts/24h ceiling that our own queue
 * budgets against) and Direct Messaging (separate permission, REQUIRES_APPROVAL
 * because it needs advanced access review). Instagram has no native scheduler,
 * so the server queue — not the provider — is the scheduler.
 */
export class MetaInstagramAdapter extends BaseGraphAdapter {
  readonly name = "meta-instagram";

  capabilities(): readonly ProviderCapability[] {
    return [
      {
        key: "ig_publish",
        status: "SANDBOX_ONLY",
        label: "IG content publishing (+ our queue is the scheduler)",
        blocker: "two API stacks; standard access; 100 API posts/24h",
      },
      {
        key: "ig_dm",
        status: "REQUIRES_APPROVAL",
        label: "IG Direct Messaging",
        blocker: "instagram_manage_messages + advanced access review",
      },
      {
        key: "ig_comments",
        status: "REQUIRES_APPROVAL",
        label: "IG comments & interaction events",
        blocker: "instagram_manage_comments review",
      },
      {
        key: "dm_scraping",
        status: "UNSUPPORTED",
        label: "Instagram DM scraping",
        blocker: "prohibited by the constitution (no code path)",
      },
    ];
  }

  private get hasIg(): boolean {
    return (
      !!this.credential.instagramUserId &&
      this.credential.instagramUserId.trim().length > 0
    );
  }

  async fetchConversationPage(
    externalId: string,
    pageCursor?: string,
  ): Promise<IntegrationOutcome<readonly NormalizedMessage[]>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasIg) return this.unconfigured("no instagram account id");
    try {
      const res = await this.get(
        `/${this.credential.instagramUserId}/messages`,
        {
          ...(pageCursor ? { since: pageCursor } : {}),
        },
      );
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      const parsed = this.parse(res.body);
      const events = Array.isArray(parsed.data)
        ? (parsed.data as unknown[])
        : [];
      const normalized = events.map((raw) => {
        const item = raw as Record<string, unknown>;
        const msg = item.message as { text?: string } | undefined;
        return {
          providerMessageId: typeof item.id === "string" ? item.id : null,
          direction: "inbound" as const,
          externalId,
          text: typeof msg?.text === "string" ? msg.text : "",
          timestampIso: new Date().toISOString(),
          mediaRefs: [],
        } satisfies NormalizedMessage;
      });
      return verifiedByProvider(
        `igpage:${this.credential.instagramUserId}:${externalId}`,
        normalized,
      );
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  async sendSessionMessage(
    externalId: string,
    text: string,
  ): Promise<IntegrationOutcome<SendReceipt>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasIg) return this.unconfigured("no instagram account id");
    try {
      const res = await this.post(
        `/${this.credential.instagramUserId}/messages`,
        { recipient: externalId, message: text },
      );
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      const parsed = this.parse(res.body);
      const evt = parsed as { event_id?: unknown };
      const mid = typeof evt.event_id === "string" ? evt.event_id : null;
      if (!mid) {
        return failed(
          "provider",
          `${this.name}: provider returned no message id for DM send`,
        );
      }
      return verifiedByProvider(mid, {
        providerMessageId: mid,
        state: "sent",
      });
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  async sendTemplate(): Promise<IntegrationOutcome<SendReceipt>> {
    return failed(
      "manual",
      `${this.name}: templates are a WhatsApp capability; Instagram DM has no template construct`,
    );
  }

  async markConversation(
    externalId: string,
    state: "read",
  ): Promise<IntegrationOutcome<unknown>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasIg) return this.unconfigured("no instagram account id");
    try {
      const res = await this.post(
        `/${this.credential.instagramUserId}/messages`,
        { recipient: externalId, sender_action: "done" },
      );
      if (res.status < 200 || res.status >= 300) {
        return this.providerFailure(res);
      }
      return verifiedByProvider(`read:${externalId}`, { marked: state });
    } catch (err) {
      return this.networkFailure(err);
    }
  }

  /**
   * Two-call publish: create a media container for the caption, then publish
   * it. Only a provider id from the publish step makes the post `verified`;
   * any earlier refusal is classified so the caller can back off the ladder.
   */
  async publishPost(
    text: string,
    mediaRefs: readonly string[],
  ): Promise<IntegrationOutcome<PublishedRef>> {
    if (!this.configured) return this.unconfigured("no access credential");
    if (!this.hasIg) return this.unconfigured("no instagram account id");
    if (mediaRefs.length === 0) {
      // IG feed publishing requires at least one media url; refusing here is
      // the honest answer rather than a container the provider would reject.
      return failed(
        "manual",
        `${this.name}: publishPost needs at least one media reference`,
      );
    }
    try {
      const container = await this.post(
        `/${this.credential.instagramUserId}/media`,
        { image_url: mediaRefs[0], caption: text },
      );
      if (container.status < 200 || container.status >= 300) {
        return this.providerFailure(container);
      }
      const created = this.parse(container.body);
      const creationId = typeof created.id === "string" ? created.id : null;
      if (!creationId) {
        return failed(
          "provider",
          `${this.name}: provider returned no container id`,
        );
      }
      const publish = await this.post(
        `/${this.credential.instagramUserId}/media_publish`,
        { creation_id: creationId },
      );
      if (publish.status < 200 || publish.status >= 300) {
        return this.providerFailure(publish);
      }
      const done = this.parse(publish.body);
      const mediaId = typeof done.id === "string" ? done.id : null;
      if (!mediaId) {
        return failed(
          "provider",
          `${this.name}: provider returned no published media id`,
        );
      }
      return verifiedByProvider(mediaId, {
        providerRef: mediaId,
        permalinks: [],
      });
    } catch (err) {
      return this.networkFailure(err);
    }
  }
}

/* -------------------------------- the mock ---------------------------------- */

const MOCK_SOCIAL_REASON =
  "Mock social channel: no request left this process, so nothing can be confirmed.";

/**
 * The explicitly-labelled stand-in for every social channel. `isLive: false`,
 * performs no I/O, and returns `unverified("mock", …)` from EVERY method. It
 * carries no transport, so it physically cannot open a connection or settle a
 * send / publish / inbox fact.
 */
export class MockSocialChannel implements SocialChannelAdapter {
  readonly name = "mock-social";
  readonly isLive = false;

  capabilities(): readonly ProviderCapability[] {
    // The mock documents the honest ceiling of this build (design §1): the
    // capabilities are real contracts, but nothing is LIVE here.
    return [
      {
        key: "mock",
        status: "SANDBOX_ONLY",
        label: "Mock social channel",
        blocker: "stand-in only — never performs I/O and confirms nothing",
      },
    ];
  }

  async verifyConnection(): Promise<IntegrationOutcome<ConnectionFacts>> {
    return unverified("mock", MOCK_SOCIAL_REASON);
  }

  async fetchConversationPage(): Promise<
    IntegrationOutcome<readonly NormalizedMessage[]>
  > {
    return unverified("mock", MOCK_SOCIAL_REASON);
  }

  async sendSessionMessage(): Promise<IntegrationOutcome<SendReceipt>> {
    return unverified("mock", MOCK_SOCIAL_REASON);
  }

  async sendTemplate(): Promise<IntegrationOutcome<SendReceipt>> {
    return unverified("mock", MOCK_SOCIAL_REASON);
  }

  async markConversation(): Promise<IntegrationOutcome<unknown>> {
    return unverified("mock", MOCK_SOCIAL_REASON);
  }

  async publishPost(): Promise<IntegrationOutcome<PublishedRef>> {
    return unverified("mock", MOCK_SOCIAL_REASON);
  }
}

/* ------------------------------ credential cipher --------------------------- */

/**
 * The AES-256-GCM primitives the server injects. Everything that touches the
 * actual cipher (random bytes, key stretching, encrypt / decrypt, UTF-8
 * conversion) is provided by the runtime so this package holds no crypto
 * global and no key material of its own.
 */
export type CipherPrimitives = {
  readonly randomBytes: (length: number) => Uint8Array;
  /** Stretch the external key text to a 32-byte AES key. */
  readonly stretchKey: (keyText: string) => Uint8Array;
  readonly encrypt: (args: {
    key: Uint8Array;
    iv: Uint8Array;
    plaintext: Uint8Array;
  }) => { ciphertext: Uint8Array; tag: Uint8Array };
  readonly decrypt: (args: {
    key: Uint8Array;
    iv: Uint8Array;
    ciphertext: Uint8Array;
    tag: Uint8Array;
  }) => Uint8Array;
  readonly encodeUtf8: (value: string) => Uint8Array;
  readonly decodeUtf8: (value: Uint8Array) => string;
};

/** Envelope layout constants: version tag + 12-byte nonce + 16-byte tag. */
const CIPHER_VERSION = 0x01;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Resolve the cipher key text, fail-closed. `keyText` is whatever the server
 * read from its environment (this package never reads one). `isProduction`
 * gates the hard refusal: in production an absent key is a total refusal to
 * build a cipher; outside production it is still refused, because encrypting
 * with no key would only create a fake that later fails to decrypt.
 */
export function resolveCipherKey(
  keyText: string | undefined,
  isProduction: boolean,
):
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly error: string } {
  if (keyText && keyText.trim().length >= 16) {
    return { ok: true, key: keyText };
  }
  const envWord = isProduction ? " in production" : "";
  return {
    ok: false,
    error:
      `A credential cipher key is required${envWord} but was absent or too short. ` +
      `Set the dedicated integration key environment variable before connecting or ` +
      `reading stored credentials; nothing will be encrypted or decrypted without it.`,
  };
}

export type EncryptedEnvelope = Uint8Array;

/**
 * A fail-closed credential cipher. `encrypt` / `decrypt` refuse when no key was
 * resolved; the key is never returned, logged or embedded in the envelope. The
 * envelope is `version | iv | tag | ciphertext`, all raw bytes, so the caller
 * can persist it in a `bytea` column directly.
 */
export class CredentialCipher {
  private readonly key: Uint8Array | null;

  constructor(
    keyResolution:
      | { readonly ok: true; readonly key: string }
      | { readonly ok: false; readonly error: string },
    private readonly primitives: CipherPrimitives,
  ) {
    this.key = keyResolution.ok
      ? primitives.stretchKey(keyResolution.key)
      : null;
  }

  get ready(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): EncryptedEnvelope {
    if (!this.key) {
      throw new Error(
        "Credential cipher is not keyed; refusing to encrypt a credential.",
      );
    }
    const iv = this.primitives.randomBytes(GCM_IV_BYTES);
    const { ciphertext, tag } = this.primitives.encrypt({
      key: this.key,
      iv,
      plaintext: this.primitives.encodeUtf8(plaintext),
    });
    if (tag.length !== GCM_TAG_BYTES || iv.length !== GCM_IV_BYTES) {
      throw new Error("Credential cipher produced an unexpected envelope.");
    }
    const envelope = new Uint8Array(
      1 + iv.length + tag.length + ciphertext.length,
    );
    envelope[0] = CIPHER_VERSION;
    envelope.set(iv, 1);
    envelope.set(tag, 1 + iv.length);
    envelope.set(ciphertext, 1 + iv.length + tag.length);
    return envelope;
  }

  decrypt(envelope: Uint8Array): string {
    if (!this.key) {
      throw new Error(
        "Credential cipher is not keyed; refusing to decrypt a credential.",
      );
    }
    const minimum = 1 + GCM_IV_BYTES + GCM_TAG_BYTES;
    if (envelope.length < minimum || envelope[0] !== CIPHER_VERSION) {
      throw new Error("Stored credential envelope is malformed.");
    }
    const iv = envelope.slice(1, 1 + GCM_IV_BYTES);
    const tag = envelope.slice(
      1 + GCM_IV_BYTES,
      1 + GCM_IV_BYTES + GCM_TAG_BYTES,
    );
    const ciphertext = envelope.slice(1 + GCM_IV_BYTES + GCM_TAG_BYTES);
    const plain = this.primitives.decrypt({
      key: this.key,
      iv,
      ciphertext,
      tag,
    });
    return this.primitives.decodeUtf8(plain);
  }
}

/* ------------------------------ honesty guards ------------------------------ */

/**
 * Whether an adapter's outcome may be recorded as a confirmed inbound message
 * (an inbox row that "arrived from the provider"). Only a verified, provider-
 * sourced read qualifies; the mock's `unverified` never does. Kept alongside
 * `paymentIsSettled` so the same rule governs the inbox: a mock cannot settle
 * an inbound delivery.
 */
export function inboundIsConfirmed(
  outcome: IntegrationOutcome<readonly NormalizedMessage[]>,
): boolean {
  return isVerified(outcome);
}

/**
 * Whether a send outcome may be recorded as delivered. Same rule as payments:
 * only the provider's own verified receipt qualifies; the mock or a queued
 * client answer never does.
 */
export function sendIsDelivered(
  outcome: IntegrationOutcome<SendReceipt>,
): boolean {
  return isVerified(outcome) && outcome.value.state !== "failed";
}

/**
 * Whether a publish outcome may mark a ContentPost PUBLISHED. True only for a
 * verified, provider-sourced reference — the design rule that a draft is never
 * rendered published without a real provider id.
 */
export function publishIsConfirmed(
  outcome: IntegrationOutcome<PublishedRef>,
): outcome is Verified<PublishedRef> {
  return isVerified(outcome);
}

/* ------------------------------ construction help --------------------------- */

/** The three live channels plus the stand-in, for a wiring/health surface. */
export const SOCIAL_MOCK = new MockSocialChannel();

export const CHANNEL_FOR_PROVIDER: Record<
  "META_WHATSAPP" | "META_FB_PAGE" | "META_INSTAGRAM",
  new (credential: ChannelCredential) => BaseGraphAdapter
> = {
  META_WHATSAPP: MetaWhatsAppAdapter,
  META_FB_PAGE: MetaFbPageAdapter,
  META_INSTAGRAM: MetaInstagramAdapter,
};

/**
 * Build the live adapter for a provider. Returns the stand-in when the caller
 * has no credential (`bearer` empty), so a caller cannot mistake an unconfigured
 * live adapter for a working one — the mock is honest about confirming nothing.
 */
export function buildChannelAdapter(
  provider: "META_WHATSAPP" | "META_FB_PAGE" | "META_INSTAGRAM",
  credential: ChannelCredential,
): SocialChannelAdapter {
  if (credential.bearer.trim().length === 0) {
    return SOCIAL_MOCK;
  }
  const Ctor = CHANNEL_FOR_PROVIDER[provider];
  return new Ctor(credential);
}
