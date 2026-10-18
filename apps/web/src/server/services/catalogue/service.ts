import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Catalogue service (AGENT 02 module C): categories, variants and the item
 * ARCHIVE/RESTORE transitions.
 *
 * Conventions kept from the existing action layer:
 *  - the tenant always comes from the authorization context, never a payload;
 *  - money goes to the database as `Prisma.Decimal` built from a validated
 *    DECIMAL STRING — no floating-point arithmetic on a price anywhere;
 *  - a variant stores its own price and currency; nothing is inherited from
 *    the item implicitly (design spec §4);
 *  - uniqueness conflicts (sku, category name) surface as field errors, via
 *    a pre-check AND a P2002 catch for the race between the two.
 *
 * Failures are returned, never thrown, so the action layer keeps its
 * "actions return ActionResult" contract.
 */

export type CatalogueFailureCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "INTERNAL";

export type CatalogueFailure = {
  ok: false;
  code: CatalogueFailureCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export type CatalogueResult<T> = { ok: true; data: T } | CatalogueFailure;

function failure(
  code: CatalogueFailureCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): CatalogueFailure {
  return { ok: false, code, message, ...(fieldErrors ? { fieldErrors } : {}) };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003"
  );
}

// ─── Categories ───────────────────────────────────────────────────────────────

export interface CategoryPage {
  categories: Prisma.CatalogueCategoryGetPayload<{
    select: {
      id: true;
      name: true;
      parentId: true;
      createdAt: true;
      _count: { select: { items: true } };
    };
  }>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const CATEGORY_SELECT = {
  id: true,
  name: true,
  parentId: true,
  createdAt: true,
  _count: { select: { items: true } },
} satisfies Prisma.CatalogueCategorySelect;

export async function listCategories(
  authz: TenantAuthzContext,
  query: { page: number; pageSize: number },
): Promise<CatalogueResult<CategoryPage>> {
  try {
    const [categories, total] = await Promise.all([
      prisma.catalogueCategory.findMany({
        where: { tenantId: authz.tenantId },
        select: CATEGORY_SELECT,
        orderBy: { name: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.catalogueCategory.count({ where: { tenantId: authz.tenantId } }),
    ]);

    return {
      ok: true,
      data: {
        categories,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    console.error("[catalogue.listCategories]", err);
    return failure("INTERNAL", "Failed to load categories.");
  }
}

/**
 * Get-or-create on the LOWER-NORMALIZED name: an existing category whose name
 * matches case-insensitively is returned instead of raising, so a retried or
 * differently-cased create lands on one row. The database unique is
 * `(tenantId, name)`; the case-insensitive guard exists so "Vet" and "vet"
 * never become two rows through two differently-cased calls.
 */
export async function createCategory(
  authz: TenantAuthzContext,
  input: { name: string; parentId?: string | null | undefined },
): Promise<
  CatalogueResult<{
    categoryId: string;
    name: string;
    /** False when an existing same-name category was returned instead. */
    created: boolean;
  }>
> {
  const name = input.name.trim();

  if (input.parentId) {
    const parent = await prisma.catalogueCategory.findFirst({
      where: { id: input.parentId, tenantId: authz.tenantId },
      select: { id: true },
    });
    if (!parent) {
      return failure("VALIDATION_ERROR", "Invalid parent category.", {
        parentId: ["Parent category not found"],
      });
    }
  }

  const existing = await prisma.catalogueCategory.findFirst({
    where: {
      tenantId: authz.tenantId,
      name: { equals: name, mode: "insensitive" },
    },
    select: { id: true, name: true },
  });
  if (existing) {
    return {
      ok: true,
      data: { categoryId: existing.id, name: existing.name, created: false },
    };
  }

  try {
    const created = await prisma.catalogueCategory.create({
      data: {
        tenantId: authz.tenantId,
        name,
        parentId: input.parentId ?? null,
      },
      select: { id: true, name: true },
    });
    return {
      ok: true,
      data: { categoryId: created.id, name: created.name, created: true },
    };
  } catch (err) {
    // Raced with a concurrent same-name create: adopt the winner's row.
    if (isUniqueViolation(err)) {
      const winner = await prisma.catalogueCategory.findFirst({
        where: {
          tenantId: authz.tenantId,
          name: { equals: name, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (winner) {
        return {
          ok: true,
          data: { categoryId: winner.id, name: winner.name, created: false },
        };
      }
    }
    console.error("[catalogue.createCategory]", err);
    return failure("INTERNAL", "Failed to create category.");
  }
}

export async function renameCategory(
  authz: TenantAuthzContext,
  input: {
    categoryId: string;
    name?: string | undefined;
    parentId?: string | null | undefined;
  },
): Promise<CatalogueResult<void>> {
  const existing = await prisma.catalogueCategory.findFirst({
    where: { id: input.categoryId, tenantId: authz.tenantId },
    select: { id: true, name: true },
  });
  if (!existing) {
    return failure("NOT_FOUND", "Category not found.");
  }

  const data: Prisma.CatalogueCategoryUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.toLowerCase() !== existing.name.toLowerCase()) {
      const dupe = await prisma.catalogueCategory.findFirst({
        where: {
          tenantId: authz.tenantId,
          name: { equals: name, mode: "insensitive" },
          NOT: { id: input.categoryId },
        },
        select: { id: true },
      });
      if (dupe) {
        return failure(
          "CONFLICT",
          "A category with this name already exists.",
          { name: ["Name already in use"] },
        );
      }
    }
    data.name = name;
  }
  if (input.parentId !== undefined) {
    if (input.parentId !== null) {
      if (input.parentId === input.categoryId) {
        return failure(
          "VALIDATION_ERROR",
          "A category cannot be its own parent.",
          {
            parentId: ["Invalid parent category"],
          },
        );
      }
      const parent = await prisma.catalogueCategory.findFirst({
        where: { id: input.parentId, tenantId: authz.tenantId },
        select: { id: true },
      });
      if (!parent) {
        return failure("VALIDATION_ERROR", "Invalid parent category.", {
          parentId: ["Parent category not found"],
        });
      }
    }
    data.parent =
      input.parentId === null
        ? { disconnect: true }
        : { connect: { id: input.parentId } };
  }

  if (Object.keys(data).length === 0) return { ok: true, data: undefined };

  try {
    const result = await prisma.catalogueCategory.updateMany({
      where: { id: input.categoryId, tenantId: authz.tenantId },
      data,
    });
    if (result.count === 0) return failure("NOT_FOUND", "Category not found.");
    return { ok: true, data: undefined };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return failure("CONFLICT", "A category with this name already exists.", {
        name: ["Name already in use"],
      });
    }
    console.error("[catalogue.renameCategory]", err);
    return failure("INTERNAL", "Failed to update category.");
  }
}

/**
 * Deleting a category refuses when items are attached. The `Item.categoryId`
 * FK is ON DELETE SET NULL, so a plain delete would silently detach every
 * product — a lie by omission. The refusal names the count so the operator
 * can move or archive the items first.
 */
export async function deleteCategory(
  authz: TenantAuthzContext,
  categoryId: string,
): Promise<CatalogueResult<void>> {
  const existing = await prisma.catalogueCategory.findFirst({
    where: { id: categoryId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!existing) {
    return failure("NOT_FOUND", "Category not found.");
  }

  const attachedItems = await prisma.item.count({
    where: { tenantId: authz.tenantId, categoryId },
  });
  if (attachedItems > 0) {
    return failure(
      "VALIDATION_ERROR",
      `Cannot delete category: ${attachedItems} item${attachedItems === 1 ? "" : "s"} still ${attachedItems === 1 ? "belongs" : "belong"} to it. Move or archive them first.`,
    );
  }

  try {
    await prisma.catalogueCategory.delete({ where: { id: existing.id } });
    return { ok: true, data: undefined };
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      // Raced attach between the count and the delete — refuse, do not unlink.
      return failure(
        "VALIDATION_ERROR",
        "Cannot delete category: items were just attached. Try again.",
      );
    }
    console.error("[catalogue.deleteCategory]", err);
    return failure("INTERNAL", "Failed to delete category.");
  }
}

// ─── Variants ─────────────────────────────────────────────────────────────────

export type VariantRow = Prisma.ProductVariantGetPayload<{
  include: { taxRate: { include: { category: true } } };
}>;

const variantInclude = {
  taxRate: { include: { category: true } },
} satisfies Prisma.ProductVariantInclude;

export async function listVariants(
  authz: TenantAuthzContext,
  query: {
    itemId?: string | undefined;
    page: number;
    pageSize: number;
  },
): Promise<
  CatalogueResult<{
    variants: VariantRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const where: Prisma.ProductVariantWhereInput = {
    tenantId: authz.tenantId,
    ...(query.itemId ? { itemId: query.itemId } : {}),
  };

  try {
    const [variants, total] = await Promise.all([
      prisma.productVariant.findMany({
        where,
        include: variantInclude,
        orderBy: [{ position: "asc" }, { name: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.productVariant.count({ where }),
    ]);

    return {
      ok: true,
      data: {
        variants,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    console.error("[catalogue.listVariants]", err);
    return failure("INTERNAL", "Failed to load variants.");
  }
}

async function validateVariantRefs(
  authz: TenantAuthzContext,
  input: {
    itemId?: string | undefined;
    taxRateId?: string | null | undefined;
  },
): Promise<CatalogueFailure | null> {
  if (input.itemId) {
    const item = await prisma.item.findFirst({
      where: { id: input.itemId, tenantId: authz.tenantId },
      select: { id: true },
    });
    if (!item) {
      return failure("VALIDATION_ERROR", "Invalid item.", {
        itemId: ["Item not found"],
      });
    }
  }
  if (input.taxRateId) {
    const taxRate = await prisma.taxRate.findFirst({
      where: { id: input.taxRateId, tenantId: authz.tenantId },
      select: { id: true },
    });
    if (!taxRate) {
      return failure("VALIDATION_ERROR", "Invalid tax rate.", {
        taxRateId: ["Tax rate not found"],
      });
    }
  }
  return null;
}

/**
 * Create a variant. The price and currency on the ROW are authoritative —
 * the item's own `unitPrice` is display default only and is never copied or
 * inherited here (design spec §4).
 */
export async function createVariant(
  authz: TenantAuthzContext,
  input: {
    itemId: string;
    name: string;
    sku?: string | null | undefined;
    unitPrice: string;
    currency: string;
    taxRateId?: string | null | undefined;
    status: "ACTIVE" | "INACTIVE";
    position: number;
  },
): Promise<CatalogueResult<{ variantId: string }>> {
  const invalid = await validateVariantRefs(authz, {
    itemId: input.itemId,
    taxRateId: input.taxRateId,
  });
  if (invalid) return invalid;

  const sku = input.sku?.trim() || null;

  if (sku) {
    const dupe = await prisma.productVariant.findFirst({
      where: { tenantId: authz.tenantId, sku },
      select: { id: true },
    });
    if (dupe) {
      return failure("CONFLICT", "A variant with this SKU already exists.", {
        sku: ["SKU already in use"],
      });
    }
  }

  try {
    const variant = await prisma.productVariant.create({
      data: {
        tenantId: authz.tenantId,
        itemId: input.itemId,
        name: input.name.trim(),
        sku,
        // Decimal built from the validated decimal STRING — never float math.
        unitPrice: new Prisma.Decimal(input.unitPrice),
        currency: input.currency,
        taxRateId: input.taxRateId || null,
        status: input.status,
        position: input.position,
      },
      select: { id: true },
    });
    return { ok: true, data: { variantId: variant.id } };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return failure("CONFLICT", "A variant with this SKU already exists.", {
        sku: ["SKU already in use"],
      });
    }
    console.error("[catalogue.createVariant]", err);
    return failure("INTERNAL", "Failed to create variant.");
  }
}

export async function updateVariant(
  authz: TenantAuthzContext,
  input: {
    variantId: string;
    itemId?: string | undefined;
    name?: string | undefined;
    sku?: string | null | undefined;
    unitPrice?: string | undefined;
    currency?: string | undefined;
    taxRateId?: string | null | undefined;
    status?: "ACTIVE" | "INACTIVE" | undefined;
    position?: number | undefined;
  },
): Promise<CatalogueResult<void>> {
  const existing = await prisma.productVariant.findFirst({
    where: { id: input.variantId, tenantId: authz.tenantId },
    select: { id: true, sku: true },
  });
  if (!existing) {
    return failure("NOT_FOUND", "Variant not found.");
  }

  const invalid = await validateVariantRefs(authz, {
    itemId: input.itemId,
    taxRateId: input.taxRateId,
  });
  if (invalid) return invalid;

  const sku = input.sku !== undefined ? input.sku?.trim() || null : undefined;
  if (sku && sku !== existing.sku) {
    const dupe = await prisma.productVariant.findFirst({
      where: { tenantId: authz.tenantId, sku, NOT: { id: input.variantId } },
      select: { id: true },
    });
    if (dupe) {
      return failure("CONFLICT", "A variant with this SKU already exists.", {
        sku: ["SKU already in use"],
      });
    }
  }

  const data: Prisma.ProductVariantUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (sku !== undefined) data.sku = sku;
  if (input.unitPrice !== undefined) {
    data.unitPrice = new Prisma.Decimal(input.unitPrice);
  }
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.status !== undefined) data.status = input.status;
  if (input.position !== undefined) data.position = input.position;
  if (input.itemId !== undefined) data.item = { connect: { id: input.itemId } };
  if (input.taxRateId !== undefined) {
    data.taxRate = input.taxRateId
      ? { connect: { id: input.taxRateId } }
      : { disconnect: true };
  }

  try {
    const result = await prisma.productVariant.updateMany({
      where: { id: input.variantId, tenantId: authz.tenantId },
      data,
    });
    if (result.count === 0) return failure("NOT_FOUND", "Variant not found.");
    return { ok: true, data: undefined };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return failure("CONFLICT", "A variant with this SKU already exists.", {
        sku: ["SKU already in use"],
      });
    }
    console.error("[catalogue.updateVariant]", err);
    return failure("INTERNAL", "Failed to update variant.");
  }
}

/**
 * Delete a variant. `DocumentLine.variantId` is ON DELETE RESTRICT, so a
 * variant already snapshotted into a document line cannot be removed; the P2003
 * becomes an honest CONFLICT rather than a silent failure.
 */
export async function deleteVariant(
  authz: TenantAuthzContext,
  variantId: string,
): Promise<CatalogueResult<void>> {
  const existing = await prisma.productVariant.findFirst({
    where: { id: variantId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!existing) {
    return failure("NOT_FOUND", "Variant not found.");
  }

  try {
    await prisma.productVariant.delete({ where: { id: existing.id } });
    return { ok: true, data: undefined };
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return failure(
        "CONFLICT",
        "Cannot delete variant: it is referenced by document lines. Set it INACTIVE instead.",
      );
    }
    console.error("[catalogue.deleteVariant]", err);
    return failure("INTERNAL", "Failed to delete variant.");
  }
}

// ─── Item archive / restore ───────────────────────────────────────────────────

/**
 * Archive an item: `ACTIVE → ARCHIVED` ONLY.
 *
 * `INACTIVE` is a temporary commercial pause and is never silently upgraded to
 * an archive; `ARCHIVED` twice is a no-op refusal. There is no `archivedAt`
 * column on Item — the status value itself is the mechanism (documented
 * deviation, see `lib/validations/catalogue.ts`). Documents already snapshot
 * their lines, so open DRAFT documents do NOT block archiving; the catalogue
 * row simply stops being selectable for new lines.
 */
export async function archiveItem(
  authz: TenantAuthzContext,
  itemId: string,
): Promise<CatalogueResult<{ name: string }>> {
  const item = await prisma.item.findFirst({
    where: { id: itemId, tenantId: authz.tenantId },
    select: { id: true, name: true, status: true },
  });
  if (!item) {
    return failure("NOT_FOUND", "Item not found.");
  }
  if (item.status === "ARCHIVED") {
    return failure("CONFLICT", "Item is already archived.");
  }
  if (item.status !== "ACTIVE") {
    return failure(
      "VALIDATION_ERROR",
      "Only ACTIVE items can be archived; reactivate this item first.",
    );
  }

  try {
    await prisma.item.update({
      where: { id: item.id },
      data: { status: "ARCHIVED" },
      select: { name: true },
    });
    return { ok: true, data: { name: item.name } };
  } catch (err) {
    console.error("[catalogue.archiveItem]", err);
    return failure("INTERNAL", "Failed to archive item.");
  }
}

/** Restore an archived item: `ARCHIVED → ACTIVE`. */
export async function restoreItem(
  authz: TenantAuthzContext,
  itemId: string,
): Promise<CatalogueResult<{ name: string }>> {
  const item = await prisma.item.findFirst({
    where: { id: itemId, tenantId: authz.tenantId },
    select: { id: true, name: true, status: true },
  });
  if (!item) {
    return failure("NOT_FOUND", "Item not found.");
  }
  if (item.status !== "ARCHIVED") {
    return failure("VALIDATION_ERROR", "Only archived items can be restored.");
  }

  try {
    await prisma.item.update({
      where: { id: item.id },
      data: { status: "ACTIVE" },
      select: { name: true },
    });
    return { ok: true, data: { name: item.name } };
  } catch (err) {
    console.error("[catalogue.restoreItem]", err);
    return failure("INTERNAL", "Failed to restore item.");
  }
}
