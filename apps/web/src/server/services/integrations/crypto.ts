import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";
import {
  CredentialCipher,
  resolveCipherKey,
  type CipherPrimitives,
} from "@amisibiz/integrations";

/**
 * The server-side credential crypto seam (AGENT 03).
 *
 * The AES-256-GCM *format* and its fail-closed rules live in
 * `@amisibiz/integrations` (`CredentialCipher`) so the boundary is testable
 * without a runtime. This file is the concrete Node binding: it supplies the
 * cipher primitives (which the neutral package deliberately cannot hold) and
 * reads the ONE environment variable that keys them.
 *
 * Hard rules kept here:
 *  - The key material is `INTEGRATION_SECRET`, stretched with SHA-256 to a
 *    32-byte AES-256 key. The raw secret NEVER enters the database, a log line,
 *    an error payload or a test.
 *  - FAIL-CLOSED: without the key the cipher refuses to encrypt or decrypt and
 *    throws a descriptive error. In production an absent key is a total
 *    refusal (connections cannot be stored), never a plaintext fallback.
 *  - Nothing on this path returns or logs key material or a decrypted
 *    credential; callers get an opaque envelope (a `Uint8Array`) or a redacted
 *    error.
 */

const AES_ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;

const primitives: CipherPrimitives = {
  randomBytes: (length) => new Uint8Array(randomBytes(length)),
  stretchKey: (keyText) =>
    new Uint8Array(
      createHash("sha256")
        .update(keyText, "utf8")
        .digest()
        .subarray(0, KEY_BYTES),
    ),
  encrypt: ({ key, iv, plaintext }) => {
    const cipher = createCipheriv(
      AES_ALGORITHM,
      Buffer.from(key),
      Buffer.from(iv),
    );
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext)),
      cipher.final(),
    ]);
    return {
      ciphertext: new Uint8Array(ciphertext),
      tag: new Uint8Array(cipher.getAuthTag()),
    };
  },
  decrypt: ({ key, iv, ciphertext, tag }) => {
    const decipher = createDecipheriv(
      AES_ALGORITHM,
      Buffer.from(key),
      Buffer.from(iv),
    );
    decipher.setAuthTag(Buffer.from(tag));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext)),
      decipher.final(),
    ]);
    return new Uint8Array(plain);
  },
  encodeUtf8: (value) => new Uint8Array(Buffer.from(value, "utf8")),
  decodeUtf8: (value) => Buffer.from(value).toString("utf8"),
};

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Build a keyed credential cipher. When the environment key is absent the
 * returned cipher reports `ready: false` and its `encrypt` / `decrypt` throw a
 * descriptive refusal — the fail-closed contract. Callers MUST check `.ready`
 * before attempting to persist or read a credential.
 */
export function serverCredentialCipher(): CredentialCipher {
  const resolution = resolveCipherKey(
    process.env.INTEGRATION_SECRET,
    isProductionRuntime(),
  );
  return new CredentialCipher(resolution, primitives);
}

/** True only when the cipher is keyed; used to gate connect flows explicitly. */
export function credentialCipherReady(): boolean {
  return serverCredentialCipher().ready;
}

/**
 * The webhook verify string is stored only as a SHA-256 hash (never the raw
 * value), mirroring `Invitation.tokenHash`. The handshake compares hashes.
 */
export function hashWebhookVerifyString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verifyWebhookHash(value: string, hash: string | null): boolean {
  if (!hash) return false;
  const a = Buffer.from(hashWebhookVerifyString(value), "utf8");
  const b = Buffer.from(hash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `X-Hub-Signature-256` over the RAW request body, HMAC-SHA256 keyed on the
 * app secret, in the `sha256=<hex>` shape Meta sends. Constant-time compare.
 * An absent secret (never in a correctly-provisioned deploy) fails closed.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;
  const [algorithm, provided] = signatureHeader.split("=");
  if (algorithm !== "sha256" || !provided) return false;
  const expected = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The app secret used to verify webhook signatures; read once, never logged. */
export function metaAppSecret(): string | undefined {
  const value = process.env.META_APP_SECRET?.trim();
  return value && value.length > 0 ? value : undefined;
}
