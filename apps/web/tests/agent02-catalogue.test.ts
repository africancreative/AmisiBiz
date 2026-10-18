import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import type { TenantRole } from "@prisma/client";

/**
 * AGENT 02 Phase 2C — catalogue service + item actions (module C).
 *
 * Covers the required matrix for this slice:
 *  1. forged `tenantId` / ids are refused before any write, and unknown extra
 *     keys (`id`, `token`, `viewCount`, ...) are stripped by the Zod layer —
 *     the create data the Prisma call receives carries ONLY server-trusted
 *     fields, with the tenant from the authorization context;
 *  2. variant prices travel as decimal STRINGS (asserted against the exact
 *     string the `Prisma.Decimal` was built from — no JS float math);
 *  3. a SKU collision (pre-check and P2002 race) becomes a field error;
 *  4. item archive transitions: ARCHIVED only from ACTIVE, restore only from
 *     ARCHIVED, INACTIVE untouched by the archive verb;
 *  5. image upload is fail-closed: with no `BLOB_READ_WRITE_TOKEN` the seam
 *     error surfaces and NO `ItemImage` row is written, never a fake URL;
 *  6. category delete refuses with the attached-item count, and category
 *     create is get-or-create against the case-insensitive name.
 *
 * DB-level integration (RLS round-trips, real blob PUTs) stays with the
 * Phase 4 harness; these are the unit proofs of the action/service contract.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async () => ({ url: "https://blob.test/item-1.png" })),
}));

import { prismaMock } from "./prisma-mock";
import { authMock } from "./auth-mock";
import {
  callArg,
  delegateFor,
  ensureAgent02Delegates,
  type Delegate,
} from "./agent02-local-mock";
import { put } from "@vercel/blob";
import {
  createCategoryAction,
  deleteCategoryAction,
  createVariantAction,
  updateVariantAction,
  deleteVariantAction,
  archiveItemAction,
  restoreItemAction,
  uploadItemImageAction,
  deleteItemImageAction,
  getItemsAction,
} from "@/server/actions/item";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "55555555-5555-4555-8555-555555550001";
const CATEGORY_ID = "66666666-6666-4666-8666-666666660001";
const VARIANT_ID = "77777777-7777-4777-8777-777777770001";
const IMAGE_ID = "88888888-8888-4888-8888-888888880001";

const categoryMock = (): Delegate => delegateFor("catalogueCategory");
const variantMock = (): Delegate => delegateFor("productVariant");
const imageMock = (): Delegate => delegateFor("itemImage");
const activityMock = (): Delegate => delegateFor("activityEvent");

type Loose = {
  success: boolean;
  data?: Record<string, unknown>;
  code?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};
function loose(result: unknown): Loose {
  return result as Loose;
}

/** Membership is keyed by (tenantId, userId): only `memberOf` resolves. */
function asRole(role: TenantRole, memberOf: string = TENANT_ID): void {
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
      return { role, tenant: { status: "ACTIVE" } };
    },
  );
}

function prismaError(code: string): unknown {
  return new Prisma.PrismaClientKnownRequestError(code, {
    code,
    clientVersion: "6.19.3",
  });
}

/** A minimal 1x1 PNG header — enough for the magic-bytes classifier. */
function pngFile(): File {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  return new File([bytes], "photo.png", { type: "image/png" });
}

beforeEach(() => {
  ensureAgent02Delegates();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  authMock.mockResolvedValue({
    id: USER_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: null,
    status: "ACTIVE",
  });
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
  prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
  asRole("TENANT_OWNER");

  // Item lookups default to "exists in this tenant"; individual cases override
  // when the distinction matters.
  prismaMock.item.findFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: Record<string, unknown> }).where ?? {};
    if (where.tenantId !== TENANT_ID) return null;
    return { id: ITEM_ID, name: "Widget", sku: "WDG-1", status: "ACTIVE" };
  });
  prismaMock.item.update.mockResolvedValue({ name: "Widget" });
  prismaMock.item.count.mockResolvedValue(0);
  prismaMock.item.findMany.mockResolvedValue([]);
  categoryMock().findFirst.mockResolvedValue(null);
  categoryMock().create.mockResolvedValue({
    id: CATEGORY_ID,
    name: "Widgets",
  });
  categoryMock().updateMany.mockResolvedValue({ count: 1 });
  categoryMock().delete.mockResolvedValue({ id: CATEGORY_ID });
  categoryMock().findMany.mockResolvedValue([]);
  categoryMock().count.mockResolvedValue(0);
  variantMock().findFirst.mockResolvedValue(null);
  variantMock().create.mockResolvedValue({ id: VARIANT_ID });
  variantMock().updateMany.mockResolvedValue({ count: 1 });
  variantMock().delete.mockResolvedValue({ id: VARIANT_ID });
  variantMock().findMany.mockResolvedValue([]);
  variantMock().count.mockResolvedValue(0);
  imageMock().findFirst.mockResolvedValue(null);
  imageMock().create.mockResolvedValue({
    id: IMAGE_ID,
    itemId: ITEM_ID,
    position: 1,
    blobUrl: "https://blob.test/item-1.png",
    alt: null,
  });
  imageMock().deleteMany.mockResolvedValue({ count: 1 });
  activityMock().create.mockResolvedValue({ id: "evt-1" });
  prismaMock.taxRate.findFirst.mockResolvedValue({ id: "tr-1" });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.AMISIBIZ_STORE_ID;
});

// ─── Forged inputs ────────────────────────────────────────────────────────────

describe("forged tenant and unknown keys never reach the row", () => {
  it("refuses a write aimed at a tenant the caller is not a member of", async () => {
    asRole("TENANT_OWNER", OTHER_TENANT_ID);

    const result = loose(
      await createVariantAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        name: "Large",
        unitPrice: "10.00",
        currency: "KES",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(variantMock().create).not.toHaveBeenCalled();
  });

  it("strips client-forged id/token/viewCount/status keys from a create payload", async () => {
    const result = loose(
      await createVariantAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        name: "Large",
        unitPrice: "10.00",
        currency: "KES",
        // The forged extras — none may survive into the row:
        id: VARIANT_ID,
        variantId: VARIANT_ID,
        token: "hackme",
        viewCount: 999,
        revision: 42,
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(variantMock().create).data as Record<string, unknown>;
    expect(data.id).toBeUndefined();
    expect(data.token).toBeUndefined();
    expect(data.viewCount).toBeUndefined();
    expect(data.revision).toBeUndefined();
    // `status` was never sent: the enum default, not an inherited value.
    expect(data.status).toBe("ACTIVE");
    // The tenant is the AUTHORIZED one, never the payload's.
    expect(data.tenantId).toBe(TENANT_ID);
  });

  it("a forged closed-vocabulary value (status: WEIRD) is refused, not stripped silently", async () => {
    const result = loose(
      await createVariantAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        name: "Large",
        unitPrice: "10.00",
        currency: "KES",
        status: "WEIRD",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(variantMock().create).not.toHaveBeenCalled();
  });

  it("category create ignores a forged tenant override and writes the context tenant", async () => {
    const result = loose(
      await createCategoryAction({
        tenantId: TENANT_ID,
        name: "Widgets",
        id: CATEGORY_ID,
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(categoryMock().create).data as Record<string, unknown>;
    expect(data.tenantId).toBe(TENANT_ID);
    expect(data.id).toBeUndefined();
  });
});

// ─── Variant pricing: decimal strings, never floats ──────────────────────────

describe("variant price decimal handling", () => {
  it("builds the Decimal from the exact validated string with no float math", async () => {
    const result = loose(
      await createVariantAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        name: "500g",
        sku: "V-500",
        unitPrice: "19.9999",
        currency: "kes",
        position: 3,
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(variantMock().create).data as Record<string, unknown>;
    expect(data.unitPrice).toBeInstanceOf(Prisma.Decimal);
    // The stored decimal string round-trips the input EXACTLY.
    expect((data.unitPrice as Prisma.Decimal).toString()).toBe("19.9999");
    // Currency was upper-cased from the explicit ISO-3 input, not defaulted.
    expect(data.currency).toBe("KES");
    expect(data.position).toBe(3);
  });

  it("rejects more than 4 decimal places and negatives at the schema", async () => {
    expect(
      loose(
        await createVariantAction({
          tenantId: TENANT_ID,
          itemId: ITEM_ID,
          name: "x",
          unitPrice: "1.23456",
          currency: "KES",
        }),
      ).code,
    ).toBe("VALIDATION_ERROR");

    expect(
      loose(
        await createVariantAction({
          tenantId: TENANT_ID,
          itemId: ITEM_ID,
          name: "x",
          unitPrice: "-1.00",
          currency: "KES",
        }),
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect(variantMock().create).not.toHaveBeenCalled();
  });

  it("update also routes the price through the string Decimal path", async () => {
    variantMock().findFirst.mockResolvedValue({ id: VARIANT_ID, sku: null });
    const result = loose(
      await updateVariantAction({
        tenantId: TENANT_ID,
        variantId: VARIANT_ID,
        unitPrice: "0.0001",
      }),
    );
    expect(result.success).toBe(true);
    const data = callArg(variantMock().updateMany).data as Record<
      string,
      unknown
    >;
    expect((data.unitPrice as Prisma.Decimal).toString()).toBe("0.0001");
  });
});

// ─── SKU uniqueness ───────────────────────────────────────────────────────────

describe("variant SKU collision becomes a field error", () => {
  it("pre-check: existing same-tenant SKU refuses with fieldErrors.sku", async () => {
    variantMock().findFirst.mockResolvedValue({ id: "other-variant" });

    const result = loose(
      await createVariantAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        name: "Large",
        sku: "V-DUP",
        unitPrice: "10.00",
        currency: "KES",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(result.fieldErrors?.sku).toEqual(["SKU already in use"]);
    expect(variantMock().create).not.toHaveBeenCalled();
  });

  it("race: P2002 from the create still lands as fieldErrors.sku", async () => {
    variantMock().create.mockRejectedValue(prismaError("P2002"));

    const result = loose(
      await createVariantAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        name: "Large",
        sku: "V-RACE",
        unitPrice: "10.00",
        currency: "KES",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(result.fieldErrors?.sku).toEqual(["SKU already in use"]);
  });

  it("a variant referenced by document lines (P2003) refuses as CONFLICT", async () => {
    variantMock().findFirst.mockResolvedValue({ id: VARIANT_ID, sku: null });
    variantMock().delete.mockRejectedValue(prismaError("P2003"));

    const result = loose(
      await deleteVariantAction({ tenantId: TENANT_ID, variantId: VARIANT_ID }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
  });
});

// ─── Archive transitions ──────────────────────────────────────────────────────

describe("item archive / restore transitions", () => {
  function itemWithStatus(status: string): void {
    prismaMock.item.findFirst.mockResolvedValue({
      id: ITEM_ID,
      name: "Widget",
      sku: null,
      status,
    });
  }

  it("archives only from ACTIVE and appends ITEM_ARCHIVED", async () => {
    itemWithStatus("ACTIVE");
    const result = loose(
      await archiveItemAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        reason: "discontinued",
      }),
    );

    expect(result.success).toBe(true);
    expect(callArg(prismaMock.item.update).data).toEqual({
      status: "ARCHIVED",
    });
    const events = activityMock().create.mock.calls.map(
      (call) => (call[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("ITEM_ARCHIVED");
  });

  it("refuses to archive an INACTIVE item (the verb is ARCHIVED-from-ACTIVE)", async () => {
    itemWithStatus("INACTIVE");
    const result = loose(
      await archiveItemAction({ tenantId: TENANT_ID, itemId: ITEM_ID }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.item.update).not.toHaveBeenCalled();
  });

  it("archiving twice is a CONFLICT, not a rewrite", async () => {
    itemWithStatus("ARCHIVED");
    const result = loose(
      await archiveItemAction({ tenantId: TENANT_ID, itemId: ITEM_ID }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(prismaMock.item.update).not.toHaveBeenCalled();
  });

  it("restores only from ARCHIVED back to ACTIVE", async () => {
    itemWithStatus("ARCHIVED");
    const ok = loose(
      await restoreItemAction({ tenantId: TENANT_ID, itemId: ITEM_ID }),
    );
    expect(ok.success).toBe(true);
    expect(callArg(prismaMock.item.update).data).toEqual({ status: "ACTIVE" });

    itemWithStatus("ACTIVE");
    const again = loose(
      await restoreItemAction({ tenantId: TENANT_ID, itemId: ITEM_ID }),
    );
    expect(again.success).toBe(false);
    expect(again.code).toBe("VALIDATION_ERROR");
  });

  it("a forged item id from another tenant finds no row and fails NOT_FOUND", async () => {
    const FORGED_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    prismaMock.item.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: Record<string, unknown> }).where ?? {};
      // Tenant-scoped lookups only: the row "exists" for no other tenant.
      if (where.tenantId !== TENANT_ID) return null;
      if (where.id === FORGED_ID) return null;
      return { id: ITEM_ID, name: "Widget", sku: null, status: "ACTIVE" };
    });

    const result = loose(
      await archiveItemAction({ tenantId: TENANT_ID, itemId: FORGED_ID }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
  });
});

// ─── Images: fail-closed blob seam ───────────────────────────────────────────

describe("item image upload fail-closed", () => {
  it("without BLOB_READ_WRITE_TOKEN: descriptive error, NO ItemImage row", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;

    const result = loose(
      await uploadItemImageAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        file: pngFile(),
        alt: "Front view",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("BLOB_READ_WRITE_TOKEN");
    // The whole point: no row, no fake URL, no silent local write.
    expect(imageMock().create).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("with the token: blob URL from the seam only, position next after max", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    imageMock().findFirst.mockResolvedValue({ position: 2 });

    const result = loose(
      await uploadItemImageAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        file: pngFile(),
        alt: "Front view",
      }),
    );

    expect(result.success).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    const putOptions = (put as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[2] as Record<string, unknown>;
    expect(putOptions.access).toBe("public");
    expect(putOptions.addRandomSuffix).toBe(true);
    expect(putOptions.token).toBe("blob-test-token");
    expect(putOptions.contentType).toBe("image/png");

    const data = callArg(imageMock().create).data as Record<string, unknown>;
    expect(data.tenantId).toBe(TENANT_ID);
    expect(data.itemId).toBe(ITEM_ID);
    expect(data.position).toBe(3); // max 2 + 1
    expect(data.blobUrl).toBe("https://blob.test/item-1.png");
    expect(data.alt).toBe("Front view");
  });

  it("rejects a disallowed content type before touching storage", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const svg = new File([Buffer.from("<svg/>")], "x.svg", {
      type: "image/svg+xml",
    });

    const result = loose(
      await uploadItemImageAction({
        tenantId: TENANT_ID,
        itemId: ITEM_ID,
        file: svg,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(put).not.toHaveBeenCalled();
    expect(imageMock().create).not.toHaveBeenCalled();
  });

  it("delete is tenant-scoped and reports a missing row as NOT_FOUND", async () => {
    imageMock().deleteMany.mockResolvedValue({ count: 0 });
    const result = loose(
      await deleteItemImageAction({ tenantId: TENANT_ID, imageId: IMAGE_ID }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(callArg(imageMock().deleteMany).where).toMatchObject({
      tenantId: TENANT_ID,
    });
  });
});

// ─── Categories: get-or-create + refusal on attached items ────────────────────

describe("category rules", () => {
  it("get-or-create compares case-insensitively and does not create twice", async () => {
    categoryMock().findFirst.mockResolvedValue({
      id: CATEGORY_ID,
      name: "widgets",
    });

    const result = loose(
      await createCategoryAction({ tenantId: TENANT_ID, name: "Widgets" }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.created).toBe(false);
    expect(result.data?.categoryId).toBe(CATEGORY_ID);
    expect(categoryMock().create).not.toHaveBeenCalled();
  });

  it("delete refuses while items are attached and names the count", async () => {
    categoryMock().findFirst.mockResolvedValue({ id: CATEGORY_ID });
    prismaMock.item.count.mockResolvedValue(3);

    const result = loose(
      await deleteCategoryAction({
        tenantId: TENANT_ID,
        categoryId: CATEGORY_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.error).toContain("3");
    expect(categoryMock().delete).not.toHaveBeenCalled();
    expect(categoryMock().deleteMany).not.toHaveBeenCalled();
  });

  it("a P2002 racing the create adopts the winner's row instead of failing", async () => {
    categoryMock().create.mockRejectedValueOnce(prismaError("P2002"));
    categoryMock()
      .findFirst.mockResolvedValueOnce(null) // pre-check: none yet
      .mockResolvedValueOnce({ id: CATEGORY_ID, name: "Widgets" }); // race read

    const result = loose(
      await createCategoryAction({ tenantId: TENANT_ID, name: "Widgets" }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.created).toBe(false);
  });
});

// ─── getItemsAction archived handling ────────────────────────────────────────

describe("items list archived visibility", () => {
  it("excludes ARCHIVED by default", async () => {
    const result = loose(await getItemsAction({ tenantId: TENANT_ID }));
    expect(result.success).toBe(true);
    expect(callArg(prismaMock.item.findMany).where).toMatchObject({
      tenantId: TENANT_ID,
      status: { not: "ARCHIVED" },
    });
  });

  it("includeArchived lifts the exclusion; categoryId filters", async () => {
    const result = loose(
      await getItemsAction({
        tenantId: TENANT_ID,
        includeArchived: true,
        categoryId: CATEGORY_ID,
      }),
    );
    expect(result.success).toBe(true);
    const where = callArg(prismaMock.item.findMany).where as Record<
      string,
      unknown
    >;
    expect(where.status).toBeUndefined();
    expect(where.categoryId).toBe(CATEGORY_ID);
  });
});
