"use server";

import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  createTaxCategorySchema,
  updateTaxCategorySchema,
  taxCategoryQuerySchema,
  createItemSchema,
  updateItemSchema,
  itemQuerySchema,
  type CreateTaxCategoryInput,
  type UpdateTaxCategoryInput,
  type CreateItemInput,
  type UpdateItemInput,
  type TaxCategoryQueryInput,
  type ItemQueryInput,
} from "@/lib/validations/item";
import type { Prisma } from "@prisma/client";
import type { ActionResult } from "@/lib/errors";

type ItemWithDetails = Prisma.ItemGetPayload<{
  include: { taxRate: { include: { category: true } }; contactItems: { include: { contact: true } } };
}>;

function authzError<T = void>(error: unknown): ActionResult<T> {
  if (error instanceof Error && /not permitted|access/i.test(error.message)) {
    return { success: false, error: error.message };
  }
  return {
    success: false,
    error: "You are not permitted to perform this action.",
  };
}

export async function createTaxCategoryAction(
  rawInput: unknown,
): Promise<ActionResult<{ categoryId: string }>> {
  const session = await requireAuth();

  const result = createTaxCategorySchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, rates, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_CREATE,
    );
  } catch (err) {
    return authzError<{ categoryId: string }>(err);
  }

  const existing = await prisma.taxCategory.findFirst({
    where: { tenantId, name: data.name },
    select: { id: true },
  });
  if (existing) {
    return {
      success: false,
      error: "A tax category with this name already exists.",
      fieldErrors: { name: ["Name already in use"] },
    };
  }

  try {
    const category = await prisma.$transaction(async (tx) => {
      const created = await tx.taxCategory.create({
        data: {
          tenantId,
          name: data.name,
          description: data.description?.trim() || null,
          isDefault: data.isDefault,
        },
      });

      if (data.isDefault) {
        await tx.taxCategory.updateMany({
          where: { tenantId, id: { not: created.id }, isDefault: true },
          data: { isDefault: false },
        });
      }

      await tx.taxRate.createMany({
        data: rates.map((rate) => ({
          tenantId,
          categoryId: created.id,
          name: rate.name,
          rate: new Prisma.Decimal(rate.rate),
          effectiveFrom: rate.effectiveFrom ? new Date(rate.effectiveFrom) : new Date(),
          effectiveTo: rate.effectiveTo ? new Date(rate.effectiveTo) : null,
          isActive: rate.isActive,
        })),
      });

      return created;
    });

    await recordAudit({
      action: "taxCategory.created",
      userId: session.user.id,
      tenantId,
      resource: "TaxCategory",
      resourceId: category.id,
      metadata: { name: category.name, rateCount: rates.length },
    });

    return { success: true, data: { categoryId: category.id } };
  } catch (err) {
    console.error("[createTaxCategoryAction]", err);
    return { success: false, error: "Failed to create tax category." };
  }
}

export async function updateTaxCategoryAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = updateTaxCategorySchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, categoryId, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existing = await prisma.taxCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, tenantId: true, name: true },
  });

  if (!existing || existing.tenantId !== tenantId) {
    return { success: false, error: "Tax category not found." };
  }

  if (data.name && data.name !== existing.name) {
    const nameExists = await prisma.taxCategory.findFirst({
      where: { tenantId, name: data.name, NOT: { id: categoryId } },
      select: { id: true },
    });
    if (nameExists) {
      return {
        success: false,
        error: "A tax category with this name already exists.",
        fieldErrors: { name: ["Name already in use"] },
      };
    }
  }

  const updateData: Prisma.TaxCategoryUpdateInput = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      if (typeof value === "string") {
        updateData[key] = value.trim() || null;
      } else {
        updateData[key] = value;
      }
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.taxCategory.update({
        where: { id: categoryId },
        data: updateData,
      });

      if (data.isDefault) {
        await tx.taxCategory.updateMany({
          where: { tenantId, id: { not: categoryId }, isDefault: true },
          data: { isDefault: false },
        });
      }
    });

    await recordAudit({
      action: "taxCategory.updated",
      userId: session.user.id,
      tenantId,
      resource: "TaxCategory",
      resourceId: categoryId,
      metadata: { fields: Object.keys(updateData) },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateTaxCategoryAction]", err);
    return { success: false, error: "Failed to update tax category." };
  }
}

export async function getTaxCategoriesAction(
  rawInput: unknown,
): Promise<ActionResult<{
  categories: Prisma.TaxCategoryGetPayload<{ include: { rates: true } }>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}>> {
  const session = await requireAuth();

  const result = taxCategoryQuerySchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid query parameters.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, page, pageSize } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  try {
    const [categories, total] = await Promise.all([
      prisma.taxCategory.findMany({
        where: { tenantId },
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
      prisma.taxCategory.count({ where: { tenantId } }),
    ]);

    return {
      success: true,
      data: {
        categories,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  } catch (err) {
    console.error("[getTaxCategoriesAction]", err);
    return { success: false, error: "Failed to load tax categories." };
  }
}

export async function getTaxCategoryAction(
  categoryId: string,
  tenantId: string,
): Promise<ActionResult<{ category: Prisma.TaxCategoryGetPayload<{ include: { rates: true } }> | null }>> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  try {
    const category = await prisma.taxCategory.findFirst({
      where: { id: categoryId, tenantId },
      include: { rates: { orderBy: { effectiveFrom: "desc" } } },
    });

    return { success: true, data: { category } };
  } catch (err) {
    console.error("[getTaxCategoryAction]", err);
    return { success: false, error: "Failed to load tax category." };
  }
}

export async function createItemAction(
  rawInput: unknown,
): Promise<ActionResult<{ itemId: string }>> {
  const session = await requireAuth();

  const result = createItemSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_CREATE,
    );
  } catch (err) {
    return authzError<{ itemId: string }>(err);
  }

  if (data.sku) {
    const existing = await prisma.item.findFirst({
      where: { tenantId, sku: data.sku },
      select: { id: true },
    });
    if (existing) {
      return {
        success: false,
        error: "An item with this SKU already exists.",
        fieldErrors: { sku: ["SKU already in use"] },
      };
    }
  }

  if (data.taxRateId) {
    const taxRate = await prisma.taxRate.findFirst({
      where: { id: data.taxRateId, tenantId },
      select: { id: true },
    });
    if (!taxRate) {
      return {
        success: false,
        error: "Invalid tax rate.",
        fieldErrors: { taxRateId: ["Tax rate not found"] },
      };
    }
  }

  try {
    const item = await prisma.item.create({
      data: {
        tenantId,
        type: data.type,
        status: data.status,
        name: data.name.trim(),
        sku: data.sku?.trim() || null,
        description: data.description?.trim() || null,
        unitOfMeasure: data.unitOfMeasure,
        unitPrice: new Prisma.Decimal(data.unitPrice),
        currency: data.currency,
        taxRateId: data.taxRateId || null,
        notes: data.notes?.trim() || null,
      },
    });

    await recordAudit({
      action: "item.created",
      userId: session.user.id,
      tenantId,
      resource: "Item",
      resourceId: item.id,
      metadata: { name: item.name, type: item.type, sku: item.sku },
    });

    return { success: true, data: { itemId: item.id } };
  } catch (err) {
    console.error("[createItemAction]", err);
    return { success: false, error: "Failed to create item." };
  }
}

export async function updateItemAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = updateItemSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { itemId, tenantId, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existingItem = await prisma.item.findUnique({
    where: { id: itemId },
    select: { id: true, tenantId: true, sku: true },
  });

  if (!existingItem || existingItem.tenantId !== tenantId) {
    return { success: false, error: "Item not found." };
  }

  if (data.sku && data.sku !== existingItem.sku) {
    const skuExists = await prisma.item.findFirst({
      where: { tenantId, sku: data.sku, NOT: { id: itemId } },
      select: { id: true },
    });
    if (skuExists) {
      return {
        success: false,
        error: "An item with this SKU already exists.",
        fieldErrors: { sku: ["SKU already in use"] },
      };
    }
  }

  if (data.taxRateId) {
    const taxRate = await prisma.taxRate.findFirst({
      where: { id: data.taxRateId, tenantId },
      select: { id: true },
    });
    if (!taxRate) {
      return {
        success: false,
        error: "Invalid tax rate.",
        fieldErrors: { taxRateId: ["Tax rate not found"] },
      };
    }
  }

  const updateData: Prisma.ItemUpdateInput = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      if (typeof value === "string" && key !== "unitPrice") {
        updateData[key] = value.trim() || null;
      } else if (key === "unitPrice") {
        updateData[key] = new Prisma.Decimal(value);
      } else {
        updateData[key] = value;
      }
    }
  }

  try {
    await prisma.item.update({
      where: { id: itemId },
      data: updateData,
    });

    await recordAudit({
      action: "item.updated",
      userId: session.user.id,
      tenantId,
      resource: "Item",
      resourceId: itemId,
      metadata: { fields: Object.keys(updateData) },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateItemAction]", err);
    return { success: false, error: "Failed to update item." };
  }
}

export async function deleteItemAction(
  itemId: string,
  tenantId: string,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_DELETE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existingItem = await prisma.item.findUnique({
    where: { id: itemId },
    select: { id: true, tenantId: true, status: true },
  });

  if (!existingItem || existingItem.tenantId !== tenantId) {
    return { success: false, error: "Item not found." };
  }

  const hasContactItems = await prisma.contactItem.findFirst({
    where: { itemId, tenantId },
    select: { id: true },
  });

  if (hasContactItems) {
    return {
      success: false,
      error: "Cannot delete item: it is assigned to customer-specific catalogues. Deactivate instead.",
    };
  }

  try {
    await prisma.item.delete({ where: { id: itemId } });

    await recordAudit({
      action: "item.deleted",
      userId: session.user.id,
      tenantId,
      resource: "Item",
      resourceId: itemId,
    });

    return { success: true };
  } catch (err) {
    console.error("[deleteItemAction]", err);
    return { success: false, error: "Failed to delete item." };
  }
}

export async function getItemsAction(
  rawInput: unknown,
): Promise<ActionResult<{
  items: Prisma.ItemGetPayload<{ include: { taxRate: { include: { category: true } } } }>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}>> {
  const session = await requireAuth();

  const result = itemQuerySchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid query parameters.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, search, type, status, page, pageSize, sortBy, sortOrder } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  const where: Prisma.ItemWhereInput = {
    tenantId,
    ...(type && { type }),
    ...(status && { status }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  try {
    const [items, total] = await Promise.all([
      prisma.item.findMany({
        where,
        include: {
          taxRate: {
            include: { category: { select: { id: true, name: true } } },
          },
        },
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
        totalPages: Math.ceil(total / pageSize),
      },
    };
  } catch (err) {
    console.error("[getItemsAction]", err);
    return { success: false, error: "Failed to load items." };
  }
}

export async function getItemAction(
  itemId: string,
  tenantId: string,
): Promise<ActionResult<{ item: ItemWithDetails | null }>> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  try {
    const item = await prisma.item.findFirst({
      where: { id: itemId, tenantId },
      include: {
        taxRate: { include: { category: true } },
        contactItems: {
          include: { contact: { select: { id: true, firstName: true, lastName: true, companyName: true, type: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return { success: true, data: { item } };
  } catch (err) {
    console.error("[getItemAction]", err);
    return { success: false, error: "Failed to load item." };
  }
}