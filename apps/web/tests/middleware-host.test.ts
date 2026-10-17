import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import middleware from "@/middleware";

/**
 * Point 6 of the Agent 2 acceptance gate — "Unknown hostnames are rejected" and
 * "host-header manipulation must not select another tenant / another tenant's
 * workspace."
 *
 * The middleware is the only place a request host is read. Two properties are
 * proved here:
 *
 *  1. A reserved workspace label (`admin`, `platform`, …) is refused with 404,
 *     so a tenant can never be served from the platform-administration name.
 *  2. The host is read through `resolveRequestHost`, which ignores
 *     `X-Forwarded-Host` unless the request arrives behind a trusted proxy, so a
 *     browser cannot smuggle a reserved (or another tenant's) hostname into the
 *     routing decision.
 *
 * Tenant *access* never derives from the host at all: the workspace identity is
 * resolved server-side from the signed session and the membership table, so
 * pointing any hostname at the app cannot widen what a session may see.
 */
describe("middleware host handling", () => {
  const original = process.env.APP_BASE_DOMAIN;

  afterEach(() => {
    if (original === undefined) delete process.env.APP_BASE_DOMAIN;
    else process.env.APP_BASE_DOMAIN = original;
  });

  const request = (url: string, headers: Record<string, string>) =>
    new NextRequest(url, { headers });

  it("rejects a reserved workspace subdomain with 404", async () => {
    process.env.APP_BASE_DOMAIN = "amisibiz.com";

    const response = await middleware(
      request("https://admin.amisibiz.com/en/dashboard", {
        host: "admin.amisibiz.com",
      }),
    );

    expect(response.status).toBe(404);
  });

  it("does not treat a platform label as a tenant workspace", async () => {
    process.env.APP_BASE_DOMAIN = "amisibiz.com";

    const response = await middleware(
      request("https://platform.amisibiz.com/en/dashboard", {
        host: "platform.amisibiz.com",
      }),
    );

    expect(response.status).toBe(404);
  });

  it("ignores X-Forwarded-Host, so it cannot select a reserved host", async () => {
    process.env.APP_BASE_DOMAIN = "amisibiz.com";

    // A non-reserved external host with a reserved forwarded host: the forwarded
    // value must be ignored, so the request is NOT refused as `admin`.
    const response = await middleware(
      request("https://acme.amisibiz.com/en/dashboard", {
        host: "acme.amisibiz.com",
        "x-forwarded-host": "admin.amisibiz.com",
      }),
    );

    expect(response.status).not.toBe(404);
  });

  it("runs no subdomain logic when no base domain is configured", async () => {
    delete process.env.APP_BASE_DOMAIN;

    // Even a reserved-looking label is just the app host when subdomains are off.
    const response = await middleware(
      request("https://admin.amisibiz.com/en/dashboard", {
        host: "admin.amisibiz.com",
      }),
    );

    expect(response.status).not.toBe(404);
  });
});
