import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrapScope, runInScope } from "@amisibiz/database";

/**
 * Public lead capture:
 * `POST /api/public/leads` (unauthenticated), JSON body ≤ 8 KB.
 *
 * This is the anonymous entry point to `app_public_lead_capture(p_payload::jsonb)`
 * — the ONLY anonymous write in the system (design spec migration §11). The
 * division of labour is deliberate:
 *
 *  - zod here bounds the REQUEST (size, JSON shape, field caps, and requires
 *    `idempotencyKey` plus a target — `shareToken` or `tenantId`); unknown
 *    keys are stripped by the object schema, so a forged `status`, `role`,
 *    `tenantId`-override or anything else simply does not exist downstream;
 *  - the FUNCTION there re-validates everything (closed-vocabulary source,
 *    ISO-3 currency, trimmed/bounded fields, forced NEW status, tenant
 *    resolution through an active LEAD_FORM link or a real workspace, and the
 *    idempotency/externalId retry identities) and returns
 *    `{leadId, duplicateSuspect}` — a replay returns the ORIGINAL lead with
 *    the suspect flag, never a second row.
 *
 * The validated payload reaches SQL ONLY as a bound string cast `::jsonb`;
 * no JSON text is ever interpolated into the statement.
 *
 * RATE LIMITING / ABUSE: none exists at this layer. There is no edge limiter
 * in the platform yet — this is the documented open gap of design spec §7,
 * owned by AGENT 04 / infrastructure, and this route does not pretend
 * otherwise. The idempotency key keeps a RETRY honest; it does not stop a
 * flood from many keys.
 */

/** Hard cap on the raw request body, matching the spec's 8 KB ceiling. */
const LEAD_BODY_MAX_BYTES = 8 * 1024;

const uuidSchema = z.string().uuid("Invalid ID");

const leadCaptureSchema = z
  .object({
    // Target: a LEAD_FORM share token wins inside the function; a raw tenant
    // id is only ever accepted after the function proves it is a real
    // workspace. At least one must be present.
    shareToken: z
      .string()
      .regex(/^[0-9A-Za-z_-]{1,128}$/)
      .optional(),
    tenantId: uuidSchema.optional(),
    // Bounded, trimmed identity fields — caps mirror the function's own
    // `left(...)` bounds so nothing is silently cut in transit.
    firstName: z.string().max(100).trim().optional().or(z.literal("")),
    lastName: z.string().max(100).trim().optional().or(z.literal("")),
    companyName: z.string().max(160).trim().optional().or(z.literal("")),
    email: z
      .string()
      .email("Invalid email")
      .max(254)
      .optional()
      .or(z.literal("")),
    phone: z.string().max(32).trim().optional().or(z.literal("")),
    /** The form's free message; stored as the lead's description. */
    message: z.string().max(2000).trim().optional().or(z.literal("")),
    sourceDetail: z.string().max(500).trim().optional().or(z.literal("")),
    source: z
      .enum([
        "WEB_FORM",
        "REFERRAL",
        "SOCIAL",
        "CAMPAIGN",
        "WALK_IN",
        "PHONE",
        "EMAIL",
        "IMPORT",
        "OTHER",
      ])
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "Currency must be ISO-3")
      .optional(),
    /** Required, non-empty: the capture's retry identity. */
    idempotencyKey: z
      .string()
      .trim()
      .min(1, "idempotencyKey is required")
      .max(200),
    externalId: z.string().trim().max(100).optional().or(z.literal("")),
    utmSource: z.string().max(200).trim().optional().or(z.literal("")),
    utmMedium: z.string().max(200).trim().optional().or(z.literal("")),
    utmCampaign: z.string().max(200).trim().optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (!data.shareToken && !data.tenantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A share token or tenant is required",
        path: ["shareToken"],
      });
    }
  });

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function badRequest(): NextResponse {
  return jsonResponse(400, { success: false, error: "Invalid request" });
}

function tooLarge(): NextResponse {
  return jsonResponse(413, { success: false, error: "Payload too large" });
}

function notFound(): NextResponse {
  return jsonResponse(404, { success: false, error: "Not found" });
}

/**
 * Map a function-raised error to a GENERIC status without echoing the SQL
 * message: `P0002` (no data — unknown tenant/token) answers 404, everything
 * else the function raises (check violations, malformed payloads) answers 400.
 * The raw error is logged server-side only.
 */
function classifyFunctionError(err: unknown): NextResponse {
  const text =
    err instanceof Error
      ? `${(err as { code?: string }).code ?? ""} ${err.message}`
      : String(err);
  if (text.includes("P0002") || text.includes("no_data_found")) {
    return notFound();
  }
  return badRequest();
}

export async function POST(request: NextRequest) {
  try {
    // Size gate BEFORE reading: a declared oversize body is refused without
    // buffering it. The post-read check is the authoritative one, because
    // `Content-Length` can be absent or lie.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > LEAD_BODY_MAX_BYTES) {
      return tooLarge();
    }

    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > LEAD_BODY_MAX_BYTES) {
      return tooLarge();
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return badRequest();
    }

    const parsed = leadCaptureSchema.safeParse(json);
    if (!parsed.success) {
      return badRequest();
    }

    // Re-assemble from the VALIDATED fields only (a whitelist): the object
    // that reaches the function cannot contain a key this schema does not
    // know, regardless of what the client sent.
    const payload: Record<string, string> = {
      idempotencyKey: parsed.data.idempotencyKey,
    };
    for (const key of [
      "shareToken",
      "tenantId",
      "firstName",
      "lastName",
      "companyName",
      "email",
      "phone",
      "message",
      "sourceDetail",
      "source",
      "currency",
      "externalId",
      "utmSource",
      "utmMedium",
      "utmCampaign",
    ] as const) {
      const value = parsed.data[key];
      if (typeof value === "string" && value !== "") payload[key] = value;
    }

    // Bound the JSON text as well — the schema caps fields individually, but
    // the 8 KB ceiling is a property of the wire, and the bound parameter is
    // what crosses it.
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, "utf8") > LEAD_BODY_MAX_BYTES) {
      return tooLarge();
    }

    const rows = await runInScope(
      bootstrapScope(),
      (tx) =>
        tx.$queryRaw<{ result: unknown }[]>`
        SELECT public.app_public_lead_capture(${payloadJson}::jsonb) AS "result"`,
    );

    const result = rows[0]?.result;
    if (!result || typeof result !== "object") {
      console.error(
        "[POST /api/public/leads] capture function returned nothing",
      );
      return badRequest();
    }

    const lead = result as { leadId?: unknown; duplicateSuspect?: unknown };
    if (typeof lead.leadId !== "string") {
      console.error("[POST /api/public/leads] unexpected capture shape");
      return badRequest();
    }

    return jsonResponse(201, {
      leadId: lead.leadId,
      duplicateSuspect: lead.duplicateSuspect === true,
    });
  } catch (err) {
    console.error("[POST /api/public/leads]", err);
    return classifyFunctionError(err);
  }
}
