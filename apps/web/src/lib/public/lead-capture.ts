import {
  isValidPublicToken,
  parseLeadCaptureResponse,
} from "@/lib/public-share";

/**
 * Public lead capture client (AGENT 02 modules C/E, design spec §2/§7).
 *
 * Posts to the ONE anonymous write in the system, `POST /api/public/leads`,
 * which forwards a whitelisted body to the SECURITY DEFINER function
 * `app_public_lead_capture(p_payload::jsonb)`. The rules this module keeps:
 *
 *  - the retry identity is a `crypto.randomUUID()` idempotency key minted ONCE
 *    per form mount and reused on every submit, so a network retry returns the
 *    original lead instead of creating a second one;
 *  - the target is exactly one of `shareToken` / `tenantId` (the API requires
 *    one, and the function refuses a `shareToken` that is not an active,
 *    unexpired LEAD_FORM link);
 *  - no tenant identifier, token or count that the page was not already given
 *    is ever sent, and nothing client-side computes a price or a status;
 *  - the body is bounded to the API's own 8 KB ceiling before it is sent, so
 *    the caller gets a clear "too long" instead of a 413 it cannot explain;
 *  - success is only claimed when the endpoint answers 201 with a `leadId`.
 */

/** The wire contract of `POST /api/public/leads` (zod schema in the route). */
export interface PublicLeadCapturePayload {
  idempotencyKey: string;
  shareToken?: string;
  tenantId?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  message?: string;
  sourceDetail?: string;
  source?: string;
  currency?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

/** The form's own fields — the target and the key are added by the caller. */
export interface PublicLeadFormValues {
  firstName: string;
  lastName: string;
  companyName: string;
  email: string;
  phone: string;
  enquiry: string;
  currency: string;
}

/** Mirrors the API's documented field caps so the form can state them. */
export const LEAD_FIELD_MAX = {
  firstName: 100,
  lastName: 100,
  companyName: 160,
  email: 254,
  phone: 32,
  /**
   * The API accepts a 2 000-character `message`, but the capture function only
   * stores `description` and `sourceDetail` (≤ 500) — see `buildPayload`:
   * the enquiry text is therefore capped at 500 and shown to the user as such.
   */
  enquiry: 500,
} as const;

const LEAD_CAPTURE_ENDPOINT = "/api/public/leads";
const BODY_MAX_BYTES = 8 * 1024;

export type PublicLeadCaptureOutcome =
  | {
      status: "sent";
      leadId: string;
      /** True for a retry replay AND for a strong email/phone overlap. */
      duplicateSuspect: boolean;
    }
  | { status: "rejected"; reason: PublicLeadRejection };

/** Coarse reasons: the API answers with generic statuses and no details. */
export type PublicLeadRejection =
  "invalid_request" | "link_not_found" | "too_long" | "offline";

const REJECTION_COPY: Record<PublicLeadRejection, string> = {
  invalid_request:
    "We couldn't submit this enquiry. Please check the details above and try again.",
  link_not_found:
    "This link is no longer valid, so we couldn't route your enquiry. Please ask the business for a current link.",
  too_long:
    "Your enquiry is too long to send. Please shorten it and try again.",
  offline:
    "We couldn't reach the server. Your enquiry has NOT been sent — please try again.",
};

export function rejectionMessage(reason: PublicLeadRejection): string {
  return REJECTION_COPY[reason];
}

/**
 * A fresh retry identity, minted once per form mount (`useState(() => …)`) so
 * an error-retry of the same form reuses it — the server's replay protection
 * depends on the key being stable across retries of one submission.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function trimmed(value: string): string | undefined {
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Where the enquiry text goes.
 *
 * The route's whitelist forwards a `message` key, but the capture function
 * builds the lead from `description` and `sourceDetail` — a `message` alone is
 * accepted and then dropped. Sending it in both places means the requester's
 * words are never silently lost: they land in `sourceDetail` today, and in
 * `message` automatically once the server maps it (reported as a gap).
 * `sourceDetail` caps at 500, which is also the form's stated limit.
 */
export function buildPayload(
  target: { shareToken: string } | { tenantId: string },
  values: PublicLeadFormValues,
  idempotencyKey: string,
): PublicLeadCapturePayload {
  const enquiry = trimmed(values.enquiry);
  const payload: PublicLeadCapturePayload = { idempotencyKey, ...target };

  const optional = {
    firstName: trimmed(values.firstName),
    lastName: trimmed(values.lastName),
    companyName: trimmed(values.companyName),
    email: trimmed(values.email),
    phone: trimmed(values.phone),
    currency: trimmed(values.currency),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) {
      payload[key as keyof PublicLeadCapturePayload] = value;
    }
  }

  if (enquiry) {
    payload.message = enquiry;
    payload.sourceDetail = enquiry.slice(0, LEAD_FIELD_MAX.enquiry);
  }

  return payload;
}

/** Attribution carried through from the link's query string (`?utm_*=`). */
export interface PublicLeadAttribution {
  utmSource?: string | undefined;
  utmMedium?: string | undefined;
  utmCampaign?: string | undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Send one capture. Returns a typed outcome; it never throws and never claims
 * success without a `201` carrying a `leadId`.
 */
export async function submitPublicLead(
  payload: PublicLeadCapturePayload,
  attribution?: PublicLeadAttribution,
): Promise<PublicLeadCaptureOutcome> {
  if (
    "shareToken" in payload &&
    payload.shareToken &&
    !isValidPublicToken(payload.shareToken)
  ) {
    return { status: "rejected", reason: "link_not_found" };
  }

  const body: PublicLeadCapturePayload = {
    ...payload,
    ...(attribution?.utmSource ? { utmSource: attribution.utmSource } : {}),
    ...(attribution?.utmMedium ? { utmMedium: attribution.utmMedium } : {}),
    ...(attribution?.utmCampaign
      ? { utmCampaign: attribution.utmCampaign }
      : {}),
  };

  const json = JSON.stringify(body);
  if (byteLength(json) > BODY_MAX_BYTES) {
    return { status: "rejected", reason: "too_long" };
  }

  let response: Response;
  try {
    response = await fetch(LEAD_CAPTURE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: json,
    });
  } catch {
    // No response at all: nothing was recorded, and the copy says exactly that.
    return { status: "rejected", reason: "offline" };
  }

  if (response.status === 413)
    return { status: "rejected", reason: "too_long" };
  if (response.status === 404) {
    return { status: "rejected", reason: "link_not_found" };
  }
  if (response.status === 400) {
    return { status: "rejected", reason: "invalid_request" };
  }
  if (!response.ok) {
    // A 5xx from the same endpoint means the capture did not complete; the
    // retry with the SAME idempotency key is the safe follow-up.
    return { status: "rejected", reason: "offline" };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { status: "rejected", reason: "invalid_request" };
  }

  const data = parseLeadCaptureResponse(parsed);
  if (!data) return { status: "rejected", reason: "invalid_request" };

  return {
    status: "sent",
    leadId: data.leadId,
    duplicateSuspect: data.duplicateSuspect === true,
  };
}

/** Read `?utm_source|medium|campaign=` off a public page URL (untrusted text). */
export function attributionFromParams(
  params: Record<string, string | string[] | undefined>,
): PublicLeadAttribution {
  const first = (value: string | string[] | undefined): string | undefined => {
    const raw = Array.isArray(value) ? value[0] : value;
    const text = raw?.trim();
    if (!text || text.length > 200) return undefined;
    return text;
  };

  return {
    utmSource: first(params.utm_source),
    utmMedium: first(params.utm_medium),
    utmCampaign: first(params.utm_campaign),
  };
}
