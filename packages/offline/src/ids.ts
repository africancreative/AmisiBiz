/**
 * Client-generated identifiers and local document references.
 *
 * Ids are minted on the device and sent to the server as the intended primary
 * key for a created row. That is what makes a retried synchronization safe:
 * the second attempt carries the same UUID, so the server can answer
 * `duplicate` instead of writing a second contact. It also means a local id is
 * never authority for anything — the server re-checks tenant ownership on every
 * row it is handed, exactly as the Server Actions do.
 *
 * The `LOCAL …` reference is deliberately *derived* rather than stored. There
 * is no column that could hold it, so no code path can print it where a real
 * document number is read (see `docs/architecture/offline-client-design.md`
 * §4: an offline draft must not claim an official server-issued number).
 */

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The prefix that marks a reference as local-only, in every locale. */
export const LOCAL_REFERENCE_PREFIX = "LOCAL";

/**
 * A RFC-4122 v4 UUID from the platform CSPRNG.
 *
 * `crypto.randomUUID()` is present in Node 19+, modern Chromium (the Android
 * and Windows WebView builds) and every secure context. The fallback keeps the
 * same shape using `crypto.getRandomValues` for the environments where the
 * convenience method is missing; it is not a fallback for missing entropy —
 * that throws, because minting a guessable id in an offline store that later
 * synchronises is worse than failing to start.
 */
export function newUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  if (!webCrypto?.getRandomValues) {
    throw new Error(
      "No cryptographic random source is available; an offline client cannot mint identifiers safely.",
    );
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  const octet = (index: number): string =>
    (bytes[index] ?? 0).toString(16).padStart(2, "0");

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx

  return [
    octet(0) + octet(1) + octet(2) + octet(3),
    octet(4) + octet(5),
    octet(6) + octet(7),
    octet(8) + octet(9),
    octet(10) + octet(11) + octet(12) + octet(13) + octet(14) + octet(15),
  ].join("-");
}

export function isUuid(value: string): boolean {
  return UUID_V4.test(value);
}

/** The 8 upper-case hex characters a human can read off a screen. */
export function shortId(id: string): string {
  const compact = id.replace(/-/g, "").slice(0, 8).toUpperCase();
  if (compact.length < 8) {
    throw new TypeError(`"${id}" is not a client UUID, so it has no short id`);
  }
  return compact;
}

/**
 * The reference an unsynchronized document shows instead of a number.
 *
 * The real number is allocated inside the server's issuance transaction and
 * arrives back on the next pull; until then this is the only label the product
 * is allowed to print, and the row's `number` column stays NULL.
 */
export function localReference(id: string): string {
  return `${LOCAL_REFERENCE_PREFIX}-${shortId(id)}`;
}

export function isLocalReference(value: string): boolean {
  return value.startsWith(`${LOCAL_REFERENCE_PREFIX}-`);
}

/**
 * Refuses to treat a local reference as a document number. Called on any path
 * that would send a number to the server or print one on a PDF.
 */
export function assertServerNumber(value: string | null): void {
  if (value !== null && isLocalReference(value)) {
    throw new Error(
      "A LOCAL reference is not a server-issued document number and cannot be sent or printed as one.",
    );
  }
}

/** A new installation identifier — stable for the lifetime of one install. */
export function newClientId(): string {
  return newUuid();
}
