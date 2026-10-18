import * as React from "react";
import { headers } from "next/headers";
import { getAppUrlOrNull } from "@/lib/env";
import {
  isValidPublicToken,
  parsePublicOrderStatus,
  parsePublicProduct,
  parseShareResolve,
  type PublicOrderStatus,
  type PublicProduct,
  type ShareResolve,
} from "@/lib/public-share";

/**
 * Data access for the PUBLIC pages at `/s/<token>` (AGENT 02 module C/E,
 * design spec §3).
 *
 * Plain async functions used by SERVER COMPONENTS only — no `"use server"`:
 * they call the already-implemented unauthenticated API routes
 * (`/api/public/share/<token>`, `/api/public/product/<token>`,
 * `/api/public/order/<token>`) and parse the responses with the guards in
 * `@/lib/public-share`. Nothing here touches Prisma or a table: the routes are
 * the only door, and they answer through the SECURITY DEFINER functions.
 *
 * Refusal discipline: an unknown, revoked, expired, wrong-kind or
 * unparseable response all collapse into `not_found`. The pages render a
 * neutral "nothing here" state and never a status, a reason or a payload
 * fragment that would tell a prober which of the four it hit.
 */

export type PublicSharePage =
  | { status: "invalid_token" }
  | { status: "not_found" }
  | {
      status: "ok";
      token: string;
      share: ShareResolve;
      /** PRODUCT payload when the link is a product page; `null` if its item vanished. */
      product: PublicProduct | null;
      /** ORDER_STATUS payload when the link is an order page; `null` if not issued. */
      order: PublicOrderStatus | null;
    };

/**
 * Absolute origin for the server-side self-fetch.
 *
 * A React Server Component cannot fetch a relative URL, so the origin is
 * derived from the incoming request first (correct in dev, preview and behind
 * proxies), then from `NEXT_PUBLIC_APP_URL` / Vercel's deployment variables.
 * When neither is available the caller renders `not_found` rather than
 * guessing a host.
 */
async function resolveOrigin(): Promise<string | null> {
  try {
    const list = await headers();
    const forwardedHost = list.get("x-forwarded-host");
    const host =
      forwardedHost?.split(",")[0]?.trim() || list.get("host")?.trim() || null;
    if (host) {
      const forwardedProto = list
        .get("x-forwarded-proto")
        ?.split(",")[0]
        ?.trim();
      const protocol =
        forwardedProto ??
        (host.includes("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
      return `${protocol}://${host}`;
    }
  } catch {
    // `headers()` is unavailable outside a request scope (e.g. a static
    // prerender attempt); fall through to the configured app URL.
  }

  try {
    return getAppUrlOrNull();
  } catch {
    // In production an unset `NEXT_PUBLIC_APP_URL` is a deployment
    // misconfiguration. A public page refuses itself rather than sending the
    // resolver call to a guessed host.
    return null;
  }
}

/**
 * GET one public endpoint. Returns `null` for anything that is not a JSON
 * success body: 404, 5xx, HTML, an `{success:false}` error object or
 * unparseable text. Never throws to the page.
 */
async function fetchPublicJson(path: string): Promise<unknown | null> {
  const origin = await resolveOrigin();
  if (!origin) return null;

  try {
    const response = await fetch(`${origin}${path}`, {
      // Public share pages are per-token and never cacheable: the resolver
      // bumps `viewCount` and expiry/revocation must take effect immediately.
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return null;
    }
    if (json === null || json === undefined) return null;
    if (
      typeof json === "object" &&
      (json as { success?: unknown }).success === false
    ) {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}

/** `GET /api/public/share/<token>` — the kind + the ids the token carries. */
export async function resolveShareLink(
  token: string,
): Promise<ShareResolve | null> {
  if (!isValidPublicToken(token)) return null;
  const json = await fetchPublicJson(`/api/public/share/${token}`);
  return parseShareResolve(json);
}

/** `GET /api/public/product/<token>`. */
export async function loadPublicProduct(
  token: string,
): Promise<PublicProduct | null> {
  if (!isValidPublicToken(token)) return null;
  const json = await fetchPublicJson(`/api/public/product/${token}`);
  return parsePublicProduct(json);
}

/** `GET /api/public/order/<token>`. */
export async function loadPublicOrderStatus(
  token: string,
): Promise<PublicOrderStatus | null> {
  if (!isValidPublicToken(token)) return null;
  const json = await fetchPublicJson(`/api/public/order/${token}`);
  return parsePublicOrderStatus(json);
}

/**
 * Resolve once, then load the data the link's kind points at.
 *
 * A product/order link that resolves but whose detail call fails (the item was
 * hard-deleted underneath the link, or the order is no longer public) renders
 * the same neutral not-found as a dead token.
 */
async function loadSharePage(token: string): Promise<PublicSharePage> {
  if (!isValidPublicToken(token)) return { status: "invalid_token" };

  const share = await resolveShareLink(token);
  if (!share) return { status: "not_found" };

  if (share.kind === "PRODUCT") {
    const product = await loadPublicProduct(token);
    if (!product) return { status: "not_found" };
    return { status: "ok", token, share, product, order: null };
  }

  if (share.kind === "ORDER_STATUS") {
    const order = await loadPublicOrderStatus(token);
    if (!order) return { status: "not_found" };
    return { status: "ok", token, share, product: null, order };
  }

  // LEAD_FORM carries no content endpoint: the capture form is the page.
  return { status: "ok", token, share, product: null, order: null };
}

/**
 * `generateMetadata` and the page render read the same token in one request;
 * `React.cache` collapses them into a single resolver call so one page view is
 * one `viewCount` bump rather than two (the resolver tolerates double counts,
 * but there is no reason to invite one).
 */
export const loadPublicSharePage = React.cache(loadSharePage);

export { isValidPublicToken };
