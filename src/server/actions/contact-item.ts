"use server";

import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  createContactItemSchema,
  updateContactItemSchema,
  deleteContactItemSchema,
  contactItemQuerySchema,
  type CreateContactItemInput,
  type UpdateContactItemInput,
  type ContactItemQueryInput,
} from "@/lib/validations/contact-item";
import type { Prisma } from "@prisma/client";
import type { ActionResult } from "@/lib/errors";

type ContactItemWithItem = Prisma.ContactItemGetPayload<{
  include: { item: { include: { taxRate: { include: { category: true } } } } };
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

export async function createContactItemAction(
  rawInput: unknown,
): Promise<ActionResult<{ contactItemId: string }>> {
  const session = await requireAuth();

  const result = createContactItemSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, contactId, itemId, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_CREATE,
    );
  } catch (err) {
    return authzError<{ contactItemId: string }>(err);
  }

  const [contact, item] = await Promise.all([
    prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true, status: true },
    }),
    prisma.item.findFirst({
      where: { id: itemId, tenantId },
      select: { id: true, status: true, unitPrice: true },
    }),
  ]);

  if (!contact) {
    return { success: false, error: "Contact not found.", fieldErrors: { contactId: ["Contact not found"] } };
  }
  if (!item) {
    return { success: false, error: "Item not found.", fieldErrors: { itemId: ["Item not found"] } };
  }
  if (contact.status === "ARCHIVED") {
    return { success: false, error: "Cannot assign items to an archived contact." };
  }
  if (item.status === "INACTIVE") {
    return { success: false, error: "Cannot assign an inactive item." };
  }

  const existing = await prisma.contactItem.findFirst({
    where: { tenantId, contactId, itemId },
    select: { id: true },
  });
  if (existing) {
    return {
      success: false,
      error: "This item is already assigned to this contact.",
      fieldErrors: { itemId: ["Item already assigned"] },
    };
  }

  try {
    const contactItem = await prisma.contactItem.create({
      data: {
        tenantId,
        contactId,
        itemId,
        customCode: data.customCode?.trim() || null,
        customName: data.customName?.trim() || null,
        agreedPrice: new Prisma.Decimal(data.agreedPrice),
        discountPercent: new Prisma.Decimal(data.discountPercent),
        isAvailable: data.isAvailable,
      },
    });

    await recordAudit({
      action: "contactItem.created",
      userId: session.user.id,
      tenantId,
      resource: "ContactItem",
      resourceId: contactItem.id,
      metadata: { contactId, itemId, agreedPrice: data.agreedPrice },
    });

    return { success: true, data: { contactItemId: contactItem.id } };
  } catch (err) {
    console.error("[createContactItemAction]", err);
    return { success: false, error: "Failed to assign item to contact." };
  }
}

export async function updateContactItemAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = updateContactItemSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { contactItemId, tenantId, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existing = await prisma.contactItem.findUnique({
    where: { id: contactItemId },
    select: { id: true, tenantId: true, contactId: true, itemId: true },
  });

  if (!existing || existing.tenantId !== tenantId) {
    return { success: false, error: "Contact item not found." };
  }

  const updateData: Prisma.ContactItemUpdateInput = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      if (typeof value === "string" && (key === "agreedPrice" || key === "discountPercent")) {
        updateData[key] = new Prisma.Decimal(value);
      } else if (typeof value === "string") {
        updateData[key] = value.trim() || null;
      } else {
        updateData[key] = value;
      }
    }
  }

  try {
    await prisma.contactItem.update({
      where: { id: contactItemId },
      data: updateData,
    });

    await recordAudit({
      action: "contactItem.updated",
      userId: session.user.id,
      tenantId,
      resource: "ContactItem",
      resourceId: contactItemId,
      metadata: { fields: Object.keys(updateData) },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateContactItemAction]", err);
    return { success: false, error: "Failed to update contact item." };
  }
}

export async function deleteContactItemAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = deleteContactItemSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { contactItemId, tenantId } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_DELETE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existing = await prisma.contactItem.findUnique({
    where: { id: contactItemId },
    select: { id: true, tenantId: true },
  });

  if (!existing || existing.tenantId !== tenantId) {
    return { success: false, error: "Contact item not found." };
  }

  try {
    await prisma.contactItem.delete({ where: { id: contactItemId } });

    await recordAudit({
      action: "contactItem.deleted",
      userId: session.user.id,
      tenantId,
      resource: "ContactItem",
      resourceId: contactItemId,
    });

    return { success: true };
  } catch (err) {
    console.error("[deleteContactItemAction]", err);
    return { success: false, error: "Failed to remove item from contact." };
  }
}

export async function getContactItemsAction(
  rawInput: unknown,
): Promise<ActionResult<{
  contactItems: Prisma.ContactItemGetPayload<{ include: { item: { include: { taxRate: { include: { category: true } } } } } }>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}>> {
  const session = await requireAuth();

  const result = contactItemQuerySchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid query parameters.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, contactId, itemId, page, pageSize } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  const where: Prisma.ContactItemWhereInput = {
    tenantId,
    ...(contactId && { contactId }),
    ...(itemId && { itemId }),
  };

  try {
    const [contactItems, total] = await Promise.all([
      prisma.contactItem.findMany({
        where,
        include: {
          item: {
            include: {
              taxRate: { include: { category: { select: { id: true, name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.contactItem.count({ where }),
    ]);

    return {
      success: true,
      data: {
        contactItems,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  } catch (err) {
    console.error("[getContactItemsAction]", err);
    return { success: false, error: "Failed to load contact items." };
  }
}

export async function getAvailableItemsForContactAction(
  contactId: string,
  tenantId: string,
): Promise<ActionResult<{ items: Prisma.ItemGetPayload<{ include: { taxRate: { include: { category: true } } } }>[] }>> {
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

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { id: true, status: true },
  });

  if (!contact) {
    return { success: false, error: "Contact not found." };
  }
  if (contact.status === "ARCHIVED") {
    return { success: false, error: "Cannot assign items to an archived contact." };
  }

  const assignedItemIds = await prisma.contactItem.findMany({
    where: { tenantId, contactId },
    select: { itemId: true },
  });

  const assignedIds = assignedItemIds.map((ci) => ci.itemId);

  try {
    const items = await prisma.item.findMany({
      where: {
        tenantId,
        status: "ACTIVE",
        id: { notIn: assignedIds.length > 0 ? assignedIds : undefined },
      },
      include: {
        taxRate: { include: { category: { select: { id: true, name: true } } } },
      },
      orderBy: { name: "asc" },
    });

    return { success: true, data: { items } };
  } catch (err) {
    console.error("[getAvailableItemsForContactAction]", err);
    return { success: false, error: "Failed to load available items." };
  }
}

export async function getContactItemAction(
  contactItemId: string,
  tenantId: string,
): Promise<ActionResult<{ contactItem: ContactItemWithItem | null }>> {
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
    const contactItem = await prisma.contactItem.findFirst({
      where: { id: contactItemId, tenantId },
      include: {
        item: {
          include: {
            taxRate: { include: { category: { select: { id: true, name: true } } } },
          },
        },
      },
    });

    return { success: true, data: { contactItem } };
  } catch (err) {
    console.error("[getContactItemAction]", err);
    return { success: false, error: "Failed to load contact item." };
  }
}