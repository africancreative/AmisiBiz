import type { SocialTransport } from "@amisibiz/integrations";

/**
 * The concrete HTTP transport the social adapters are injected with
 * (AGENT 03 module A wiring).
 *
 * The neutral `@amisibiz/integrations` package holds NO host literal, NO `fetch`
 * reference and NO timeout enforcement of its own (register-boundary rule:
 * `packages/integrations/src/*.ts` is source-scanned for those). This file is
 * the server-side half: it turns the adapter's declarative `SocialHttpRequest`
 * into a real `fetch` and — critically — enforces the mandated ≤ 10 000 ms
 * timeout with an `AbortController` so a hung provider call can never wedge the
 * publish queue or a webhook fan-out.
 *
 * The Graph host and API version live here (server-owned configuration), read
 * through explicit constants rather than a secret: neither is confidential.
 */

export const GRAPH_BASE_URL = "https://graph.facebook.com";
export const GRAPH_API_VERSION = "v21.0";

/** Hard ceiling: a request longer than this is aborted, not awaited forever. */
export const MAX_TRANSPORT_TIMEOUT_MS = 10_000;

/**
 * The injected transport. It clamps the timeout to the ceiling even if a caller
 * asked for longer, and always resolves to the minimal `{ status, headers, body }`
 * shape the adapters classify — a network abort/throw surfaces as a rejected
 * promise the adapter's `catch` turns into a NETWORK failure.
 */
export const graphTransport: SocialTransport = async (request) => {
  const controller = new AbortController();
  const timeout = Math.min(
    Math.max(1, Math.floor(request.timeoutMs || MAX_TRANSPORT_TIMEOUT_MS)),
    MAX_TRANSPORT_TIMEOUT_MS,
  );
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      ...(request.method === "POST" && request.body !== undefined
        ? { body: request.body }
        : {}),
      signal: controller.signal,
    });
    const body = await response.text();
    const headers: Record<string, string | undefined> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body };
  } finally {
    clearTimeout(timer);
  }
};
