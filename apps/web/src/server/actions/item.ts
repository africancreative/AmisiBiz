"use server";

import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import type { CreateActionOptions } from "@/server/actions/_shared";
import {
  createTaxCategorySchema,
  updateTaxCategorySchema,
  taxCategoryLocatorSchema,
  taxCategoryQuerySchema,
  createItemSchema,
  updateItemSchema,
  itemLocatorSchema,
  itemQuerySchema,
} from "@/lib/validations/item";

const itemInclude = {
  taxRate: { include: { category: true } },
  contactItems: {
    include: {
      contact: {
        select: {
          id: true,
          type: true,
          firstName: true,
          lastName: true,
          companyName: true,
        },
      },
    },
    orderBy: { createdAt: "desc" as const },
  },
} satisfies Prisma.ItemInclude;

type ItemWithDetails = Prisma.ItemGetPayload<{ include: typeof itemInclude }>;

/** Explicit, field-by-field update mapping — never a computed key. */
function toItemUpdateData(data: {
  type?: "PRODUCT" | "SERVICE" | undefined;
  status?: "ACTIVE" | "INACTIVE" | undefined;
  name?: string | undefined;
  sku?: string | null | undefined;
  description?: string | null | undefined;
  unitOfMeasure?: string | undefined;
  unitPrice?: string | undefined;
  currency?: string | undefined;
  taxRateId?: string | null | undefined;
  notes?: string | null | undefined;
}): Prisma.ItemUpdateInput {
  const text = (value: string | null | undefined): string | null =>
    value?.trim() ? value.trim() : null;

  const update: Prisma.ItemUpdateInput = {};
  if (data.type !== undefined) update.type = data.type;
  if (data.status !== undefined) update.status = data.status;
  if (data.name !== undefined) update.name = data.name.trim();
  if (data.sku !== undefined) update.sku = text(data.sku);
  if (data.description !== undefined)
    update.description = text(data.description);
  if (data.unitOfMeasure !== undefined)
    update.unitOfMeasure = data.unitOfMeasure;
  // Decimal from a validated decimal STRING — never binary float arithmetic.
  if (data.unitPrice !== undefined)
    update.unitPrice = new Prisma.Decimal(data.unitPrice);
  if (data.currency !== undefined) update.currency = data.currency;
  // The relation form is used instead of the raw FK scalar: every caller has
  // already proven the rate belongs to the authorized tenant, so `connect`
  // cannot reach another business's tax configuration.
  if (data.taxRateId !== undefined) {
    update.taxRate = data.taxRateId
      ? { connect: { id: data.taxRateId } }
      : { disconnect: true };
  }
  if (data.notes !== undefined) update.notes = text(data.notes);
  return update;
}

export async function createTaxCategoryAction(
  rawInput: unknown,
): Promise<ActionResult<{ categoryId: string }>> {
  const session = await requireAuth();

  const parsed = createTaxCategorySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, rates, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_CREATE,
    );
  } catch (err) {
    return authorizationFailure(err, "createTaxCategoryAction");
  }

  const existing = await prisma.taxCategory.findFirst({
    where: { tenantId: context.tenantId, name: data.name },
    select: { id: true },
  });
  if (existing) {
    return {
      success: false,
      error: "A tax category with this name already exists.",
      code: "CONFLICT",
      fieldErrors: { name: ["Name already in use"] },
    };
  }

  try {
    const category = await prisma.$transaction(async (tx) => {
      const created = await tx.taxCategory.create({
        data: {
          tenantId: context.tenantId,
          name: data.name,
          description: data.description?.trim() || null,
          isDefault: data.isDefault,
        },
        select: { id: true, name: true },
      });

      if (data.isDefault) {
        await tx.taxCategory.updateMany({
          where: {
            tenantId: context.tenantId,
            id: { not: created.id },
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }

      await tx.taxRate.createMany({
        data: rates.map((rate) => ({
          tenantId: context.tenantId,
          categoryId: created.id,
          name: rate.name.trim(),
          rate: new Prisma.Decimal(rate.rate),
          effectiveFrom: rate.effectiveFrom
            ? new Date(rate.effectiveFrom)
            : new Date(),
          effectiveTo: rate.effectiveTo ? new Date(rate.effectiveTo) : null,
          isActive: rate.isActive,
        })),
      });

      return created;
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TAX_CATEGORY_CREATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "TaxCategory",
      resourceId: category.id,
      metadata: { name: category.name, rateCount: rates.length },
    });

    return { success: true, data: { categoryId: category.id } };
  } catch (err) {
    console.error("[createTaxCategoryAction]", err);
    return fail("Failed to create tax category.", { code: "INTERNAL" });
  }
}

export async function updateTaxCategoryAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateTaxCategorySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, categoryId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateTaxCategoryAction");
  }

  const existing = await prisma.taxCategory.findFirst({
    where: { id: categoryId, tenantId: context.tenantId },
    select: { id: true, name: true },
  });

  if (!existing) {
    return fail("Tax category not found.", { code: "NOT_FOUND" });
  }

  if (data.name && data.name !== existing.name) {
    const nameExists = await prisma.taxCategory.findFirst({
      where: {
        tenantId: context.tenantId,
        name: data.name,
        NOT: { id: categoryId },
      },
      select: { id: true },
    });
    if (nameExists) {
      return {
        success: false,
        error: "A tax category with this name already exists.",
        code: "CONFLICT",
        fieldErrors: { name: ["Name already in use"] },
      };
    }
  }

  const updateData: Prisma.TaxCategoryUpdateInput = {};
  if (data.name !== undefined) updateData.name = data.name.trim();
  if (data.description !== undefined) {
    updateData.description = data.description.trim() || null;
  }
  if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.taxCategory.updateMany({
        where: { id: categoryId, tenantId: context.tenantId },
        data: updateData,
      });
      if (result.count === 0) throw new Error("ROW_NOT_IN_TENANT");

      if (data.isDefault) {
        await tx.taxCategory.updateMany({
          where: {
            tenantId: context.tenantId,
            id: { not: categoryId },
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }
    });

    await recordAudit({
      action: AUDIT_ACTIONS.TAX_CATEGORY_UPDATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "TaxCategory",
      resourceId: categoryId,
      metadata: { fields: Object.keys(updateData) },
    });

    return { success: true };
  } catch (err) {
    if (err instanceof Error && err.message === "ROW_NOT_IN_TENANT") {
      return fail("Tax category not found.", { code: "NOT_FOUND" });
    }
    console.error("[updateTaxCategoryAction]", err);
    return fail("Failed to update tax category.", { code: "INTERNAL" });
  }
}

export async function getTaxCategoriesAction(rawInput: unknown): Promise<
  ActionResult<{
    categories: Prisma.TaxCategoryGetPayload<{ include: { rates: true } }>[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = taxCategoryQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, page, pageSize } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getTaxCategoriesAction");
  }

  try {
    const [categories, total] = await Promise.all([
      prisma.taxCategory.findMany({
        where: { tenantId: context.tenantId },
        include: {
          rates: {
            where: { isActive: true },
            orderBy: { effectiveFrom: "desc" },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.taxCategory.count({ where: { tenantId: context.tenantId } }),
    ]);

    return {
      success: true,
      data: {
        categories,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (err) {
    console.error("[getTaxCategoriesAction]", err);
    return fail("Failed to load tax categories.", { code: "INTERNAL" });
  }
}

export async function getTaxCategoryAction(
  categoryId: string,
  tenantId: string,
): Promise<
  ActionResult<{
    category: Prisma.TaxCategoryGetPayload<{ include: { rates: true } }> | null;
  }>
> {
  const session = await requireAuth();

  const parsed = taxCategoryLocatorSchema.safeParse({ categoryId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getTaxCategoryAction");
  }

  try {
    const category = await prisma.taxCategory.findFirst({
      where: { id: categoryId, tenantId: context.tenantId },
      include: { rates: { orderBy: { effectiveFrom: "desc" } } },
    });

    return { success: true, data: { category } };
  } catch (err) {
    console.error("[getTaxCategoryAction]", err);
    return fail("Failed to load tax category.", { code: "INTERNAL" });
  }
}

export async function createItemAction(
  rawInput: unknown,
  options?: CreateActionOptions,
): Promise<ActionResult<{ itemId: string }>> {
  const session = await requireAuth();

  const parsed = createItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_CREATE,
    );
  } catch (err) {
    return authorizationFailure(err, "createItemAction");
  }

  const sku = data.sku?.trim() || null;

  if (sku) {
    const existing = await prisma.item.findFirst({
      where: { tenantId: context.tenantId, sku },
      select: { id: true },
    });
    if (existing) {
      return {
        success: false,
        error: "An item with this SKU already exists.",
        code: "CONFLICT",
        fieldErrors: { sku: ["SKU already in use"] },
      };
    }
  }

  // A tax rate is only usable when it belongs to this tenant — never to the
  // rate of another business.
  if (data.taxRateId) {
    const taxRate = await prisma.taxRate.findFirst({
      where: { id: data.taxRateId, tenantId: context.tenantId },
      select: { id: true },
    });
    if (!taxRate) {
      return {
        success: false,
        error: "Invalid tax rate.",
        code: "VALIDATION_ERROR",
        fieldErrors: { taxRateId: ["Tax rate not found"] },
      };
    }
  }

  try {
    const item = await prisma.item.create({
      data: {
        // Client-supplied id from the offline sync service (`options.rowId`), so
        // the server keeps the id the device minted. Never from the payload.
        ...(options?.rowId !== undefined ? { id: options.rowId } : {}),
        tenantId: context.tenantId,
        type: data.type,
        status: data.status,
        name: data.name.trim(),
        sku,
        description: data.description?.trim() || null,
        unitOfMeasure: data.unitOfMeasure,
        unitPrice: new Prisma.Decimal(data.unitPrice),
        currency: data.currency,
        taxRateId: data.taxRateId || null,
        notes: data.notes?.trim() || null,
      },
      select: { id: true, name: true, type: true, sku: true },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.ITEM_CREATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Item",
      resourceId: item.id,
      metadata: { name: item.name, type: item.type, sku: item.sku },
    });

    return { success: true, data: { itemId: item.id } };
  } catch (err) {
    console.error("[createItemAction]", err);
    return fail("Failed to create item.", { code: "INTERNAL" });
  }
}

export async function updateItemAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { itemId, tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateItemAction");
  }

  const existingItem = await prisma.item.findFirst({
    where: { id: itemId, tenantId: context.tenantId },
    select: { id: true, sku: true },
  });

  if (!existingItem) {
    return fail("Item not found.", { code: "NOT_FOUND" });
  }

  const sku = data.sku !== undefined ? data.sku.trim() || null : undefined;

  if (sku && sku !== existingItem.sku) {
    const skuExists = await prisma.item.findFirst({
      where: { tenantId: context.tenantId, sku, NOT: { id: itemId } },
      select: { id: true },
    });
    if (skuExists) {
      return {
        success: false,
        error: "An item with this SKU already exists.",
        code: "CONFLICT",
        fieldErrors: { sku: ["SKU already in use"] },
      };
    }
  }

  if (data.taxRateId) {
    const taxRate = await prisma.taxRate.findFirst({
      where: { id: data.taxRateId, tenantId: context.tenantId },
      select: { id: true },
    });
    if (!taxRate) {
      return {
        success: false,
        error: "Invalid tax rate.",
        code: "VALIDATION_ERROR",
        fieldErrors: { taxRateId: ["Tax rate not found"] },
      };
    }
  }

  const updateData = toItemUpdateData({ ...data, sku });

  try {
    const result = await prisma.item.updateMany({
      where: { id: itemId, tenantId: context.tenantId },
      data: updateData,
    });

    if (result.count === 0) {
      return fail("Item not found.", { code: "NOT_FOUND" });
    }

    await recordAudit({
      action: AUDIT_ACTIONS.ITEM_UPDATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Item",
      resourceId: itemId,
      metadata: { fields: Object.keys(updateData) },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateItemAction]", err);
    return fail("Failed to update item.", { code: "INTERNAL" });
  }
}

/**
 * Items are removed only while nothing references them. Once an item has been
 * assigned to a customer catalogue it must be deactivated instead, so historical
 * priced lines can still be resolved.
 */
export async function deleteItemAction(
  itemId: string,
  tenantId: string,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = itemLocatorSchema.safeParse({ itemId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_DELETE,
    );
  } catch (err) {
    return authorizationFailure(err, "deleteItemAction");
  }

  const existingItem = await prisma.item.findFirst({
    where: { id: itemId, tenantId: context.tenantId },
    select: { id: true, name: true },
  });

  if (!existingItem) {
    return fail("Item not found.", { code: "NOT_FOUND" });
  }

  const referencedByContact = await prisma.contactItem.findFirst({
    where: { itemId, tenantId: context.tenantId },
    select: { id: true },
  });

  if (referencedByContact) {
    return fail(
      "Cannot delete item: it is assigned to customer-specific catalogues. Deactivate instead.",
      { code: "CONFLICT" },
    );
  }

  try {
    await prisma.item.delete({ where: { id: existingItem.id } });

    await recordAudit({
      action: AUDIT_ACTIONS.ITEM_DELETED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Item",
      resourceId: itemId,
    });

    return { success: true };
  } catch (err) {
    console.error("[deleteItemAction]", err);
    return fail("Failed to delete item.", { code: "INTERNAL" });
  }
}

export async function getItemsAction(rawInput: unknown): Promise<
  ActionResult<{
    items: Prisma.ItemGetPayload<{
      include: { taxRate: { include: { category: true } } };
    }>[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = itemQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, search, type, status, page, pageSize, sortBy, sortOrder } =
    parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getItemsAction");
  }

  const where: Prisma.ItemWhereInput = {
    tenantId: context.tenantId,
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { sku: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  try {
    const [items, total] = await Promise.all([
      prisma.item.findMany({
        where,
        include: { taxRate: { include: { category: true } } },
        // sortBy comes from the validated enum, never from free text.
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.item.count({ where }),
    ]);

    return {
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (err) {
    console.error("[getItemsAction]", err);
    return fail("Failed to load items.", { code: "INTERNAL" });
  }
}

export async function getItemAction(
  itemId: string,
  tenantId: string,
): Promise<ActionResult<{ item: ItemWithDetails | null }>> {
  const session = await requireAuth();

  const parsed = itemLocatorSchema.safeParse({ itemId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getItemAction");
  }

  try {
    const item = await prisma.item.findFirst({
      where: { id: itemId, tenantId: context.tenantId },
      include: itemInclude,
    });

    return { success: true, data: { item } };
  } catch (err) {
    console.error("[getItemAction]", err);
    return fail("Failed to load item.", { code: "INTERNAL" });
  }
}
