import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_SECRET_MIN_LENGTH, getAuthSecret } from "@/lib/env";
import {
  getCapabilities,
  hasAllProductionCapabilities,
} from "@/lib/capabilities";
import { sendEmail } from "@/lib/email";
import { getRateLimitBackend } from "@/lib/security/rate-limit";

/**
 * Foundation hardening: the environment must fail safely when a required
 * setting is absent, and the app must never claim that an external service is
 * operational when it is not.
 */

const MANAGED = [
  "AUTH_SECRET",
  "NODE_ENV",
  "EMAIL_PROVIDER",
  "DATABASE_URL",
  "DATABASE_URL_2",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_PRISMA_URL_2",
  "POSTGRES_URL",
  "POSTGRES_URL_2",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STORAGE_PROVIDER",
  "VERCEL",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
] as const;

/** `process.env.NODE_ENV` is typed read-only; write through a mutable view. */
function env(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}
function setEnv(key: string, value: string): void {
  env()[key] = value;
}
function delEnv(key: string): void {
  delete env()[key];
}

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of MANAGED) saved[key] = env()[key];
});

afterEach(() => {
  for (const key of MANAGED) {
    const value = saved[key];
    if (value === undefined) delEnv(key);
    else setEnv(key, value);
  }
});

describe("getAuthSecret", () => {
  it("returns an explicit, long-enough AUTH_SECRET", () => {
    setEnv("AUTH_SECRET", "x".repeat(AUTH_SECRET_MIN_LENGTH));
    expect(getAuthSecret()).toBe("x".repeat(AUTH_SECRET_MIN_LENGTH));
  });

  it("rejects an AUTH_SECRET that is too short", () => {
    setEnv("AUTH_SECRET", "too-short");
    expect(() => getAuthSecret()).toThrow(/at least 32 characters/);
  });

  it("fails safely in production when AUTH_SECRET is absent", () => {
    delEnv("AUTH_SECRET");
    setEnv("NODE_ENV", "production");
    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is not configured/);
  });

  it("never derives the secret from a database credential", () => {
    delEnv("AUTH_SECRET");
    setEnv("NODE_ENV", "production");
    setEnv("POSTGRES_PASSWORD", "a-real-database-password-000");
    setEnv("PGPASSWORD", "another-database-password-000");
    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is not configured/);
  });

  it("uses a development constant outside production", () => {
    delEnv("AUTH_SECRET");
    setEnv("NODE_ENV", "development");
    expect(getAuthSecret().length).toBeGreaterThanOrEqual(
      AUTH_SECRET_MIN_LENGTH,
    );
  });
});

describe("getCapabilities", () => {
  it("reports the database configured through a platform-injected Neon key", () => {
    delEnv("DATABASE_URL");
    setEnv(
      "POSTGRES_PRISMA_URL",
      "postgresql://owner:pw@ep-pooler.eu-central-1.aws.neon.tech/amisibiz",
    );
    const capabilities = getCapabilities();
    expect(capabilities.database.configured).toBe(true);
    // The detail names the KEY, never the value.
    expect(capabilities.database.detail).toContain("POSTGRES_PRISMA_URL");
    expect(capabilities.database.detail).not.toContain("owner:pw");
  });

  it("reports the database unconfigured when no pooled URL exists under any key", () => {
    delEnv("DATABASE_URL");
    delEnv("DATABASE_URL_2");
    delEnv("POSTGRES_PRISMA_URL");
    delEnv("POSTGRES_PRISMA_URL_2");
    delEnv("POSTGRES_URL");
    delEnv("POSTGRES_URL_2");
    expect(getCapabilities().database.configured).toBe(false);
  });

  it("reports email as not configured without a provider", () => {
    delEnv("EMAIL_PROVIDER");
    const capabilities = getCapabilities();
    expect(capabilities.email.configured).toBe(false);
    expect(capabilities.pdf.configured).toBe(true);
  });

  it("does not claim email is operational even when a provider name is set", () => {
    setEnv("EMAIL_PROVIDER", "smtp");
    const capabilities = getCapabilities();
    expect(capabilities.email.configured).toBe(false);
  });

  it("reports a configured rate-limit store only when one is set", () => {
    delEnv("REDIS_URL");
    delEnv("UPSTASH_REDIS_REST_URL");
    delEnv("UPSTASH_REDIS_REST_TOKEN");
    expect(getCapabilities().rateLimit.configured).toBe(false);

    setEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    setEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    expect(getCapabilities().rateLimit.configured).toBe(true);
  });

  it("is not fully production-capable without the optional services", () => {
    delEnv("EMAIL_PROVIDER");
    delEnv("REDIS_URL");
    delEnv("UPSTASH_REDIS_REST_URL");
    delEnv("UPSTASH_REDIS_REST_TOKEN");
    expect(hasAllProductionCapabilities()).toBe(false);
  });
});

describe("sendEmail", () => {
  it("uses the development console adapter and never reports sent", async () => {
    delEnv("EMAIL_PROVIDER");
    setEnv("NODE_ENV", "development");
    const result = await sendEmail({
      to: "user@example.com",
      subject: "Verify",
      text: "hello",
    });
    expect(result.sent).toBe(false);
    expect(result.mode).toBe("development-console");
    expect(result.reason).toBe("EMAIL_PROVIDER_NOT_CONFIGURED");
  });

  it("reports a setup error in production without a provider", async () => {
    delEnv("EMAIL_PROVIDER");
    setEnv("NODE_ENV", "production");
    const result = await sendEmail({
      to: "user@example.com",
      subject: "Verify",
      text: "hello",
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("EMAIL_PROVIDER_NOT_CONFIGURED");
    expect(result.mode).toBe("unavailable");
  });

  it("never claims delivery when a provider is set but unimplemented", async () => {
    setEnv("EMAIL_PROVIDER", "smtp");
    const result = await sendEmail({
      to: "user@example.com",
      subject: "Verify",
      text: "hello",
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("EMAIL_TRANSPORT_NOT_IMPLEMENTED");
  });
});

describe("getRateLimitBackend", () => {
  it("defaults to the in-process store", () => {
    delEnv("REDIS_URL");
    delEnv("UPSTASH_REDIS_REST_URL");
    delEnv("UPSTASH_REDIS_REST_TOKEN");
    expect(getRateLimitBackend()).toBe("memory");
  });

  it("detects Upstash and Redis configuration", () => {
    delEnv("UPSTASH_REDIS_REST_URL");
    delEnv("UPSTASH_REDIS_REST_TOKEN");
    setEnv("REDIS_URL", "redis://localhost:6379");
    expect(getRateLimitBackend()).toBe("redis");

    setEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    setEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    expect(getRateLimitBackend()).toBe("upstash");
  });
});
