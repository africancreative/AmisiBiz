import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 04 — logo upload and private serving routes.
 *
 * Companion to `phase04-security.test.ts` for the two routes that touch the
 * filesystem:
 *
 *   POST /api/branding/logo            — tenant logo upload
 *   GET  /uploads/tenants/[...path]    — authenticated, tenant-scoped serving
 *
 * These are the security-sensitive paths the brief calls out: "Verify the
 * actual file content rather than trusting its extension" and "Store logos
 * using a private or appropriately controlled storage strategy, and serve them
 * through safe, validated URLs."
 *
 * `fs/promises` is mocked, so no test reads or writes real files (and nothing
 * lands in the git-ignored `uploads/` directory that would need cleaning up).
 * A rejection is therefore proven by "the write never happened", which is
 * stronger than checking the response body alone.
 *
 * The image fixtures are byte-faithful: real PNG IHDR, real JPEG marker
 * segments (APP0 + DQT + SOF0) and all three WebP layouts. A fixture that only
 * carried magic bytes would pass the magic check and then fail dimension
 * parsing, which is exactly the difference between "rejects" and "silently
 * accepts an unreadable file".
 */

import { authMock } from "./auth-mock";
import { prismaMock, auditsFor } from "./prisma-mock";
import { AUDIT_ACTIONS } from "@/lib/audit";
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION_PX,
} from "@/lib/validations/branding";
import { POST as uploadLogo } from "@/app/api/branding/logo/route";
import { GET as serveUpload } from "@/app/uploads/tenants/[...path]/route";
import type { NextRequest } from "next/server";
import type { TenantRole, TenantStatus } from "@prisma/client";
import { basename, sep } from "path";

// Identity columns are `uuid` since the Phase 1 migration, and both routes check
// that shape before touching the filesystem, so the fixtures are UUID-shaped.
const USER_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const HEX_NAME = "0123456789abcdef0123456789abcdef";

/** Forward slashes on every platform so path assertions stay readable. */
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
  buffer.writeUInt32BE(13, 8); // IHDR chunk length
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8; // bit depth
  buffer[25] = 6; // colour type
  return buffer;
}

/** Truncated PNG: correct signature, but the IHDR dimensions are missing. */
function pngWithoutHeaderBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
  ]);
}

function jpegBytes(width: number, height: number): Buffer {
  const bytes: number[] = [
    0xff,
    0xd8, // SOI
    // APP0 / JFIF: marker + 16-byte segment (length counted)
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00, // "JFIF\0"
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    // DQT: a length-only segment, so the walk has to step over it
    0xff,
    0xdb,
    0x00,
    0x02,
    // SOF0: marker + length 17 + precision + height + width + 3 components
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9, // EOI
  ];
  return Buffer.from(bytes);
}

function webpExtended(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(26, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8X", 12, "latin1");
  buffer.writeUInt32LE(10, 16);
  buffer[20] = 0x00; // flags
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function webpLossy(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(31);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(27, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8 ", 12, "latin1");
  buffer.writeUInt32LE(11, 16);
  buffer.writeUInt32LE(0x00000000, 20); // frame tag
  buffer[24] = 0x9d;
  buffer[25] = 0x01;
  buffer[26] = 0x2a;
  buffer.writeUInt16LE(width, 27);
  buffer.writeUInt16LE(height, 29);
  return buffer;
}

function webpLossless(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(25);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(21, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8L", 12, "latin1");
  buffer.writeUInt32LE(5, 16);
  buffer[20] = 0x2f; // VP8L signature
  const bits = (width - 1) | ((height - 1) << 14);
  buffer.writeUInt32LE(bits, 21);
  return buffer;
}

/** A JPEG-shaped file whose lossy-WebP start code is wrong. */
function bytesOf(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

function uploadRequest(fields: Record<string, unknown>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value as string | Blob);
  }
  return { formData: async () => formData } as unknown as NextRequest;
}

function file(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** Membership is keyed by (tenantId, userId) — only `memberOf` resolves. */
function asRole(
  role: TenantRole,
  status: TenantStatus = "ACTIVE",
  memberOf: string = TENANT_ID,
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
      if (key.tenantId !== memberOf || key.userId !== USER_ID) return null;
      return { role, tenant: { status } };
    },
  );
}

function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function servedPath(): string {
  const call = fsMock.readFile.mock.calls[0] ?? [];
  return posix(call[0]);
}

// ── Upload route ─────────────────────────────────────────────────────────────

describe("Phase 04 logo upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    authMock.mockResolvedValue({ id: USER_ID });
    // Tenant authorization re-reads the actor's platform standing from the
    // `User` row instead of trusting the token claim, so that row must answer.
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: null,
      status: "ACTIVE",
    });
    prismaMock.tenantBranding.upsert.mockResolvedValue({ id: "branding_1" });
    prismaMock.tenantMember.findUnique.mockResolvedValue(null);
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.readFile.mockResolvedValue(Buffer.from("x"));
    fsMock.stat.mockResolvedValue({ isFile: () => true });
    asRole("TENANT_ADMIN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an unauthenticated upload without touching the filesystem", async () => {
    authMock.mockResolvedValue(null);

    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(pngBytes(64, 64), "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(401);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.upsert).not.toHaveBeenCalled();
  });

  it("refuses a forged tenant id before any membership query", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: "../../etc/passwd",
        file: file(pngBytes(64, 64), "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(400);
    expect(prismaMock.tenantMember.findUnique).not.toHaveBeenCalled();
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it("refuses a cross-tenant upload and audits the denial", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: OTHER_TENANT_ID,
        file: file(pngBytes(64, 64), "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(403);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.upsert).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.AUTHZ_DENIED)).toHaveLength(1);
  });

  it("refuses a role that cannot change business settings", async () => {
    asRole("VIEWER");

    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(pngBytes(64, 64), "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(403);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("refuses an upload for a suspended tenant", async () => {
    asRole("TENANT_OWNER", "SUSPENDED");

    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(pngBytes(64, 64), "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(403);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an SVG declared as a PNG — the bytes decide, not the label", async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ' +
        'onload="fetch(/api/evil)"><rect width="10" height="10"/></svg>',
      "utf8",
    );

    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(svg, "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toMatch(
      /does not match declared type/,
    );
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects image/svg+xml even when the bytes really are SVG", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(Buffer.from("<svg/>"), "logo.svg", "image/svg+xml"),
      }),
    );

    expect(response.status).toBe(400);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a MIME type the allow-list has never heard of", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(pngBytes(64, 64), "logo.png", "image/x-icon"),
      }),
    );

    expect(response.status).toBe(400);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a PNG-shaped file that is actually a JPEG", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(jpegBytes(64, 64), "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toMatch(
      /does not match declared type/,
    );
  });

  it("rejects an empty file and one over the size limit", async () => {
    const empty = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(Buffer.alloc(0), "logo.png", "image/png"),
      }),
    );
    expect(empty.status).toBe(400);

    const oversized = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(
          bytesOf(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(LOGO_MAX_BYTES - 7),
          ),
          "logo.png",
          "image/png",
        ),
      }),
    );
    expect(oversized.status).toBe(400);
    expect((await jsonBody(oversized)).error).toMatch(/1 byte and 5 MB/);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("reads dimensions from the file itself and rejects oversized pixels", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(
          pngBytes(LOGO_MAX_DIMENSION_PX + 1, 10),
          "logo.png",
          "image/png",
        ),
      }),
    );

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toMatch(/2000x2000/);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an image whose dimensions cannot be parsed", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(pngWithoutHeaderBytes(), "logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toMatch(
      /Could not read image dimensions/,
    );
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("stores a valid PNG under the authorized tenant with a random name and 0o640", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(pngBytes(640, 480), "my logo.png", "image/png"),
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    const logoUrl = String(
      body.data && (body.data as Record<string, unknown>).logoUrl,
    );
    expect(logoUrl).toMatch(
      new RegExp(`^/uploads/tenants/${TENANT_ID}/logo/[0-9a-f]{32}\\.png$`),
    );

    expect(posix(fsMock.mkdir.mock.calls[0]?.[0])).toContain(
      posix(`uploads/tenants/${TENANT_ID}/logo`),
    );
    const [, buffer, options] = fsMock.writeFile.mock.calls[0] ?? [];
    expect(
      basename(posix(String(fsMock.writeFile.mock.calls[0]?.[0]))),
    ).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect((options as { mode?: number }).mode).toBe(0o640);

    const upsert = (prismaMock.tenantBranding.upsert.mock.calls[0]?.[0] ??
      {}) as {
      where: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsert.where).toEqual({ tenantId: TENANT_ID });
    expect(Object.keys(upsert.update)).toEqual(["logoUrl"]);
  });

  it("never lets the supplied file name reach the stored path", async () => {
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(
          pngBytes(100, 100),
          "../../../../config/evil.png",
          "image/png",
        ),
      }),
    );

    expect(response.status).toBe(200);
    const written = posix(fsMock.writeFile.mock.calls[0]?.[0]);
    expect(written).not.toContain("..");
    expect(written).not.toContain("evil");
    expect(written).toContain(`uploads/tenants/${TENANT_ID}/logo/`);
    expect(basename(written)).toMatch(/^[0-9a-f]{32}\.png$/);

    const audits = auditsFor(AUDIT_ACTIONS.BRANDING_LOGO_UPLOADED);
    expect(JSON.stringify(audits)).not.toContain("evil");
    expect(JSON.stringify(audits)).toContain("logoUrl");
  });

  it("derives the extension from the verified type, not the file name", async () => {
    // A JPEG named .png: the declared MIME is honest, the name is not.
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(jpegBytes(100, 100), "logo.png", "image/jpeg"),
      }),
    );

    expect(response.status).toBe(200);
    expect(basename(posix(fsMock.writeFile.mock.calls[0]?.[0]))).toMatch(
      /^[0-9a-f]{32}\.jpg$/,
    );
  });

  it("measures a real JPEG from its SOF marker", async () => {
    const ok = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(jpegBytes(640, 480), "logo.jpg", "image/jpeg"),
      }),
    );
    expect(ok.status).toBe(200);

    // Same file, dimensions over the limit — proves the width is read from the
    // SOF payload rather than the segment length.
    vi.clearAllMocks();
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
    prismaMock.tenantBranding.upsert.mockResolvedValue({ id: "branding_1" });
    authMock.mockResolvedValue({ id: USER_ID });
    asRole("TENANT_ADMIN");

    const tooWide = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(jpegBytes(2400, 10), "logo.jpg", "image/jpeg"),
      }),
    );
    expect(tooWide.status).toBe(400);
    expect((await jsonBody(tooWide)).error).toMatch(/2000x2000/);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("accepts each supported WebP layout", async () => {
    const cases: Buffer[] = [
      webpExtended(320, 240),
      webpLossy(320, 240),
      webpLossless(320, 240),
    ];

    for (const bytes of cases) {
      const response = await uploadLogo(
        uploadRequest({
          tenantId: TENANT_ID,
          file: file(bytes, "logo.webp", "image/webp"),
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(fsMock.writeFile).toHaveBeenCalledTimes(3);
  });

  it("rejects an oversized extended WebP and a signature-less lossy WebP", async () => {
    const huge = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(webpExtended(4000, 20), "logo.webp", "image/webp"),
      }),
    );
    expect(huge.status).toBe(400);
    expect((await jsonBody(huge)).error).toMatch(/2000x2000/);

    const broken = webpLossy(320, 240);
    broken[24] = 0x00; // destroy the 9d 01 2a start code
    const response = await uploadLogo(
      uploadRequest({
        tenantId: TENANT_ID,
        file: file(broken, "logo.webp", "image/webp"),
      }),
    );
    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toMatch(
      /Could not read image dimensions/,
    );
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a request with no file part", async () => {
    const response = await uploadLogo(uploadRequest({ tenantId: TENANT_ID }));
    expect(response.status).toBe(400);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});

// ── Serving route ────────────────────────────────────────────────────────────

describe("Phase 04 private upload serving route", () => {
  const root = () => posix(process.cwd());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: null,
      status: "ACTIVE",
    });
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

  it("serves an in-tenant logo privately and without sniffing", async () => {
    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox",
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");

    const read = servedPath();
    expect(read).toContain(
      posix(`uploads/tenants/${TENANT_ID}/logo/${HEX_NAME}.png`),
    );
    expect(read.startsWith(root())).toBe(true);
  });

  it("maps the extension to the content type instead of trusting the file", async () => {
    for (const [name, type] of [
      [`${HEX_NAME}.jpg`, "image/jpeg"],
      [`${HEX_NAME}.webp`, "image/webp"],
    ] as const) {
      const response = await get(["tenants", TENANT_ID, "logo", name]);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(type);
    }
  });

  it("never serves an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);

    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(401);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("never serves another tenant's folder to a member", async () => {
    const response = await get([
      "tenants",
      OTHER_TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(await jsonBody(response)).toEqual({ error: "Not found" });
  });

  it("serves any member of the tenant, including a suspended one", async () => {
    // Serving is membership-based, not permission-based: a VIEWER legitimately
    // sees the workspace logo.
    asRole("VIEWER");
    const own = await get(["tenants", TENANT_ID, "logo", `${HEX_NAME}.png`]);
    expect(own.status).toBe(200);

    // Phase 2 decision, stated here so the serving route's `resolveTenantContext`
    // call is read as intentional: suspension pauses a workspace's WRITES and
    // synchronization and keeps its existing records readable and downloadable.
    // A logo is one of those records — an invoice PDF already issued under it is
    // the reason the rule exists — so a suspended member is served their own file
    // while every write path (`assertWritableContext`, the branding actions) is
    // refused.
    vi.clearAllMocks();
    fsMock.readFile.mockResolvedValue(Buffer.from("logo-bytes"));
    fsMock.stat.mockResolvedValue({ isFile: () => true });
    asRole("TENANT_OWNER", "SUSPENDED");
    const suspended = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);
    expect(suspended.status).toBe(200);
    expect(servedPath()).toContain(
      posix(`uploads/tenants/${TENANT_ID}/logo/${HEX_NAME}.png`),
    );

    // The read stays scoped: the same suspended member cannot reach another
    // workspace's folder, and the tenant's own path is the only one served.
    vi.clearAllMocks();
    fsMock.readFile.mockResolvedValue(Buffer.from("logo-bytes"));
    fsMock.stat.mockResolvedValue({ isFile: () => true });
    const foreign = await get([
      "tenants",
      OTHER_TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);
    expect(foreign.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("never serves a PENDING workspace, which has no records to read", async () => {
    // PENDING is not "suspended but readable": the tenant was never opened, so
    // authorization refuses it outright and the filesystem is never touched.
    asRole("TENANT_OWNER", "PENDING");

    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("rejects traversal, wrong shapes and unexpected extensions with 404", async () => {
    const attempts: string[][] = [
      // not four segments
      ["tenants", TENANT_ID, `${HEX_NAME}.png`],
      ["tenants", TENANT_ID, "logo", `${HEX_NAME}.png`, "extra"],
      // wrong folder
      ["tenants", TENANT_ID, "documents", `${HEX_NAME}.png`],
      // parent traversal in any segment
      ["..", TENANT_ID, "logo", `${HEX_NAME}.png`],
      ["tenants", TENANT_ID, "..", `${HEX_NAME}.png`],
      ["tenants", TENANT_ID, "logo", ".."],
      ["tenants", TENANT_ID, "logo", "..%2f..%2fsecret.png"],
      // absolute path / drive-qualified segment
      ["tenants", TENANT_ID, "logo", "C:/Windows/system32/config"],
      // a file name that is not exactly 32 hex + a raster extension
      ["tenants", TENANT_ID, "logo", `${HEX_NAME}.svg`],
      ["tenants", TENANT_ID, "logo", `${HEX_NAME}.html`],
      ["tenants", TENANT_ID, "logo", `${HEX_NAME}.php.png`],
      ["tenants", TENANT_ID, "logo", `${HEX_NAME.slice(0, 31)}.png`],
      ["tenants", TENANT_ID, "logo", `${HEX_NAME}a.png`],
      // an empty or NUL-bearing segment
      ["tenants", "", "logo", `${HEX_NAME}.png`],
      ["tenants", TENANT_ID, "logo", `\0${HEX_NAME}.png`],
    ];

    const problems: string[] = [];
    for (const attempt of attempts) {
      const response = await get(attempt);
      if (response.status !== 404)
        problems.push(`${attempt.join("/")} -> ${response.status}`);
    }

    expect(problems).toEqual([]);
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(fsMock.stat).not.toHaveBeenCalled();
  });

  it("does not query membership for a malformed tenant id", async () => {
    const response = await get([
      "tenants",
      "not-a-cuid",
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(404);
    expect(prismaMock.tenantMember.findUnique).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("404s a path that resolves outside the uploads root", async () => {
    // Defence in depth: even if the shape check were bypassed, the resolved
    // path must stay under the uploads root.
    fsMock.stat.mockRejectedValue(new Error("ENOENT"));
    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("404s when the resolved path is a directory rather than a file", async () => {
    fsMock.stat.mockResolvedValue({ isFile: () => false });

    const response = await get([
      "tenants",
      TENANT_ID,
      "logo",
      `${HEX_NAME}.png`,
    ]);

    expect(response.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});
