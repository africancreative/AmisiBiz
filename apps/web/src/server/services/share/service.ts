import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Share-link service (AGENT 02 modules C/E).
 *
 * Contract kept from the design spec (§1.7):
 *  - the token is generated SERVER-side only — `crypto.randomBytes` rendered
 *    in base62, at least 26 characters; no client ever sets it;
 *  - tenant, viewCount and active are never client input: the create data is
 *    assembled entirely from the authorization context and validated target
 *    ids;
 *  - `viewCount` is bumped only by the public resolver function
 *    (`app_public_share_link_resolve`), never here;
 *  - revocation flips `active = false` and KEEPS the row forever — the
 *    timeline and any historical attribution stay explainable;
 *  - a token collision on insert (P2002) is retried exactly once with a
 *    freshly generated token; a second collision is an honest INTERNAL.
 */

export type ShareFailureCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "INTERNAL";

export type ShareFailure = {
  ok: false;
  code: ShareFailureCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export type ShareResult<T> = { ok: true; data: T } | ShareFailure;

function failure(
  code: ShareFailureCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ShareFailure {
  return { ok: false, code, message, ...(fieldErrors ? { fieldErrors } : {}) };
}

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Minimum token length. The schema comment fixes 26 (base62 of 24 bytes
 *  never truncates below this in practice; the loop makes it guaranteed). */
export const SHARE_TOKEN_MIN_LENGTH = 26;

/**
 * 24 random bytes → one base62 string (typically 32 characters). Sampling
 * fresh bytes on the (astronomically unlikely) truncation keeps the ≥26
 * length a guarantee rather than a probability.
 */
export function generateShareToken(): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let value = BigInt(`0x${randomBytes(24).toString("hex")}`);
    let token = "";
    while (value > 0n) {
      token = BASE62_ALPHABET[Number(value % 62n)] + token;
      value /= 62n;
    }
    if (token.length >= SHARE_TOKEN_MIN_LENGTH) return token;
  }
  // Unreachable with any real CSPRNG; a deterministic refusal beats a short
  // token, so throw rather than return something below the contract length.
  throw new Error("Failed to generate a share token of adequate length.");
}

function isTokenCollision(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export interface CreatedShareLink {
  id: string;
  token: string;
  kind: string;
  itemId: string | null;
  documentId: string | null;
}

export async function createShareLink(
  authz: TenantAuthzContext,
  input: {
    kind: "PRODUCT" | "ORDER_STATUS";
    itemId?: string | null;
    documentId?: string | null;
    message?: string | null;
    expiresAt?: Date | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
  },
): Promise<ShareResult<CreatedShareLink>> {
  // Verify the target exists IN THIS TENANT before minting anything.
  if (input.kind === "PRODUCT") {
    if (!input.itemId) {
      return failure("VALIDATION_ERROR", "A PRODUCT link requires an item.", {
        itemId: ["Item not found"],
      });
    }
    const item = await prisma.item.findFirst({
      where: { id: input.itemId, tenantId: authz.tenantId },
      select: { id: true },
    });
    if (!item) {
      return failure("VALIDATION_ERROR", "Invalid item.", {
        itemId: ["Item not found"],
      });
    }
    // The migration's partial unique allows one ACTIVE PRODUCT link per item;
    // naming that here beats surfacing it as an opaque P2002 later. Revoking
    // first is the supported path to a fresh link (and a new token).
    const activeForItem = await prisma.shareLink.findFirst({
      where: {
        tenantId: authz.tenantId,
        kind: "PRODUCT",
        itemId: input.itemId,
        active: true,
      },
      select: { id: true },
    });
    if (activeForItem) {
      return failure(
        "CONFLICT",
        "An active share link already exists for this item. Revoke it first.",
      );
    }
  } else {
    if (!input.documentId) {
      return failure(
        "VALIDATION_ERROR",
        "An ORDER_STATUS link requires a document.",
        {
          documentId: ["Document not found"],
        },
      );
    }
    // Spec: ORDER_STATUS targets an ORDER document, and a DRAFT order is not
    // public information — the public function refuses drafts too, so a link
    // to one could never resolve. Refusing at creation keeps the manager
    // honest instead of minting a dead URL.
    const document = await prisma.document.findFirst({
      where: { id: input.documentId, tenantId: authz.tenantId },
      select: { id: true, type: true, status: true },
    });
    if (!document) {
      return failure("VALIDATION_ERROR", "Invalid document.", {
        documentId: ["Document not found"],
      });
    }
    if (document.type !== "ORDER") {
      return failure(
        "VALIDATION_ERROR",
        "An ORDER_STATUS link must target an ORDER document.",
        { documentId: ["Document is not an order"] },
      );
    }
    if (document.status === "DRAFT") {
      return failure(
        "VALIDATION_ERROR",
        "A draft order cannot be shared publicly. Issue it first.",
        { documentId: ["Order is still a draft"] },
      );
    }
    // Same partial-unique story as PRODUCT: one ACTIVE ORDER_STATUS link per
    // document; revoke first to rotate.
    const activeForDocument = await prisma.shareLink.findFirst({
      where: {
        tenantId: authz.tenantId,
        kind: "ORDER_STATUS",
        documentId: input.documentId,
        active: true,
      },
      select: { id: true },
    });
    if (activeForDocument) {
      return failure(
        "CONFLICT",
        "An active share link already exists for this order. Revoke it first.",
      );
    }
  }

  const baseData = {
    tenantId: authz.tenantId,
    kind: input.kind,
    itemId: input.kind === "PRODUCT" ? (input.itemId ?? null) : null,
    documentId:
      input.kind === "ORDER_STATUS" ? (input.documentId ?? null) : null,
    active: true,
    expiresAt: input.expiresAt ?? null,
    message: input.message?.trim() || null,
    utmSource: input.utmSource?.trim() || null,
    utmMedium: input.utmMedium?.trim() || null,
    utmCampaign: input.utmCampaign?.trim() || null,
  };

  const select = {
    id: true,
    token: true,
    kind: true,
    itemId: true,
    documentId: true,
  } satisfies Prisma.ShareLinkSelect;

  // One retry on a token collision (unique `token` column). Never a client-
  // supplied fallback, never a sequential id.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = generateShareToken();
    try {
      const created = await prisma.shareLink.create({
        data: { ...baseData, token },
        select,
      });
      return { ok: true, data: created };
    } catch (err) {
      if (isTokenCollision(err) && attempt === 0) continue;
      if (isTokenCollision(err)) {
        console.error("[share.createShareLink] repeated token collision", err);
        return failure("INTERNAL", "Failed to create share link.");
      }
      console.error("[share.createShareLink]", err);
      return failure("INTERNAL", "Failed to create share link.");
    }
  }
  return failure("INTERNAL", "Failed to create share link.");
}

/**
 * Revoke: flip `active` to false. The row is kept forever — history,
 * attribution and the unified timeline all reference it.
 */
export async function revokeShareLink(
  authz: TenantAuthzContext,
  shareLinkId: string,
): Promise<ShareResult<void>> {
  const existing = await prisma.shareLink.findFirst({
    where: { id: shareLinkId, tenantId: authz.tenantId },
    select: { id: true, active: true },
  });
  if (!existing) {
    return failure("NOT_FOUND", "Share link not found.");
  }
  if (!existing.active) {
    return failure("CONFLICT", "Share link is already revoked.");
  }

  try {
    await prisma.shareLink.updateMany({
      where: { id: existing.id, tenantId: authz.tenantId, active: true },
      data: { active: false },
    });
    return { ok: true, data: undefined };
  } catch (err) {
    console.error("[share.revokeShareLink]", err);
    return failure("INTERNAL", "Failed to revoke share link.");
  }
}

/** Update the expiry of an active link. `null` clears it (runs until revoked). */
export async function updateShareLinkExpiry(
  authz: TenantAuthzContext,
  shareLinkId: string,
  expiresAt: Date | null,
): Promise<ShareResult<void>> {
  try {
    const result = await prisma.shareLink.updateMany({
      where: { id: shareLinkId, tenantId: authz.tenantId, active: true },
      data: { expiresAt },
    });
    if (result.count === 0) {
      return failure("NOT_FOUND", "Active share link not found.");
    }
    return { ok: true, data: undefined };
  } catch (err) {
    console.error("[share.updateShareLinkExpiry]", err);
    return failure("INTERNAL", "Failed to update share link.");
  }
}

export type ShareLinkRow = Prisma.ShareLinkGetPayload<{
  select: typeof listSelect;
}>;

const listSelect = {
  id: true,
  kind: true,
  // The token is shown to the LINK'S OWNER here — this list is a staff
  // surface gated on SHARE_LINKS_READ; it never appears in any public payload.
  token: true,
  active: true,
  expiresAt: true,
  viewCount: true,
  message: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  createdAt: true,
  itemId: true,
  documentId: true,
  item: { select: { id: true, name: true, sku: true } },
  document: { select: { id: true, number: true, type: true, status: true } },
} satisfies Prisma.ShareLinkSelect;

export async function listShareLinks(
  authz: TenantAuthzContext,
  query: {
    kind?: "PRODUCT" | "LEAD_FORM" | "ORDER_STATUS" | undefined;
    itemId?: string | undefined;
    documentId?: string | undefined;
    page: number;
    pageSize: number;
  },
): Promise<
  ShareResult<{
    shareLinks: ShareLinkRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const where: Prisma.ShareLinkWhereInput = {
    tenantId: authz.tenantId,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.itemId ? { itemId: query.itemId } : {}),
    ...(query.documentId ? { documentId: query.documentId } : {}),
  };

  try {
    const [shareLinks, total] = await Promise.all([
      prisma.shareLink.findMany({
        where,
        select: listSelect,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.shareLink.count({ where }),
    ]);

    return {
      ok: true,
      data: {
        shareLinks,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    console.error("[share.listShareLinks]", err);
    return failure("INTERNAL", "Failed to load share links.");
  }
}
