/**
 * SHA-256 for migration checksums.
 *
 * The migrator compares a checksum recorded in the local database against the
 * migration text the installed bundle is carrying, so a stored schema cannot be
 * quietly edited into a different shape. That only protects anything if the hash
 * itself is trustworthy, which decides the shape of this file:
 *
 *   - The digest comes from the platform (`crypto.subtle`), the same
 *     implementation Node uses in the test suite and the same one both WebView
 *     targets ship. It is verified in `apps/web/tests/phase06-*` against
 *     `node:crypto`, so the checksums in the schema history are known-good
 *     rather than assumed.
 *   - There is deliberately **no** hand-written fallback implementation. A
 *     transcribed round-constant table that is one value wrong produces
 *     plausible-looking hashes for every migration, which would make the
 *     guard reject correct databases and accept tampered ones — worse than
 *     having no guard. If the platform offers no digest, opening the local
 *     database fails loudly and the client stays offline rather than guessing.
 *
 * A `ChecksumHasher` can be injected for tests and for a platform that turns
 * out to lack `crypto.subtle`, in which case the integrator supplies a real
 * implementation and the two recorded histories are compared explicitly.
 */

export type ChecksumHasher = (input: string) => Promise<string>;

export class ChecksumUnavailableError extends Error {
  constructor() {
    super(
      "SHA-256 is unavailable in this runtime, so the local schema cannot be verified. " +
        "Refusing to open the offline database rather than skip checksum verification.",
    );
    this.name = "ChecksumUnavailableError";
  }
}

const HEX_DIGITS = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    const value = byte as number;
    out += HEX_DIGITS.charAt(value >>> 4) + HEX_DIGITS.charAt(value & 0x0f);
  }
  return out;
}

/**
 * SHA-256 of a UTF-8 string, hex-encoded, via the platform digest.
 *
 * Deterministic across the three drivers: the same migration text must hash to
 * the same value on Node, Android and Windows, or each platform would need its
 * own recorded schema history and the guard would compare nothing.
 */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ChecksumUnavailableError();

  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToHex(new Uint8Array(digest));
}

export const defaultChecksumHasher: ChecksumHasher = sha256Hex;
