import { randomBytes } from "node:crypto";
import { put } from "@vercel/blob";
import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import {
  SOCIAL_AUDIT_ACTIONS,
  SocialServiceError,
} from "@/server/services/integrations/errors";
import {
  ITEM_IMAGE_MIME_ALLOWED,
  ITEM_IMAGE_MAX_BYTES,
} from "@/server/services/item-images";

/**
 * Media library (AGENT 03 module B — `media.ts`).
 *
 * `MediaAsset` rides the SAME fail-closed Vercel Blob seam as `ItemImage`
 * (`@vercel/blob` `put()` with `BLOB_READ_WRITE_TOKEN`) and inherits its rule
 * verbatim: **no blob token ⇒ the upload refuses with the seam's descriptive
 * error and NO row is ever written.** We never store a fake URL (migration
 * comment: "no fake storage"). `blobUrl` is produced server-side from a
 * successful upload and is never a client field.
 *
 * The tenant comes from the authorization context. A delete removes the row
 * (which stops the asset being served) but leaves the remote bytes, matching the
 * item-image policy: deleting a row is not a safe way to destroy bytes another
 * draft may still reference.
 */

export type MediaAssetRow = Prisma.MediaAssetGetPayload<Record<string, never>>;

/** VIDEO reuses the same raster/video allow-list posture; images are the
 *  currently-supported media for feed publishing, so videos are admitted only
 *  by explicit content-type to keep the magic-byte rule honest. */
const VIDEO_MIME_ALLOWED = ["video/mp4", "video/quicktime"] as const;

function requireBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new SocialServiceError(
      "PROVIDER_UNAVAILABLE",
      "Media storage is not configured on this deployment. Link a Vercel Blob " +
        "store or set the blob token before uploading media; nothing will be " +
        "stored without it.",
    );
  }
  return token;
}

function allowedMime(mime: string): boolean {
  return (
    (ITEM_IMAGE_MIME_ALLOWED as readonly string[]).includes(mime) ||
    (VIDEO_MIME_ALLOWED as readonly string[]).includes(mime)
  );
}

function kindForMime(
  mime: string,
  declared: "IMAGE" | "VIDEO",
): "IMAGE" | "VIDEO" {
  if ((VIDEO_MIME_ALLOWED as readonly string[]).includes(mime)) return "VIDEO";
  if ((ITEM_IMAGE_MIME_ALLOWED as readonly string[]).includes(mime)) {
    return "IMAGE";
  }
  return declared;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export async function uploadMediaAsset(
  authz: TenantAuthzContext,
  actorId: string,
  options: { file: File; alt?: string | null; kind: "IMAGE" | "VIDEO" },
): Promise<MediaAssetRow> {
  const declaredType = options.file.type;
  if (!allowedMime(declaredType)) {
    throw new SocialServiceError(
      "VALIDATION",
      "Only PNG, JPEG, WebP images and MP4/MOV video are supported.",
      "file",
    );
  }

  const buffer = Buffer.from(await options.file.arrayBuffer());
  if (buffer.length === 0 || buffer.length > ITEM_IMAGE_MAX_BYTES) {
    throw new SocialServiceError(
      "VALIDATION",
      `File must be between 1 byte and ${Math.floor(ITEM_IMAGE_MAX_BYTES / (1024 * 1024))} MB.`,
      "file",
    );
  }

  // Fail-closed BEFORE anything is stored: no token ⇒ no upload ⇒ no row.
  const token = requireBlobToken();

  const ext = EXTENSION_BY_MIME[declaredType] ?? "bin";
  const fileName = `${randomBytes(16).toString("hex")}.${ext}`;
  const pathname = `tenants/${authz.tenantId}/media/${fileName}`;

  const blob = await put(pathname, buffer, {
    access: "public",
    contentType: declaredType,
    addRandomSuffix: true,
    token,
    ...(process.env.AMISIBIZ_STORE_ID
      ? { storeId: process.env.AMISIBIZ_STORE_ID }
      : {}),
  });

  const created = await prisma.mediaAsset.create({
    data: {
      tenantId: authz.tenantId,
      blobUrl: blob.url,
      alt: options.alt?.trim() || null,
      kind: kindForMime(declaredType, options.kind),
      bytes: buffer.length,
      uploadedById: actorId,
    },
  });

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.MEDIA_UPLOADED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "MediaAsset",
    resourceId: created.id,
    // Only non-secret facts: kind + byte size. Never the file or its URL.
    metadata: { kind: created.kind, bytes: created.bytes },
  });

  return created;
}

export async function deleteMediaAsset(
  authz: TenantAuthzContext,
  actorId: string,
  mediaAssetId: string,
): Promise<void> {
  const result = await prisma.mediaAsset.deleteMany({
    where: { id: mediaAssetId, tenantId: authz.tenantId },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Media asset not found.");
  }
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.MEDIA_DELETED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "MediaAsset",
    resourceId: mediaAssetId,
    metadata: {},
  });
}

export async function listMediaAssets(
  authz: TenantAuthzContext,
  query: { kind?: "IMAGE" | "VIDEO"; page: number; pageSize: number },
): Promise<{ assets: MediaAssetRow[]; total: number }> {
  const where: Prisma.MediaAssetWhereInput = {
    tenantId: authz.tenantId,
    ...(query.kind ? { kind: query.kind } : {}),
  };
  const [assets, total] = await Promise.all([
    prisma.mediaAsset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.mediaAsset.count({ where }),
  ]);
  return { assets, total };
}
