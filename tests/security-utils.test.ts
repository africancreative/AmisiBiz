import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, resetRateLimit } from "@/lib/security/rate-limit";
import {
  generateAccountToken,
  hashAccountToken,
  tokenHashesMatch,
} from "@/lib/auth/tokens";

describe("rateLimit", () => {
  beforeEach(async () => {
    await resetRateLimit();
  });

  it("allows requests up to the limit then blocks", async () => {
    const options = { limit: 3, windowMs: 1000 };
    expect((await rateLimit("k", options)).success).toBe(true);
    expect((await rateLimit("k", options)).success).toBe(true);
    const third = await rateLimit("k", options);
    expect(third.success).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = await rateLimit("k", options);
    expect(fourth.success).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it("tracks keys independently", async () => {
    const options = { limit: 1, windowMs: 1000 };
    expect((await rateLimit("a", options)).success).toBe(true);
    expect((await rateLimit("a", options)).success).toBe(false);
    expect((await rateLimit("b", options)).success).toBe(true);
  });

  it("resets after the window elapses", async () => {
    const options = { limit: 1, windowMs: -1 };
    expect((await rateLimit("k", options)).success).toBe(true);
    expect((await rateLimit("k", options)).success).toBe(true);
  });
});

describe("account tokens", () => {
  it("generates unique 32-byte hex tokens with a matching hash", () => {
    const a = generateAccountToken();
    const b = generateAccountToken();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashAccountToken(a.token));
    expect(a.tokenHash).not.toBe(a.token);
  });

  it("compares hashes safely", () => {
    const { tokenHash } = generateAccountToken();
    expect(tokenHashesMatch(tokenHash, tokenHash)).toBe(true);
    expect(tokenHashesMatch(tokenHash, hashAccountToken("other"))).toBe(false);
    expect(tokenHashesMatch("", tokenHash)).toBe(false);
  });
});