import { randomBytes } from "crypto";
import { put } from "@vercel/blob";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Item image storage (AGENT 02 module C).
 *
 * This mirrors the owner's Vercel Blob seam in `services/logo-storage.ts`
 * (`put()` with `BLOB_READ_WRITE_TOKEN`, `access: "public"`, store targeting
 * through `AMISIBIZ_STORE_ID`) but is deliberately a SEPARATE small module:
 * the logo seam is owner-in-flight code, and item images differ in policy —
 * `addRandomSuffix: true` here (logos use `false`), a 2 MB cap, and — unlike
 * the logo path — NO local-filesystem fallback. Item images are fail-closed:
 * without a blob token the upload refuses with the seam's descriptive error
 * and no `ItemImage` row is ever written. We never store a fake URL (§7:
 * "no fake storage").
 */

/** Content types admitted for item images: the same raster allow-list as
 *  logos (SVG excluded because it can carry script). */
export const ITEM_IMAGE_MIME_ALLOWED = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export const ITEM_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const MAGIC_BYTES: Record<string, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF; "WEBP" is checked at offset 8
};

/** Same fail-closed contract as the logo seam's `requireBlobToken`. */
export function requireItemImageBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set. " +
        "Link a Vercel Blob store to this project or set the variable manually. " +
        "Without it item image uploads cannot be persisted in production.",
    );
  }
  return token;
}

function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/webp") {
    if (buffer.length < 12) return false;
    return (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    );
  }
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;
  return signatures.some((signature) =>
    signature.every((byte, index) => buffer[index] === byte),
  );
}

export interface ItemImageValidation {
  ok: boolean;
  error?: string;
}

/**
 * Classify an uploaded image: declared type in the allow-list, size within the
 * cap, and bytes whose header matches the declared type. The file NAME is
 * never consulted — the stored name is generated from verified bytes only.
 */
export function validateItemFile(
  buffer: Buffer,
  declaredType: string,
): ItemImageValidation {
  if (!(ITEM_IMAGE_MIME_ALLOWED as readonly string[]).includes(declaredType)) {
    return { ok: false, error: "Only PNG, JPEG and WebP images are supported" };
  }
  if (buffer.length === 0 || buffer.length > ITEM_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      error: "File must be between 1 byte and 2 MB",
    };
  }
  if (!verifyMagicBytes(buffer, declaredType)) {
    return { ok: false, error: "File content does not match declared type" };
  }
  return { ok: true };
}

export interface UploadItemImageResult {
  id: string;
  itemId: string;
  position: number;
  blobUrl: string;
  alt: string | null;
}

/**
 * Upload one item image through the Blob seam and record its row.
 *
 * Order of operations is the security contract:
 *  1. the item must exist IN THE AUTHORIZED TENANT (a forged itemId from
 *     another workspace finds no row);
 *  2. bytes are validated (type allow-list, size cap, magic bytes);
 *  3. the blob token is demanded — a missing token aborts HERE, before any
 *     row exists, and the descriptive error propagates to the caller;
 *  4. `put()` uploads with `addRandomSuffix: true` (public catalogue assets
 *     get unique, cache-friendly names) and the caller-provided alt text;
 *  5. only a successful upload writes the `ItemImage` row, positioned next
 *     after the current max for the item.
 *
 * The tenant id comes exclusively from the authorization context; nothing on
 * this path trusts a client-supplied id beyond the item lookup, which is
 * tenant-scoped.
 */
export async function uploadItemImage(
  authz: TenantAuthzContext,
  options: {
    itemId: string;
    file: File;
    alt?: string | null;
  },
): Promise<
  | { ok: true; image: UploadItemImageResult }
  | {
      ok: false;
      code: "NOT_FOUND" | "VALIDATION_ERROR" | "INTERNAL";
      message: string;
    }
> {
  const item = await prisma.item.findFirst({
    where: { id: options.itemId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!item) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Item not found.",
    };
  }

  const declaredType = options.file.type;
  const buffer = Buffer.from(await options.file.arrayBuffer());
  const validation = validateItemFile(buffer, declaredType);
  if (!validation.ok) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: validation.error ?? "Invalid image.",
    };
  }

  // Fail-closed BEFORE anything is stored or written: no token, no upload,
  // no row, no fake URL. The message is the seam's own descriptive error.
  const token = requireItemImageBlobToken();

  const ext = EXTENSION_BY_MIME[declaredType] ?? "bin";
  const fileName = `${randomBytes(16).toString("hex")}.${ext}`;
  const pathname = `tenants/${authz.tenantId}/items/${options.itemId}/${fileName}`;

  const blob = await put(pathname, buffer, {
    access: "public",
    contentType: declaredType,
    addRandomSuffix: true,
    token,
    ...(process.env.AMISIBIZ_STORE_ID
      ? { storeId: process.env.AMISIBIZ_STORE_ID }
      : {}),
  });

  // Position next after the current max for this item.
  const last = await prisma.itemImage.findFirst({
    where: { tenantId: authz.tenantId, itemId: options.itemId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = (last?.position ?? 0) + 1;

  const image = await prisma.itemImage.create({
    data: {
      tenantId: authz.tenantId,
      itemId: options.itemId,
      position,
      blobUrl: blob.url,
      alt: options.alt?.trim() || null,
    },
    select: {
      id: true,
      itemId: true,
      position: true,
      blobUrl: true,
      alt: true,
    },
  });

  return { ok: true, image };
}

/**
 * Delete an image row. The blob object itself is left in storage (deleting
 * remote bytes has no tenant-safety advantage and an accidental click should
 * not destroy bytes another row may still reference); the row's URL is what
 * stops the image from being served. Tenant-scoped through `deleteMany`.
 */
export async function deleteImageRow(
  authz: TenantAuthzContext,
  imageId: string,
): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND"; message: string }> {
  const result = await prisma.itemImage.deleteMany({
    where: { id: imageId, tenantId: authz.tenantId },
  });
  if (result.count === 0) {
    return { ok: false, code: "NOT_FOUND", message: "Image not found." };
  }
  return { ok: true };
}
