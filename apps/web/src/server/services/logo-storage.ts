import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import {
  LOGO_ALLOWED_MIME_TYPES,
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION_PX,
} from "@/lib/validations/branding";
import { put } from "@vercel/blob";

/**
 * Logo file validation and storage, shared by the tenant and provider upload
 * routes.
 *
 * Phase 2 lets authorised provider staff configure a workspace's branding,
 * including its logo, and the tenant route already refuses to trust a file's
 * name or declared MIME type. Two writers therefore need the SAME rules: if the
 * provider path re-implemented classification, the two could drift and the
 * weaker one would become the way in. Everything security-relevant about a logo
 * lives here, and both routes consume it.
 *
 * The rules are unchanged from the Phase 04 route, just moved:
 *  1. the declared type must be in the raster allow-list — SVG is excluded
 *     because it can carry script;
 *  2. the size must be within the byte limit;
 *  3. the bytes must begin with the magic sequence for the declared type;
 *  4. the pixel dimensions must be readable from the bytes and within bounds —
 *     an unparsable header is a rejection, not a pass.
 *
 * The stored name is generated from verified bytes only; the uploaded file name
 * never reaches the path.
 */

export const LOGO_MIME_ALLOWED = LOGO_ALLOWED_MIME_TYPES;

const MAGIC_BYTES: Record<string, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF; "WEBP" is checked at offset 8
};

export function verifyLogoMagicBytes(
  buffer: Buffer,
  mimeType: string,
): boolean {
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

let warnedEphemeralStorage = false;

/**
 * Record, once, that brand assets are being written to the local filesystem.
 * On serverless hosting (e.g. Vercel) that storage is ephemeral, so this is a
 * clear setup signal rather than a silent data-loss bug. It never blocks the
 * write — replaced by real private object storage in the P0/P1 backlog.
 */
function warnIfStorageEnvironmentIsEphemeral(): void {
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) return;
  if (warnedEphemeralStorage) return;
  warnedEphemeralStorage = true;
  console.warn(
    "[logo-storage] Assets are written to the local filesystem, which is ephemeral on serverless hosting. Configure private object storage before production.",
  );
}

/**
 * Returns BLOB_READ_WRITE_TOKEN or throws a clear configuration error.
 * Vercel auto-injects this when a Blob store is linked to the project;
 * on other hosts it must be set manually.
 */
function requireBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set. " +
        "Link a Vercel Blob store to this project or set the variable manually. " +
        "Without it logo uploads cannot be persisted in production.",
    );
  }
  return token;
}

export function logoSizeProblem(size: number): string | null {
  if (size === 0 || size > LOGO_MAX_BYTES) {
    return "File must be between 1 byte and 5 MB";
  }
  return null;
}

export type LogoValidation =
  { ok: true; mimeType: string } | { ok: false; error: string };

/**
 * Classifies uploaded bytes against a declared MIME type. The message for each
 * refusal is part of the contract both routes return, so it lives here too.
 */
export function validateLogoBytes(
  buffer: Buffer,
  declaredType: string,
): LogoValidation {
  if (!(LOGO_MIME_ALLOWED as readonly string[]).includes(declaredType)) {
    return { ok: false, error: "Only PNG, JPEG and WebP logos are supported" };
  }

  const sizeProblem = logoSizeProblem(buffer.length);
  if (sizeProblem) {
    return { ok: false, error: sizeProblem };
  }

  if (!verifyLogoMagicBytes(buffer, declaredType)) {
    return { ok: false, error: "File content does not match declared type" };
  }

  const dimensions = readLogoDimensions(buffer, declaredType);
  if (!dimensions) {
    return { ok: false, error: "Could not read image dimensions" };
  }
  if (
    dimensions.width > LOGO_MAX_DIMENSION_PX ||
    dimensions.height > LOGO_MAX_DIMENSION_PX ||
    dimensions.width === 0 ||
    dimensions.height === 0
  ) {
    return {
      ok: false,
      error: `Image dimensions must not exceed ${LOGO_MAX_DIMENSION_PX}x${LOGO_MAX_DIMENSION_PX} pixels`,
    };
  }

  return { ok: true, mimeType: declaredType };
}

export interface StoredLogo {
  logoUrl: string;
  fileName: string;
}

/**
 * Writes verified logo bytes to the configured storage backend and returns the
 * URL the serving route understands.
 *
 * Storage strategy:
 *  - Production (BLOB_READ_WRITE_TOKEN + AMISIBIZ_STORE_ID set): Vercel Blob —
 *    durable, CDN-backed, works on serverless where the filesystem is read-only.
 *    AMISIBIZ_STORE_ID targets the named store; BLOB_READ_WRITE_TOKEN is the
 *    auth token auto-injected by Vercel when the store is linked to the project.
 *  - Development / local: local filesystem under `uploads/` — zero config,
 *    served by the /uploads API route.
 *
 * The tenant id must already have been authorised — this function never
 * validates it, and it never reads the caller's input as a path.
 */
export async function storeTenantLogo(
  tenantId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<StoredLogo> {
  const ext = EXTENSION_BY_MIME[mimeType] ?? "bin";
  const fileName = `${randomBytes(16).toString("hex")}.${ext}`;

  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.AMISIBIZ_STORE_ID) {
    // ── Vercel Blob (production) ──────────────────────────────────────────
    // requireBlobToken() throws a descriptive error if the token is absent,
    // which surfaces in the route's catch block with the real reason rather
    // than a silent SDK failure.
    const token = requireBlobToken();
    const pathname = `tenants/${tenantId}/logo/${fileName}`;
    const blob = await put(pathname, buffer, {
      access: "public",
      contentType: mimeType,
      addRandomSuffix: false,
      token,
      ...(process.env.AMISIBIZ_STORE_ID
        ? { storeId: process.env.AMISIBIZ_STORE_ID }
        : {}),
    });
    return { fileName, logoUrl: blob.url };
  }

  if (process.env.VERCEL) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set on Vercel. Link Vercel Blob in your Vercel Project Settings or add BLOB_READ_WRITE_TOKEN to Environment Variables.",
    );
  }

  // ── Local filesystem (development) ──────────────────────────────────────
  warnIfStorageEnvironmentIsEphemeral();
  const uploadDir = join(process.cwd(), "uploads", "tenants", tenantId, "logo");
  await mkdir(uploadDir, { recursive: true });
  await writeFile(join(uploadDir, fileName), buffer, { mode: 0o640 });
  return {
    fileName,
    logoUrl: `/uploads/tenants/${tenantId}/logo/${fileName}`,
  };
}

/** Reads width/height from a supported raster's own header, or null. */
export function readLogoDimensions(
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
