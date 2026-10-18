import { z } from "zod";

/**
 * Typed readers for the PUBLIC share endpoints
 * (`GET /api/public/share/<token>`, `GET /api/public/product/<token>`,
 * `GET /api/public/order/<token>`, `POST /api/public/leads`).
 *
 * These functions answer from the `SECURITY DEFINER` sqljson payloads, so
 * every key can be missing (`jsonb_strip_nulls` drops nulls) and nothing here
 * is trusted until it parses. The page renders nothing leaky on failure: an
 * unparsable body is treated exactly like the API's generic 404.
 *
 * This module is client-safe (zod only, no server imports) and is unit-tested
 * in `apps/web/tests/public-share.test.ts`.
 */

const uuid = z.string().min(1);

/** `app_public_share_link_resolve`: `{tenantId, id, kind, itemId?, documentId?}`. */
export const shareResolveSchema = z
  .object({
    tenantId: uuid,
    id: uuid,
    kind: z.enum(["PRODUCT", "LEAD_FORM", "ORDER_STATUS"]),
    itemId: uuid.optional(),
    documentId: uuid.optional(),
    // jsonb numbers/dates arrive as JSON scalars; keep the shape open.
    expiresAt: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type ShareResolve = z.infer<typeof shareResolveSchema>;

/** Money as the public JSON carries it: a jsonb number or a decimal string. */
const jsonMoney = z
  .union([z.number(), z.string()])
  .transform((value) => String(value));

/** `app_public_product_view` payload (nulls stripped, so all optional). */
export const publicProductSchema = z
  .object({
    tenantId: uuid,
    shareLinkId: uuid,
    expiresAt: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
    item: z
      .object({
        id: uuid,
        name: z.string(),
        description: z.string().optional(),
        sku: z.string().optional(),
        unitOfMeasure: z.string().optional(),
        currency: z.string(),
        status: z.string(),
      })
      .passthrough(),
    variants: z
      .array(
        z
          .object({
            id: uuid,
            name: z.string(),
            sku: z.string().optional(),
            unitPrice: jsonMoney,
            currency: z.string(),
          })
          .passthrough(),
      )
      .default([]),
    tenant: z
      .object({
        name: z.string(),
        displayName: z.string().optional(),
        logoUrl: z.string().optional(),
        contactEmail: z.string().optional(),
        contactPhone: z.string().optional(),
        website: z.string().optional(),
      })
      .passthrough()
      .optional(),
    // Images are not in the migrated payload yet; render defensively if they
    // ever are (deviation noted in the phase report).
    images: z
      .array(
        z
          .object({
            id: uuid.optional(),
            blobUrl: z.string().url().optional(),
            url: z.string().url().optional(),
            alt: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type PublicProduct = z.infer<typeof publicProductSchema>;

/** `app_public_order_status` payload (ISSUED-or-later orders only). */
export const publicOrderStatusSchema = z
  .object({
    tenantId: uuid,
    shareLinkId: uuid,
    id: uuid,
    number: z.string(),
    status: z.string(),
    currency: z.string(),
    total: jsonMoney,
    issueDate: z.string().optional(),
    dueDate: z.string().optional(),
    expiresAt: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
    quantity: jsonMoney,
    deliveredQuantity: jsonMoney,
    deliveredRatio: jsonMoney,
    fullyDelivered: z.boolean(),
  })
  .passthrough();

export type PublicOrderStatus = z.infer<typeof publicOrderStatusSchema>;

/** `POST /api/public/leads` success body. */
export const leadCaptureResponseSchema = z
  .object({
    leadId: uuid,
    duplicateSuspect: z.boolean(),
  })
  .passthrough();

export type LeadCaptureResponse = z.infer<typeof leadCaptureResponseSchema>;

function parseApiJson(value: unknown): boolean {
  // The public routes answer 404 with `{success:false,error:"Not found"}`;
  // a `success:false` object is never a data payload.
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { success?: unknown }).success === false
  );
}

/** Fetch + parse + validate one of the public GET endpoints. `null` = not found. */
export async function fetchPublicJson(path: string): Promise<unknown | null> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }
  if (json === null || json === undefined || parseApiJson(json)) return null;
  return json;
}

export function parseShareResolve(json: unknown): ShareResolve | null {
  const parsed = shareResolveSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function parsePublicProduct(json: unknown): PublicProduct | null {
  const parsed = publicProductSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function parsePublicOrderStatus(
  json: unknown,
): PublicOrderStatus | null {
  const parsed = publicOrderStatusSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function parseLeadCaptureResponse(
  json: unknown,
): LeadCaptureResponse | null {
  const parsed = leadCaptureResponseSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Re-exported so the capture form cannot ship a token-shaped string that the
 * API's format gate would reject anyway (same pattern as the routes).
 */
export const PUBLIC_TOKEN_PATTERN = /^[0-9A-Za-z_-]{1,128}$/;

export function isValidPublicToken(token: string | undefined): boolean {
  return typeof token === "string" && PUBLIC_TOKEN_PATTERN.test(token);
}
