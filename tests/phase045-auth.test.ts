import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 04.5a — Supabase Auth alignment tests.
 *
 * Covers the pieces that make the Supabase-backed session trustworthy:
 * the embedded session-version claim, the validity predicate, the revocation
 * sequence (database bump → GoTrue kill → claim sync) and the open-redirect
 * barrier on the auth callback. Also exercises `getSessionUser()`'s full trust
 * chain against mocked Supabase + Prisma clients.
 */

vi.mock("@/lib/db/prisma", () => import("./prisma-mock"));
vi.mock("@/lib/supabase/server", () => import("./supabase-mock"));

import { prismaMock } from "./prisma-mock";
import {
  supabaseAdminMock,
  supabaseServerMock,
  resetSupabaseMocks,
} from "./supabase-mock";
import {
  readSessionVersionClaim,
  isSessionValid,
  revokeUserSessions,
} from "@/lib/auth/session";
import { getSessionUser } from "@/lib/auth/session-user";
import { sanitizeAppPath } from "@/lib/auth/redirects";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const FALLBACK = "/en/login";

/** Builds a JWT-shaped string whose payload carries the session-version claim. */
function accessTokenWithVersion(version: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ app_metadata: { amisibiz_session_version: version } }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSupabaseMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ─── readSessionVersionClaim ─────────────────────────────────────────────────

describe("readSessionVersionClaim", () => {
  it("reads the integer claim from the token payload", () => {
    expect(readSessionVersionClaim(accessTokenWithVersion(3))).toBe(3);
    expect(readSessionVersionClaim(accessTokenWithVersion(0))).toBe(0);
  });

  it("returns 0 when the claim is absent or malformed", () => {
    const noClaim = Buffer.from(JSON.stringify({ sub: USER_ID })).toString(
      "base64url",
    );
    expect(readSessionVersionClaim(`header.${noClaim}.sig`)).toBe(0);
    expect(readSessionVersionClaim(accessTokenWithVersion("3"))).toBe(0);
    expect(readSessionVersionClaim(accessTokenWithVersion(2.5))).toBe(0);
    expect(readSessionVersionClaim(accessTokenWithVersion(-1))).toBe(0);
  });

  it("returns 0 for unparseable tokens", () => {
    expect(readSessionVersionClaim("not-a-jwt")).toBe(0);
    expect(readSessionVersionClaim("a.!!!not-base64json!!!.c")).toBe(0);
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
  it("executes bump → ban → unban → claim sync in order", async () => {
    const order: string[] = [];

    prismaMock.user.update.mockImplementation(async () => {
      order.push("db");
      return { sessionVersion: 5 };
    });
    supabaseAdminMock.auth.admin.updateUserById.mockImplementation(
      async (...args: unknown[]) => {
        const attrs = args[1] as Record<string, unknown>;
        if (attrs.ban_duration === "1s") order.push("ban");
        else if (attrs.ban_duration === "none") order.push("unban");
        else if (attrs.app_metadata) order.push("sync");
        return { data: { user: {} }, error: null };
      },
    );

    await revokeUserSessions(USER_ID);

    expect(order).toEqual(["db", "ban", "unban", "sync"]);
  });

  it("stops after a failed GoTrue kill (db bump still fail-closes)", async () => {
    prismaMock.user.update.mockResolvedValue({ sessionVersion: 5 });
    supabaseAdminMock.auth.admin.updateUserById.mockResolvedValueOnce({
      data: { user: null },
      error: new Error("go true unavailable"),
    });

    await revokeUserSessions(USER_ID);

    expect(supabaseAdminMock.auth.admin.updateUserById).toHaveBeenCalledTimes(
      1,
    );
    expect(supabaseAdminMock.auth.admin.updateUserById).toHaveBeenCalledWith(
      USER_ID,
      { ban_duration: "1s" },
    );
    // The claim must stay stale so the mismatch remains detectable and the
    // login flow can repair it later.
    expect(
      supabaseAdminMock.auth.admin.updateUserById,
    ).not.toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ app_metadata: expect.anything() }),
    );
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
  function authUser(overrides: Record<string, unknown> = {}) {
    return {
      id: USER_ID,
      email: "owner@example.com",
      email_confirmed_at: null,
      ...overrides,
    };
  }

  function profileRow(overrides: Record<string, unknown> = {}) {
    return {
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      platformRole: "USER",
      status: "ACTIVE",
      sessionVersion: 2,
      emailVerified: null,
      ...overrides,
    };
  }

  it("accepts a token whose claim matches the database version", async () => {
    supabaseServerMock.auth.getUser.mockResolvedValue({
      data: { user: authUser() },
      error: null,
    });
    supabaseServerMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: accessTokenWithVersion(2) } },
      error: null,
    });
    prismaMock.user.findUnique.mockResolvedValue(profileRow());

    await expect(getSessionUser()).resolves.toEqual({
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      platformRole: "USER",
      status: "ACTIVE",
    });
  });

  it("rejects a token whose embedded claim is stale (revoked)", async () => {
    supabaseServerMock.auth.getUser.mockResolvedValue({
      data: { user: authUser() },
      error: null,
    });
    supabaseServerMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: accessTokenWithVersion(1) } },
      error: null,
    });
    // Revocation bumped the database to 2; the old token still says 1.
    prismaMock.user.findUnique.mockResolvedValue(profileRow());

    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("rejects suspended profiles, missing profiles and failed token checks", async () => {
    supabaseServerMock.auth.getUser.mockResolvedValue({
      data: { user: authUser() },
      error: null,
    });
    supabaseServerMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: accessTokenWithVersion(2) } },
      error: null,
    });

    prismaMock.user.findUnique.mockResolvedValue(
      profileRow({ status: "SUSPENDED" }),
    );
    await expect(getSessionUser()).resolves.toBeNull();

    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(getSessionUser()).resolves.toBeNull();

    supabaseServerMock.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error("invalid token"),
    });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("mirrors the email-confirmation fact onto the profile once", async () => {
    supabaseServerMock.auth.getUser.mockResolvedValue({
      data: { user: authUser({ email_confirmed_at: "2026-01-01T00:00:00Z" }) },
      error: null,
    });
    supabaseServerMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: accessTokenWithVersion(2) } },
      error: null,
    });
    prismaMock.user.findUnique.mockResolvedValue(profileRow());
    prismaMock.user.update.mockResolvedValue({ id: USER_ID });

    await expect(getSessionUser()).resolves.not.toBeNull();
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { emailVerified: new Date("2026-01-01T00:00:00Z") },
    });
  });

  it("treats an absent access token as never-valid (fail closed)", async () => {
    supabaseServerMock.auth.getUser.mockResolvedValue({
      data: { user: authUser() },
      error: null,
    });
    supabaseServerMock.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    prismaMock.user.findUnique.mockResolvedValue(profileRow());

    await expect(getSessionUser()).resolves.toBeNull();
  });
});
