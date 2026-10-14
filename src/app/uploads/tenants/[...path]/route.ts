import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { getSessionUser } from "@/lib/auth/session-user";
import { resolveTenantContext } from "@/server/auth/authorization";
import { z } from "zod";
/**
 * Private serving route for tenant uploads (currently logos).
 *
 * Three controls, all required:
 *  1. The caller must be authenticated and an active member of the tenant whose
 *     folder is being read — `UPLOADS_ROOT/**` is not public.
 *  2. The path must match the exact expected shape
 *     `tenants/<cuid>/logo/<32-hex>.<ext>`; nothing is joined from user text, so
 *     traversal (`..`, encoded separators, absolute paths) cannot be expressed.
 *  3. The resolved absolute path is re-checked to sit under the uploads root, and
 *     the extension decides the Content-Type (SVG is never served).
 *
 * Responses are private, non-stored, nosniff and sandboxed.
 */

const UPLOADS_ROOT = join(process.cwd(), "uploads");

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

const tenantIdSchema = z.string().cuid("Invalid tenant ID");

const FILENAME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const FILE_NAME = /^[0-9a-f]{32}\.(png|jpe?g|webp)$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Reject anything that is not a plain, dot-free path segment. */
function isSafeSegment(value: string): boolean {
  return (
    SEGMENT.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;

    if (!Array.isArray(path) || path.length !== 4) {
      return jsonError("Not found", 404);
    }

    const [root, tenantId, folder, fileName] = path as [
      string,
      string,
      string,
      string,
    ];

    if (
      root !== "tenants" ||
      folder !== "logo" ||
      !path.every(isSafeSegment) ||
      !FILE_NAME.test(fileName)
    ) {
      return jsonError("Not found", 404);
    }

    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    if (!parsedTenant.success) {
      return jsonError("Not found", 404);
    }

    const user = await getSessionUser();
    if (!user) {
      return jsonError("Unauthenticated", 401);
    }

    // Membership (and tenant operational status) is checked on every read.
    try {
      await resolveTenantContext(user.id, parsedTenant.data);
    } catch {
      return jsonError("Not found", 404);
    }

    const absolute = resolve(UPLOADS_ROOT, root, parsedTenant.data, folder, fileName);
    const insideRoot =
      absolute.startsWith(UPLOADS_ROOT + sep) || absolute === UPLOADS_ROOT;
    if (!insideRoot) {
      return jsonError("Not found", 404);
    }

    const info = await stat(absolute);
    if (!info.isFile()) {
      return jsonError("Not found", 404);
    }

    const fileBuffer = await readFile(absolute);
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const contentType = FILENAME_BY_EXT[ext];
    if (!contentType) {
      return jsonError("Not found", 404);
    }

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileBuffer.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // A logo opened directly must never be able to run script or load
        // anything from the application origin.
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return jsonError("Not found", 404);
  }
}
