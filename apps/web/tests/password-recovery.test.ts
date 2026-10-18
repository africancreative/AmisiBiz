import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@amisibiz/database", () => import("./prisma-mock"));

import { prismaMock } from "./prisma-mock";
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  createSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/token";
import { sendEmail } from "@/lib/email";
import { sendPasswordResetEmail } from "@/lib/email/password-reset";
import { forgotPasswordAction, updatePasswordAction } from "@/server/actions/auth";
import { GET as authCallbackRoute } from "@/app/auth/callback/route";
import { NextRequest } from "next/server";

const USER_ID = "99999999-8888-7777-6666-555555555555";
const TEST_EMAIL = "reset-tester@example.com";

const envBackup = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...envBackup };
  process.env.NEXT_PUBLIC_APP_URL = "https://app.amisibiz.com";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...envBackup };
  vi.restoreAllMocks();
});

describe("Password Reset Token (Web Crypto HMAC)", () => {
  it("creates and verifies a valid password reset token", async () => {
    const token = await createPasswordResetToken({
      userId: USER_ID,
      sessionVersion: 1,
    });
    expect(typeof token).toBe("string");
    expect(token.includes(".")).toBe(true);

    const payload = await verifyPasswordResetToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.type).toBe("password-reset");
    expect(payload?.userId).toBe(USER_ID);
    expect(payload?.sessionVersion).toBe(1);
    expect(typeof payload?.exp).toBe("number");
  });

  it("rejects a tampered password reset token", async () => {
    const token = await createPasswordResetToken({
      userId: USER_ID,
      sessionVersion: 1,
    });
    const tampered = token.slice(0, -5) + "ABCDE";
    const payload = await verifyPasswordResetToken(tampered);
    expect(payload).toBeNull();
  });

  it("rejects a standard session token when verified as a reset token", async () => {
    const sessionToken = await createSessionToken({
      userId: USER_ID,
      sessionVersion: 1,
    });
    const payload = await verifyPasswordResetToken(sessionToken);
    expect(payload).toBeNull();
  });
});

describe("Mailtrap Email Transport", () => {
  it("delivers email to Mailtrap Sandbox when USE_SANDBOX and INBOX_ID are set", async () => {
    process.env.EMAIL_PROVIDER = "mailtrap";
    process.env.MAILTRAP_API_KEY = "test-token";
    process.env.USE_SANDBOX = "true";
    process.env.INBOX_ID = "12345";
    process.env.EMAIL_FROM = "AmisiBiz <noreply@amisibiz.com>";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message_ids: ["msg-1"] }),
    });
    global.fetch = mockFetch;

    const result = await sendEmail({
      to: "client@example.com",
      subject: "Test Subject",
      text: "Test plain text",
      html: "<p>Test html</p>",
    });

    expect(result.sent).toBe(true);
    expect(result.mode).toBe("mailtrap-sandbox");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://sandbox.api.mailtrap.io/api/send/12345");
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe("Bearer test-token");

    const body = JSON.parse(options.body);
    expect(body.from.email).toBe("noreply@amisibiz.com");
    expect(body.from.name).toBe("AmisiBiz");
    expect(body.to[0].email).toBe("client@example.com");
    expect(body.subject).toBe("Test Subject");
  });

  it("delivers email to Mailtrap Live API when in live mode", async () => {
    process.env.EMAIL_PROVIDER = "mailtrap";
    process.env.MAILTRAP_TOKEN = "live-token";
    process.env.USE_SANDBOX = "false";
    delete process.env.INBOX_ID;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message_ids: ["msg-live"] }),
    });
    global.fetch = mockFetch;

    const result = await sendEmail({
      to: "recipient@example.com",
      subject: "Live email",
      text: "Content",
    });

    expect(result.sent).toBe(true);
    expect(result.mode).toBe("mailtrap-live");

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://send.api.mailtrap.io/api/send");
  });

  it("handles Mailtrap API errors gracefully", async () => {
    process.env.EMAIL_PROVIDER = "mailtrap";
    process.env.API_KEY = "error-token";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    global.fetch = mockFetch;

    const result = await sendEmail({
      to: "fail@example.com",
      subject: "Test",
      text: "Text",
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("MAILTRAP_API_ERROR_401");
  });

  it("formats localized password reset emails correctly", async () => {
    process.env.EMAIL_PROVIDER = "mailtrap";
    process.env.MAILTRAP_API_KEY = "mock-key";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    global.fetch = mockFetch;

    await sendPasswordResetEmail({
      to: "swahili-user@example.com",
      userName: "Juma",
      resetUrl: "https://app.amisibiz.com/auth/callback?token=xyz",
      locale: "sw",
    });

    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(options.body);
    expect(body.subject).toBe("Badilisha nenosiri lako la AmisiBiz");
    expect(body.text).toContain("Hujambo Juma,");
    expect(body.text).toContain("https://app.amisibiz.com/auth/callback?token=xyz");
  });
});

describe("forgotPasswordAction", () => {
  it("looks up active user, generates token, and dispatches reset email", async () => {
    process.env.EMAIL_PROVIDER = "mailtrap";
    process.env.MAILTRAP_API_KEY = "mock-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.amisibiz.com";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    global.fetch = mockFetch;

    prismaMock.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: TEST_EMAIL,
      name: "Reset User",
      status: "ACTIVE",
      sessionVersion: 2,
    });

    const result = await forgotPasswordAction({ email: TEST_EMAIL }, "en");
    expect(result.success).toBe(true);

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: TEST_EMAIL },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        sessionVersion: true,
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(options.body);
    expect(body.to[0].email).toBe(TEST_EMAIL);
    expect(body.subject).toBe("Reset your AmisiBiz password");
    expect(body.text).toContain("https://app.amisibiz.com/auth/callback?token=");
  });

  it("safely handles nonexistent users without leaking existence or sending email", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    prismaMock.user.findUnique.mockResolvedValue(null);

    const result = await forgotPasswordAction({ email: "unknown@example.com" }, "en");
    expect(result.success).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("/auth/callback recovery flow", () => {
  it("accepts a valid recovery token and sets the session cookie", async () => {
    const token = await createPasswordResetToken({
      userId: USER_ID,
      sessionVersion: 3,
    });

    prismaMock.user.findUnique.mockResolvedValue({
      id: USER_ID,
      status: "ACTIVE",
      sessionVersion: 3,
      platformRole: null,
    });

    const request = new NextRequest(
      `https://app.amisibiz.com/auth/callback?token=${encodeURIComponent(token)}&type=recovery&next=/en/reset-password`,
    );

    const response = await authCallbackRoute(request);
    expect(response.status).toBe(307); // redirect
    expect(response.headers.get("location")).toBe("https://app.amisibiz.com/en/reset-password");

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
  });

  it("redirects without setting session cookie if sessionVersion does not match (already used)", async () => {
    const token = await createPasswordResetToken({
      userId: USER_ID,
      sessionVersion: 2, // Token has 2
    });

    prismaMock.user.findUnique.mockResolvedValue({
      id: USER_ID,
      status: "ACTIVE",
      sessionVersion: 3, // DB already bumped to 3
      platformRole: null,
    });

    const request = new NextRequest(
      `https://app.amisibiz.com/auth/callback?token=${encodeURIComponent(token)}&type=recovery&next=/en/reset-password`,
    );

    const response = await authCallbackRoute(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://app.amisibiz.com/en/reset-password");

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("redirects without setting session cookie if user is suspended", async () => {
    const token = await createPasswordResetToken({
      userId: USER_ID,
      sessionVersion: 1,
    });

    prismaMock.user.findUnique.mockResolvedValue({
      id: USER_ID,
      status: "SUSPENDED",
      sessionVersion: 1,
      platformRole: null,
    });

    const request = new NextRequest(
      `https://app.amisibiz.com/auth/callback?token=${encodeURIComponent(token)}&type=recovery&next=/en/reset-password`,
    );

    const response = await authCallbackRoute(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
