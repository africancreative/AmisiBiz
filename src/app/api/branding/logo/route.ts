import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { randomBytes } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// Magic bytes for allowed image types
const MAGIC_BYTES: Record<string, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF header - need to check for WEBP at offset 8
  "image/svg+xml": [[0x3c, 0x3f, 0x78, 0x6d, 0x6c], [0x3c, 0x73, 0x76, 0x67]], // <?xml or <svg
};

function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;

  // Special handling for WebP - check for "WEBP" at offset 8
  if (mimeType === "image/webp") {
    if (buffer.length < 12) return false;
    const riff = buffer.subarray(0, 4);
    const webp = buffer.subarray(8, 12);
    return riff[0] === 0x52 && riff[1] === 0x49 && riff[2] === 0x46 && riff[3] === 0x46 &&
           webp[0] === 0x57 && webp[1] === 0x45 && webp[2] === 0x42 && webp[3] === 0x50;
  }

  // For other types, check if any signature matches at the start
  return signatures.some((sig) =>
    sig.every((byte, i) => buffer[i] === byte)
  );
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File;
    const tenantId = formData.get("tenantId") as string;

    if (!file || !tenantId) {
      return NextResponse.json({ success: false, error: "Missing file or tenant ID" }, { status: 400 });
    }

    try {
      await authorizeTenant(session.user.id, tenantId, PERMISSIONS.BUSINESS_SETTINGS_UPDATE);
    } catch (err) {
      return NextResponse.json({ success: false, error: "Not permitted" }, { status: 403 });
    }

    const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ success: false, error: "Invalid file type" }, { status: 400 });
    }

    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ success: false, error: "File too large" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Verify file content matches declared type (magic bytes)
    if (!verifyMagicBytes(buffer, file.type)) {
      return NextResponse.json({ success: false, error: "File content does not match declared type" }, { status: 400 });
    }

    // Verify image dimensions for raster formats
    if (file.type !== "image/svg+xml") {
      const dimensions = getImageDimensions(buffer, file.type);
      if (dimensions && (dimensions.width > 2000 || dimensions.height > 2000)) {
        return NextResponse.json({ success: false, error: "Image dimensions must not exceed 2000x2000 pixels" }, { status: 400 });
      }
    }

    const ext = file.type.split("/")[1];
    const fileName = `${randomBytes(16).toString("hex")}.${ext}`;
    const uploadDir = join(process.cwd(), "uploads", "tenants", tenantId, "logo");
    await mkdir(uploadDir, { recursive: true });
    const filePath = join(uploadDir, fileName);
    await writeFile(filePath, buffer);

    const logoUrl = `/uploads/tenants/${tenantId}/logo/${fileName}`;

    await prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, logoUrl },
      update: { logoUrl },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_UPDATED,
      userId: session.user.id,
      tenantId,
      resource: "TenantBranding",
      resourceId: tenantId,
      metadata: { field: "logoUrl", fileName },
    });

    return NextResponse.json({ success: true, data: { logoUrl } });
  } catch (err) {
    console.error("[POST /api/branding/logo]", err);
    return NextResponse.json({ success: false, error: "Upload failed" }, { status: 500 });
  }
}

function getImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === "image/png") {
      // PNG: IHDR chunk at offset 8, width at 16, height at 20 (big-endian)
      if (buffer.length < 24) return null;
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    if (mimeType === "image/jpeg") {
      // JPEG: scan for SOF markers (0xFFC0-0xFFCF except 0xFFC4, 0xFFC8, 0xFFCC)
      let offset = 2; // Skip SOI
      while (offset < buffer.length - 2) {
        if (buffer[offset] !== 0xFF) return null;
        const marker = buffer[offset + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          if (offset + 7 >= buffer.length) return null;
          const height = buffer.readUInt16BE(offset + 3);
          const width = buffer.readUInt16BE(offset + 5);
          return { width, height };
        }
        // Skip segment
        if (offset + 3 >= buffer.length) return null;
        const segmentLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + segmentLength;
      }
      return null;
    }
    if (mimeType === "image/webp") {
      // WebP: VP8/VP8L/VP8X chunk - simplified check
      // RIFF header (12 bytes) + VP8X (if extended) or VP8/VP8L
      if (buffer.length < 30) return null;
      // Check for VP8X (extended)
      if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x58) {
        // VP8X chunk - dimensions at offset 24 (24+12=36 from start)
        if (buffer.length < 36) return null;
        const width = buffer.readUIntLE(24, 3) + 1; // 24 bits
        const height = buffer.readUIntLE(27, 3) + 1;
        return { width, height };
      }
      // Check for VP8 (lossy) or VP8L (lossless)
      if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38) {
        const isLossless = buffer[15] === 0x4C; // VP8L
        if (isLossless) {
          // VP8L: dimensions in bitstream - complex, skip for now
          return null;
        } else {
          // VP8: dimensions at offset 26 (12 RIFF + 8 chunk header + 6)
          if (buffer.length < 30) return null;
          const width = buffer.readUInt16LE(26) & 0x3FFF;
          const height = buffer.readUInt16LE(28) & 0x3FFF;
          return { width, height };
        }
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}