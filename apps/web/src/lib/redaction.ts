/**
 * Secret redaction, shared by the audit writer and the logger.
 *
 * This module is deliberately isomorphic — it imports nothing from the database
 * or server runtime — because the same definition of "sensitive" has to apply in
 * a client error boundary, in a Server Action, and in the audit writer. If the
 * logger carried its own copy, the two lists would drift and a credential could
 * be redacted from the audit trail but printed to stdout (or the reverse).
 */

/**
 * Substrings that mark a key as carrying a credential or a session artefact.
 * Matching is case-insensitive and substring-based on purpose: `accessToken`,
 * `tokenHash`, `refresh_token` and `stripeSecretKey` all have to be caught by
 * the same rule.
 */
export const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "token",
  "secret",
  "authorization",
  "cookie",
  "session",
  "apikey",
  "api_key",
  "credential",
  "privatekey",
  "private_key",
  "signature",
] as const;

/** True when a key name names a credential we must never persist or print. */
export function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * Values are not assumed to be shallow. An event that carries a nested object
 * (`{ user: { password } }`) or an array of payloads would leak straight through
 * a top-level-only pass, so redaction walks the whole value.
 *
 * A sensitive key is OMITTED, not replaced: dropping it hides both the value and
 * the fact that a caller tried to record one, and keeps the stored shape equal to
 * the shape a careful caller would have written (the audit-hygiene test asserts
 * the surviving key list, not just the absence of values).
 *
 * A cycle cannot reach us through a validated Server Action, but the walk bounds
 * its depth and treats a repeat of the same object as a redaction rather than
 * recursing forever. `Date` is rendered as ISO text instead of vanishing into an
 * empty object via `Object.entries`.
 */
export function redactValue(
  value: unknown,
  depth = 0,
  seen: ReadonlySet<object> = new Set(),
): unknown {
  if (depth > 8) return "[depth-limit]";
  if (value === null || typeof value !== "object") {
    // `JSON.stringify` throws on a BigInt, and an audit/console payload that
    // cannot be serialised is worse than one rendered as text.
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";

  const nextSeen = new Set(seen);
  nextSeen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1, nextSeen));
  }

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    clean[key] = redactValue(nested, depth + 1, nextSeen);
  }
  return clean;
}

/**
 * Redact a metadata object (or any structured context). Returns `undefined` for
 * a missing input so callers can distinguish "no context" from "empty context".
 */
export function redactSecrets(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return redactValue(metadata) as Record<string, unknown>;
}
