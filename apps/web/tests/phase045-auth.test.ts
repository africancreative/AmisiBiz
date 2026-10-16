import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@amisibiz/database", () => import("./prisma-mock"));

import { prismaMock } from "./prisma-mock";
import { isSessionValid, revokeUserSessions } from "@/lib/auth/session";
import { getSessionUser } from "@/lib/auth/session-user";
import { sanitizeAppPath } from "@/lib/auth/redirects";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
} from "@/lib/auth/token";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const FALLBACK = "/en/login";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ─── Session Token create & verify ──────────────────────────────────────────

describe("Session Token (Web Crypto HMAC)", () => {
  it("creates and verifies a valid session token", async () => {
    const token = await createSessionToken({
      userId: USER_ID,
      sessionVersion: 2,
    });
    expect(typeof token).toBe("string");
    expect(token.includes(".")).toBe(true);

    const payload = await verifySessionToken(token);
    expect(payload).toEqual({
      userId: USER_ID,
      sessionVersion: 2,
    });
  });

  it("rejects an invalid signature or tampered token", async () => {
    const token = await createSessionToken({
      userId: USER_ID,
      sessionVersion: 2,
    });
    const tampered = token.slice(0, -4) + "XXXX";
    const payload = await verifySessionToken(tampered);
    expect(payload).toBeNull();
  });

  it("returns null for malformed tokens", async () => {
    expect(await verifySessionToken("not-a-token")).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
    expect(await verifySessionToken("a.b.c")).toBeNull();
  });
});

// ─── isSessionValid ──────────────────────────────────────────────────────────

describe("isSessionValid", () => {
  it("requires ACTIVE status and an exact version match", () => {
    expect(isSessionValid({ status: "ACTIVE", sessionVersion: 2 }, 2)).toBe(
      true,
    );
    expect(isSessionValid({ status: "ACTIVE", sessionVersion: 3 }, 2)).toBe(
      false,
    );
    expect(isSessionValid({ status: "INACTIVE", sessionVersion: 2 }, 2)).toBe(
      false,
    );
    expect(isSessionValid(null, 0)).toBe(false);
    expect(isSessionValid(undefined, 0)).toBe(false);
  });
});

// ─── revokeUserSessions ──────────────────────────────────────────────────────

describe("revokeUserSessions", () => {
  it("bumps user sessionVersion in database to revoke all active tokens", async () => {
    prismaMock.user.update.mockResolvedValue({ id: USER_ID, sessionVersion: 3 });

    await revokeUserSessions(USER_ID);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { sessionVersion: { increment: 1 } },
    });
  });
});

// ─── sanitizeAppPath (open-redirect barrier) ─────────────────────────────────

describe("sanitizeAppPath", () => {
  it("accepts same-app paths inside a configured locale", () => {
    expect(sanitizeAppPath("/en/dashboard", FALLBACK)).toBe("/en/dashboard");
    expect(sanitizeAppPath("/fr/reset-password", FALLBACK)).toBe(
      "/fr/reset-password",
    );
    expect(sanitizeAppPath("/sw", FALLBACK)).toBe("/sw");
  });

  it("rejects foreign hosts and protocol-relative targets", () => {
    expect(sanitizeAppPath("https://evil.example", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath("//evil.example", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath("javascript:alert(1)", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects backslash tricks and control characters", () => {
    expect(sanitizeAppPath("/en\\..\\admin", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath("/en/\u0000dashboard", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath("/en/\u001fdashboard", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects paths outside the configured locales and empty input", () => {
    expect(sanitizeAppPath("/xx/dashboard", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath("/dashboard", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath("", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath(null, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAppPath(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

// ─── getSessionUser trust chain ──────────────────────────────────────────────

describe("getSessionUser", () => {
  function profileRow(overrides: Record<string, unknown> = {}) {
    return {
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      platformRole: null,
      status: "ACTIVE",
      sessionVersion: 2,
      ...overrides,
    };
  }

  it("accepts a session cookie whose payload matches the database version", async () => {
    const token = await createSessionToken({
      userId: USER_ID,
      sessionVersion: 2,
    });

    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, token);

    prismaMock.user.findUnique.mockResolvedValue(profileRow());

    await expect(getSessionUser()).resolves.toEqual({
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      platformRole: null,
      status: "ACTIVE",
    });
  });

  it("rejects a session cookie whose version is stale (revoked)", async () => {
    const token = await createSessionToken({
      userId: USER_ID,
      sessionVersion: 1, // token has 1, DB has 2
    });

    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, token);

    prismaMock.user.findUnique.mockResolvedValue(profileRow());

    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("rejects suspended or missing profiles", async () => {
    const token = await createSessionToken({
      userId: USER_ID,
      sessionVersion: 2,
    });

    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, token);

    prismaMock.user.findUnique.mockResolvedValue(
      profileRow({ status: "SUSPENDED" }),
    );
    await expect(getSessionUser()).resolves.toBeNull();

    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(getSessionUser()).resolves.toBeNull();
  });
});
