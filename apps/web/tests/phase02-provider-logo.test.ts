import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 — provider-side branding: logo upload and provider read access.
 *
 * The Phase 2 brief lets authorised Amisi Genuine staff configure a workspace's
 * branding, logo included, and show a document preview. Two facts follow that
 * the Phase 04 routes did not cover:
 *
 *   POST /api/platform/tenants/[tenantId]/logo  — a platform administrator may
 *     replace a tenant's logo, through the SAME byte classification the tenant
 *     route uses (see `server/services/logo-storage`).
 *   GET  /uploads/tenants/[...path]             — a platform administrator who
 *     is not a member of the workspace may still read the logo, or the console
 *     and its preview would render a broken image.
 *
 * The security claims under test are: only a platform administrator with
 * `platform.tenants.update` may write; a plain business user (even the tenant's
 * own owner) may not; a platform SUPPORT role may not write; and the read
 * fallback never widens a non-member's access beyond their platform role.
 *
 * `fs/promises` is mocked, so a rejection is proven by "the write never
 * happened" rather than by the response body alone.
 */

import { authMock } from "./auth-mock";
import { prismaMock, auditsFor } from "./prisma-mock";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { LOGO_MAX_DIMENSION_PX } from "@/lib/validations/branding";
import { POST as providerUploadLogo } from "@/app/api/platform/tenants/[tenantId]/logo/route";
import { GET as serveUpload } from "@/app/uploads/tenants/[...path]/route";
import type { NextRequest } from "next/server";
import type { TenantRole, TenantStatus } from "@prisma/client";
import { sep } from "path";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_USER_ID = "55555555-5555-4555-8555-555555555555";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const HEX_NAME = "0123456789abcdef0123456789abcdef";

function posix(value: unknown): string {
  return String(value).split(sep).join("/");
}

// ── Filesystem mock ──────────────────────────────────────────────────────────

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("fs/promises", () => fsMock);
vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function file(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function providerRequest(tenantId: string, fields: Record<string, unknown>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value as string | Blob);
  }
  return {
    request: {
      formData: async () => formData,
    } as unknown as NextRequest,
    context: { params: Promise.resolve({ tenantId }) },
  };
}

function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

/** The platform standing the authorization check re-reads from the User row. */
function asPlatform(role: "SUPER_ADMIN" | "SUPPORT" | null) {
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: role,
    status: "ACTIVE",
  });
}

/** Membership is keyed by (tenantId, userId) — only `memberOf` resolves. */
function asRole(
  role: TenantRole,
  status: TenantStatus = "ACTIVE",
  memberOf: string = TENANT_ID,
  userId: string = USER_ID,
) {
  prismaMock.tenantMember.findUnique.mockImplementation(
    async (args: unknown) => {
      const key =
        (
          args as
            | {
                where?: {
                  tenantId_userId?: { tenantId?: string; userId?: string };
                };
              }
            | undefined
        )?.where?.tenantId_userId ?? {};
      if (key.tenantId !== memberOf || key.userId !== userId) return null;
      return { role, tenant: { status } };
    },
  );
}

// ── Provider upload route ────────────────────────────────────────────────────

describe("Phase 2 provider logo upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    authMock.mockResolvedValue({ id: USER_ID });
    asPlatform("SUPER_ADMIN");
    prismaMock.tenant.findUnique.mockResolvedValue({ id: TENANT_ID });
    prismaMock.tenantBranding.upsert.mockResolvedValue({ id: "branding_1" });
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.readFile.mockResolvedValue(Buffer.from("x"));
    fsMock.stat.mockResolvedValue({ isFile: () => true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an unauthenticated upload without touching the filesystem", async () => {
    authMock.mockResolvedValue(null);
    const { request, context } = providerRequest(TENANT_ID, {
      file: file(pngBytes(64, 64), "logo.png", "image/png"),
    });

    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(401);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.upsert).not.toHaveBeenCalled();
  });

  it("refuses a plain business user even when they own the tenant", async () => {
    // Provider administration is a separate authorization domain: the tenant's
    // own owner holds no platform role and must be refused.
    asPlatform(null);
    asRole("TENANT_OWNER");

    const { request, context } = providerRequest(TENANT_ID, {
      file: file(pngBytes(64, 64), "logo.png", "image/png"),
    });
    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(403);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.upsert).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.AUTHZ_DENIED)).toHaveLength(1);
    expect(auditsFor(AUDIT_ACTIONS.PLATFORM_TENANT_LOGO_UPLOADED)).toHaveLength(
      0,
    );
  });

  it("refuses a platform SUPPORT role, which cannot update tenants", async () => {
    asPlatform("SUPPORT");

    const { request, context } = providerRequest(TENANT_ID, {
      file: file(pngBytes(64, 64), "logo.png", "image/png"),
    });
    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(403);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("refuses a malformed tenant id before reading the file", async () => {
    const { request, context } = providerRequest("../../etc/passwd", {
      file: file(pngBytes(64, 64), "logo.png", "image/png"),
    });
    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(400);
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("404s a well-formed tenant id that does not exist", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(null);

    const { request, context } = providerRequest(OTHER_TENANT_ID, {
      file: file(pngBytes(64, 64), "logo.png", "image/png"),
    });
    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(404);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an SVG declared as a PNG — the shared classifier decides", async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      "utf8",
    );

    const { request, context } = providerRequest(TENANT_ID, {
      file: file(svg, "logo.png", "image/png"),
    });
    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toMatch(
      /does not match declared type/,
    );
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects oversized pixel dimensions from the file's own header", async () => {
    const { request, context } = providerRequest(TENANT_ID, {
      file: file(
        pngBytes(LOGO_MAX_DIMENSION_PX + 1, 10),
        "logo.png",
        "image/png",
      ),
    });
    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toMatch(/2000x2000/);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("stores a valid logo for the tenant and audits the provider upload", async () => {
    const { request, context } = providerRequest(TENANT_ID, {
      file: file(pngBytes(640, 480), "logo.png", "image/png"),
    });
    const response = await providerUploadLogo(request, context);

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    const logoUrl = String(
      body.data && (body.data as Record<string, unknown>).logoUrl,
    );
    expect(logoUrl).toMatch(
      new RegExp(`^/uploads/tenants/${TENANT_ID}/logo/[0-9a-f]{32}\\.png$`),
    );

    const written = posix(fsMock.writeFile.mock.calls[0]?.[0]);
    expect(written).toContain(`uploads/tenants/${TENANT_ID}/logo/`);

    const upsert = (prismaMock.tenantBranding.upsert.mock.calls[0]?.[0] ??
      {}) as { where: Record<string, unknown> };
    expect(upsert.where).toEqual({ tenantId: TENANT_ID });

    const audits = auditsFor(AUDIT_ACTIONS.PLATFORM_TENANT_LOGO_UPLOADED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.tenantId).toBe(TENANT_ID);
    expect(audits[0]?.userId).toBe(USER_ID);
  });
});

// ── Provider read access to the private serving route ────────────────────────

describe("Phase 2 platform read of tenant uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ id: USER_ID });
    asPlatform("SUPER_ADMIN");
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);
    fsMock.readFile.mockResolvedValue(Buffer.from("logo-bytes"));
    fsMock.stat.mockResolvedValue({ isFile: () => true });
    asRole("TENANT_ADMIN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function get(path: string[]) {
    return serveUpload({} as NextRequest, {
      params: Promise.resolve({ path }),
    });
  }

  it("serves a tenant's logo to a platform admin who is not a member", async () => {
    // No membership (the beforeEach cleared it); the platform fallback carries
    // the read so the provider console and its preview are not broken.
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);

    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("still denies a non-member who holds no platform role", async () => {
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);
    asPlatform(null);

    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("still serves a member without invoking the platform fallback", async () => {
    // Membership resolves first; the platform standing is irrelevant here.
    asPlatform(null);
    asRole("VIEWER", "ACTIVE", TENANT_ID, OTHER_USER_ID);
    authMock.mockResolvedValue({ id: OTHER_USER_ID });

    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(200);
    expect(fsMock.readFile).toHaveBeenCalled();
  });

  it("still refuses a member reaching another tenant's folder", async () => {
    asPlatform(null);
    asRole("TENANT_ADMIN", "ACTIVE", TENANT_ID);

    const response = await get([
      "tenants",
      OTHER_TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});
