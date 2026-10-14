import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeTenant } from "@/server/auth/authorization";
import { prisma } from "@/lib/db/prisma";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { randomBytes } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION_PX,
  LOGO_ALLOWED_MIME_TYPES,
} from "@/lib/validations/branding";

/**
 * Logo upload.
 *
 * Trust order: the session is the only identity source, the tenant id is
 * re-authorized against membership, and the file is classified from its own
 * bytes rather than its name or its declared MIME type. Raster formats only —
 * SVG is excluded because it can carry scripts.
 */

const uploadRequestSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
});

const MAGIC_BYTES: Record<string, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF; "WEBP" is checked at offset 8
};

function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/webp") {
    if (buffer.length < 12) return false;
    const riff = buffer.subarray(0, 4);
    const webp = buffer.subarray(8, 12);
    return (
      riff[0] === 0x52 &&
      riff[1] === 0x49 &&
      riff[2] === 0x46 &&
      riff[3] === 0x46 &&
      webp[0] === 0x57 &&
      webp[1] === 0x45 &&
      webp[2] === 0x42 &&
      webp[3] === 0x50
    );
  }

  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;

  return signatures.some((signature) =>
    signature.every((byte, index) => buffer[index] === byte),
  );
}

/** Extension is derived from the verified MIME type, never from user input. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthenticated" },
        { status: 401 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const tenantIdRaw = formData.get("tenantId");

    if (!(file instanceof File) || typeof tenantIdRaw !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing file or tenant ID" },
        { status: 400 },
      );
    }

    const parsedTenant = uploadRequestSchema.safeParse({
      tenantId: tenantIdRaw,
    });
    if (!parsedTenant.success) {
      return NextResponse.json(
        { success: false, error: "Invalid tenant ID" },
        { status: 400 },
      );
    }

    try {
      await authorizeTenant(
        session.user.id,
        parsedTenant.data.tenantId,
        PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
      );
    } catch {
      return NextResponse.json(
        { success: false, error: "Not permitted" },
        { status: 403 },
      );
    }

    // Declared type must be one of the supported rasters; the byte check below
    // must then agree with it.
    if (!(LOGO_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: "Only PNG, JPEG and WebP logos are supported",
        },
        { status: 400 },
      );
    }

    if (file.size === 0 || file.size > LOGO_MAX_BYTES) {
      return NextResponse.json(
        { success: false, error: "File must be between 1 byte and 5 MB" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (!verifyMagicBytes(buffer, file.type)) {
      return NextResponse.json(
        { success: false, error: "File content does not match declared type" },
        { status: 400 },
      );
    }

    // Dimensions are read from the file itself. An unparsable header is a
    // rejection, not a pass: otherwise a crafted file could skip the check.
    const dimensions = getImageDimensions(buffer, file.type);
    if (!dimensions) {
      return NextResponse.json(
        { success: false, error: "Could not read image dimensions" },
        { status: 400 },
      );
    }
    if (
      dimensions.width > LOGO_MAX_DIMENSION_PX ||
      dimensions.height > LOGO_MAX_DIMENSION_PX ||
      dimensions.width === 0 ||
      dimensions.height === 0
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `Image dimensions must not exceed ${LOGO_MAX_DIMENSION_PX}x${LOGO_MAX_DIMENSION_PX} pixels`,
        },
        { status: 400 },
      );
    }

    const tenantId = parsedTenant.data.tenantId;
    const fileName = `${randomBytes(16).toString("hex")}.${EXTENSION_BY_MIME[file.type]}`;
    const uploadDir = join(
      process.cwd(),
      "uploads",
      "tenants",
      tenantId,
      "logo",
    );
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, fileName), buffer, { mode: 0o640 });

    const logoUrl = `/uploads/tenants/${tenantId}/logo/${fileName}`;

    await prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, logoUrl },
      update: { logoUrl },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.BRANDING_LOGO_UPLOADED,
      userId: session.user.id,
      tenantId,
      resource: "TenantBranding",
      resourceId: tenantId,
      metadata: { field: "logoUrl", fileName },
    });

    return NextResponse.json({ success: true, data: { logoUrl } });
  } catch (err) {
    console.error("[POST /api/branding/logo]", err);
    return NextResponse.json(
      { success: false, error: "Upload failed" },
      { status: 500 },
    );
  }
}

function getImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  try {
    if (mimeType === "image/png") {
      // PNG: IHDR width/height are big-endian at 16 and 20.
      if (buffer.length < 24) return null;
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }

    if (mimeType === "image/jpeg") {
      // JPEG: walk segments until an SOF marker is found.
      //
      // Marker layout: FF <code> [<2-byte length> <payload ...>], where the
      // length counts itself and the payload but not the two marker bytes.
      // SOF0/2 (FF C0 / FF C2) then holds:
      //   offset+0 FF, offset+1 Cx, offset+2..3 length, offset+4 precision,
      //   offset+5..6 height, offset+7..8 width (big-endian).
      let offset = 2; // skip SOI
      while (offset + 9 <= buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        if (marker === undefined) return null;
        const isStartOfFrame =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isStartOfFrame) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        // TEM, RSTn, SOI and EOI carry no length field — step over the two
        // marker bytes instead of mis-reading the next marker as a length.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          offset += 2;
          continue;
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        if (segmentLength < 2) return null;
        offset += 2 + segmentLength;
      }
      return null;
    }

    if (mimeType === "image/webp") {
      const chunk = buffer.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X") {
        // Extended header: flags at 20, reserved 21-23, canvas width-1 in the
        // 3 bytes at 24 and canvas height-1 in the 3 bytes at 27.
        if (buffer.length < 30) return null;
        return {
          width: buffer.readUIntLE(24, 3) + 1,
          height: buffer.readUIntLE(27, 3) + 1,
        };
      }
      if (chunk === "VP8L") {
        if (buffer.length < 25) return null;
        // VP8L stores width-1 and height-1 across bits 1..18 and 19..32.
        const bits = buffer.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      if (chunk === "VP8 ") {
        // Lossy VP8 bitstream begins at byte 20: 4-byte frame tag, then the
        // 9d 01 2a start code at 24-26, then 14-bit width at 27 and 14-bit
        // height at 29 (little-endian, each followed by a scale bits pair).
        if (buffer.length < 31) return null;
        if (buffer[24] !== 0x9d || buffer[25] !== 0x01 || buffer[26] !== 0x2a) {
          return null;
        }
        return {
          width: buffer.readUInt16LE(27) & 0x3fff,
          height: buffer.readUInt16LE(29) & 0x3fff,
        };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}
