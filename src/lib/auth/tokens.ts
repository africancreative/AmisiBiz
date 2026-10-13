import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * Generates a cryptographically random, single-use account token.
 * Only the SHA-256 hash is persisted; the raw token is sent to the user.
 */
export function generateAccountToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashAccountToken(token) };
}

/** Deterministic SHA-256 hash used to look up a presented token. */
export function hashAccountToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex-encoded token hashes. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
