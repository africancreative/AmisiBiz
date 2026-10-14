"use server";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  createContactItemSchema,
  updateContactItemSchema,
  deleteContactItemSchema,
  contactItemLocatorSchema,
  availableItemsQuerySchema,
  contactItemQuerySchema,
} from "@/lib/validations/contact-item";

const contactItemInclude = {
  item: { include: { taxRate: { include: { category: true } } } },
} satisfies Prisma.ContactItemInclude;

type ContactItemWithItem = Prisma.ContactItemGetPayload<{
  include: typeof contactItemInclude;
}>;

/**
 * Explicit mapping again: only the five customer-specific fields can be written,
 * and `contactId`/`itemId`/`tenantId` are structurally unreachable from an update
 * payload.
 */
function toContactItemUpdateData(data: {
  customCode?: string | null | undefined;
  customName?: string | null | undefined;
  agreedPrice?: string | undefined;
  discountPercent?: string | undefined;
  isAvailable?: boolean | undefined;
}): Prisma.ContactItemUpdateInput {
  const text = (value: string | null | undefined): string | null =>
    value?.trim() ? value.trim() : null;

  const update: Prisma.ContactItemUpdateInput = {};
  if (data.customCode !== undefined) update.customCode = text(data.customCode);
  if (data.customName !== undefined) update.customName = text(data.customName);
  if (data.agreedPrice !== undefined) {
    update.agreedPrice = new Prisma.Decimal(data.agreedPrice);
  }
  if (data.discountPercent !== undefined) {
    update.discountPercent = new Prisma.Decimal(data.discountPercent);
  }
  if (data.isAvailable !== undefined) update.isAvailable = data.isAvailable;
  return update;
}

export async function createContactItemAction(
  rawInput: unknown,
): Promise<ActionResult<{ contactItemId: string }>> {
  const session = await requireAuth();

  const parsed = createContactItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, contactId, itemId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_CREATE,
    );
  } catch (err) {
    return authorizationFailure(err, "createContactItemAction");
  }

  // Both sides must belong to the authorized tenant: this is what stops a
  // customer-specific price being attached to another business's contact or
  // catalogue item.
  const [contact, item] = await Promise.all([
    prisma.contact.findFirst({
      where: { id: contactId, tenantId: context.tenantId },
      select: { id: true, status: true },
    }),
    prisma.item.findFirst({
      where: { id: itemId, tenantId: context.tenantId },
      select: { id: true, status: true },
    }),
  ]);

  if (!contact) {
    return {
      success: false,
      error: "Contact not found.",
      code: "NOT_FOUND",
      fieldErrors: { contactId: ["Contact not found"] },
    };
  }
  if (!item) {
    return {
      success: false,
      error: "Item not found.",
      code: "NOT_FOUND",
      fieldErrors: { itemId: ["Item not found"] },
    };
  }
  if (contact.status === "ARCHIVED") {
    return fail("Cannot assign items to an archived contact.", {
      code: "CONFLICT",
    });
  }
  if (item.status === "INACTIVE") {
    return fail("Cannot assign an inactive item.", { code: "CONFLICT" });
  }

  const existing = await prisma.contactItem.findFirst({
    where: { tenantId: context.tenantId, contactId, itemId },
    select: { id: true },
  });
  if (existing) {
    return {
      success: false,
      error: "This item is already assigned to this contact.",
      code: "CONFLICT",
      fieldErrors: { itemId: ["Item already assigned"] },
    };
  }

  try {
    const contactItem = await prisma.contactItem.create({
      data: {
        tenantId: context.tenantId,
        contactId: contact.id,
        itemId: item.id,
        customCode: data.customCode?.trim() || null,
        customName: data.customName?.trim() || null,
        agreedPrice: new Prisma.Decimal(data.agreedPrice),
        discountPercent: new Prisma.Decimal(data.discountPercent),
        isAvailable: data.isAvailable,
      },
      select: { id: true },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_ITEM_CREATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "ContactItem",
      resourceId: contactItem.id,
      // Amounts are commercial terms; only the linkage is audited.
      metadata: { contactId: contact.id, itemId: item.id },
    });

    return { success: true, data: { contactItemId: contactItem.id } };
  } catch (err) {
    console.error("[createContactItemAction]", err);
    return fail("Failed to assign item to contact.", { code: "INTERNAL" });
  }
}

export async function updateContactItemAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateContactItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { contactItemId, tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateContactItemAction");
  }

  const existing = await prisma.contactItem.findFirst({
    where: { id: contactItemId, tenantId: context.tenantId },
    select: { id: true },
  });

  if (!existing) {
    return fail("Contact item not found.", { code: "NOT_FOUND" });
  }

  const updateData = toContactItemUpdateData(data);

  try {
    const result = await prisma.contactItem.updateMany({
      where: { id: contactItemId, tenantId: context.tenantId },
      data: updateData,
    });

    if (result.count === 0) {
      return fail("Contact item not found.", { code: "NOT_FOUND" });
    }

    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_ITEM_UPDATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "ContactItem",
      resourceId: contactItemId,
      metadata: { fields: Object.keys(updateData) },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateContactItemAction]", err);
    return fail("Failed to update contact item.", { code: "INTERNAL" });
  }
}

export async function deleteContactItemAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = deleteContactItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { contactItemId, tenantId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_DELETE,
    );
  } catch (err) {
    return authorizationFailure(err, "deleteContactItemAction");
  }

  const existing = await prisma.contactItem.findFirst({
    where: { id: contactItemId, tenantId: context.tenantId },
    select: { id: true, itemId: true, contactId: true },
  });

  if (!existing) {
    return fail("Contact item not found.", { code: "NOT_FOUND" });
  }

  try {
    // Removing an agreement is allowed: the assignment is not a financial
    // record. The default catalogue item and the contact itself are untouched.
    await prisma.contactItem.delete({ where: { id: existing.id } });

    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_ITEM_REMOVED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "ContactItem",
      resourceId: contactItemId,
      metadata: { itemId: existing.itemId, contactId: existing.contactId },
    });

    return { success: true };
  } catch (err) {
    console.error("[deleteContactItemAction]", err);
    return fail("Failed to remove item from contact.", { code: "INTERNAL" });
  }
}

export async function getContactItemsAction(rawInput: unknown): Promise<
  ActionResult<{
    contactItems: Prisma.ContactItemGetPayload<{
      include: {
        item: { include: { taxRate: { include: { category: true } } } };
      };
    }>[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = contactItemQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, contactId, itemId, page, pageSize } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ITEMS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getContactItemsAction");
  }

  const where: Prisma.ContactItemWhereInput = {
    tenantId: context.tenantId,
    ...(contactId ? { contactId } : {}),
    ...(itemId ? { itemId } : {}),
  };

  try {
    const [contactItems, total] = await Promise.all([
      prisma.contactItem.findMany({
        where,
        include: contactItemInclude,
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
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (err) {
    console.error("[getContactItemsAction]", err);
    return fail("Failed to load contact items.", { code: "INTERNAL" });
  }
}

/**
 * Catalogue items this contact has NOT yet been given a customer-specific
 * agreement for. The default catalogue stays separately visible/usable — this is
 * an assignment picker, not a replacement list.
 */
export async function getAvailableItemsForContactAction(
  contactId: string,
  tenantId: string,
): Promise<
  ActionResult<{
    items: Prisma.ItemGetPayload<{
      include: { taxRate: { include: { category: true } } };
    }>[];
  }>
> {
  const session = await requireAuth();

  const parsed = availableItemsQuerySchema.safeParse({ contactId, tenantId });
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
    return authorizationFailure(err, "getAvailableItemsForContactAction");
  }

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId: context.tenantId },
    select: { id: true, status: true },
  });

  if (!contact) {
    return fail("Contact not found.", { code: "NOT_FOUND" });
  }
  if (contact.status === "ARCHIVED") {
    return fail("Cannot assign items to an archived contact.", {
      code: "CONFLICT",
    });
  }

  try {
    const items = await prisma.item.findMany({
      where: {
        tenantId: context.tenantId,
        status: "ACTIVE",
        contactItems: { none: { contactId: contact.id } },
      },
      include: { taxRate: { include: { category: true } } },
      orderBy: { name: "asc" },
    });

    return { success: true, data: { items } };
  } catch (err) {
    console.error("[getAvailableItemsForContactAction]", err);
    return fail("Failed to load available items.", { code: "INTERNAL" });
  }
}

export async function getContactItemAction(
  contactItemId: string,
  tenantId: string,
): Promise<ActionResult<{ contactItem: ContactItemWithItem | null }>> {
  const session = await requireAuth();

  const parsed = contactItemLocatorSchema.safeParse({
    contactItemId,
    tenantId,
  });
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
    return authorizationFailure(err, "getContactItemAction");
  }

  try {
    const contactItem = await prisma.contactItem.findFirst({
      where: { id: contactItemId, tenantId: context.tenantId },
      include: contactItemInclude,
    });

    return { success: true, data: { contactItem } };
  } catch (err) {
    console.error("[getContactItemAction]", err);
    return fail("Failed to load contact item.", { code: "INTERNAL" });
  }
}
