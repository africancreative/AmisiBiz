"use server";

import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  createContactSchema,
  updateContactSchema,
  archiveContactSchema,
  contactQuerySchema,
  type CreateContactInput,
  type UpdateContactInput,
  type ContactQueryInput,
} from "@/lib/validations/contact";
import type { Prisma } from "@prisma/client";
import type { ActionResult } from "@/lib/errors";

type ContactWithDetails = Prisma.ContactGetPayload<{
  include: { addresses: true; contactItems: { include: { item: true } } };
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

export async function createContactAction(
  rawInput: unknown,
): Promise<ActionResult<{ contactId: string }>> {
  const session = await requireAuth();

  const result = createContactSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { tenantId, addresses, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_CREATE,
    );
  } catch (err) {
    return authzError<{ contactId: string }>(err);
  }

  if (data.email) {
    const existing = await prisma.contact.findFirst({
      where: { tenantId, email: data.email.toLowerCase() },
      select: { id: true },
    });
    if (existing) {
      return {
        success: false,
        error: "A contact with this email already exists.",
        fieldErrors: { email: ["Email already in use"] },
      };
    }
  }

  try {
    const contact = await prisma.$transaction(async (tx) => {
      const created = await tx.contact.create({
        data: {
          tenantId,
          type: data.type,
          firstName: data.firstName?.trim() || null,
          lastName: data.lastName?.trim() || null,
          companyName: data.companyName?.trim() || null,
          email: data.email?.toLowerCase().trim() || null,
          phone: data.phone?.trim() || null,
          mobile: data.mobile?.trim() || null,
          taxPin: data.taxPin?.trim() || null,
          notes: data.notes?.trim() || null,
        },
      });

      if (addresses && addresses.length > 0) {
        await tx.contactAddress.createMany({
          data: addresses.map((addr) => ({
            contactId: created.id,
            type: addr.type,
            line1: addr.line1,
            line2: addr.line2 || null,
            city: addr.city || null,
            state: addr.state || null,
            postalCode: addr.postalCode || null,
            country: addr.country || null,
            isDefault: addr.isDefault,
          })),
        });
      }

      return created;
    });

    await recordAudit({
      action: "contact.created",
      userId: session.user.id,
      tenantId,
      resource: "Contact",
      resourceId: contact.id,
      metadata: { type: contact.type, email: contact.email, companyName: contact.companyName },
    });

    return { success: true, data: { contactId: contact.id } };
  } catch (err) {
    console.error("[createContactAction]", err);
    return { success: false, error: "Failed to create contact." };
  }
}

export async function updateContactAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = updateContactSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { contactId, tenantId, addresses, ...data } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existingContact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, tenantId: true, email: true },
  });

  if (!existingContact || existingContact.tenantId !== tenantId) {
    return { success: false, error: "Contact not found." };
  }

  if (data.email && data.email.toLowerCase() !== existingContact.email?.toLowerCase()) {
    const emailExists = await prisma.contact.findFirst({
      where: { tenantId, email: data.email.toLowerCase(), NOT: { id: contactId } },
      select: { id: true },
    });
    if (emailExists) {
      return {
        success: false,
        error: "A contact with this email already exists.",
        fieldErrors: { email: ["Email already in use"] },
      };
    }
  }

  const updateData: Prisma.ContactUpdateInput = {};
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
      await tx.contact.update({
        where: { id: contactId },
        data: updateData,
      });

      if (addresses && addresses.length > 0) {
        await tx.contactAddress.deleteMany({ where: { contactId } });
        await tx.contactAddress.createMany({
          data: addresses.map((addr) => ({
            contactId,
            type: addr.type,
            line1: addr.line1,
            line2: addr.line2 || null,
            city: addr.city || null,
            state: addr.state || null,
            postalCode: addr.postalCode || null,
            country: addr.country || null,
            isDefault: addr.isDefault,
          })),
        });
      }
    });

    await recordAudit({
      action: "contact.updated",
      userId: session.user.id,
      tenantId,
      resource: "Contact",
      resourceId: contactId,
      metadata: { fields: Object.keys(updateData), addressesUpdated: !!addresses },
    });

    return { success: true };
  } catch (err) {
    console.error("[updateContactAction]", err);
    return { success: false, error: "Failed to update contact." };
  }
}

export async function archiveContactAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const result = archiveContactSchema.safeParse(rawInput);
  if (!result.success) {
    return {
      success: false,
      error: "Invalid input.",
      fieldErrors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { contactId, tenantId } = result.data;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_DELETE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existingContact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, tenantId: true, status: true },
  });

  if (!existingContact || existingContact.tenantId !== tenantId) {
    return { success: false, error: "Contact not found." };
  }

  if (existingContact.status === "ARCHIVED") {
    return { success: false, error: "Contact is already archived." };
  }

  try {
    await prisma.contact.update({
      where: { id: contactId },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    await recordAudit({
      action: "contact.archived",
      userId: session.user.id,
      tenantId,
      resource: "Contact",
      resourceId: contactId,
    });

    return { success: true };
  } catch (err) {
    console.error("[archiveContactAction]", err);
    return { success: false, error: "Failed to archive contact." };
  }
}

export async function restoreContactAction(
  contactId: string,
  tenantId: string,
): Promise<ActionResult> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_UPDATE,
    );
  } catch (err) {
    return authzError(err);
  }

  const existingContact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, tenantId: true, status: true },
  });

  if (!existingContact || existingContact.tenantId !== tenantId) {
    return { success: false, error: "Contact not found." };
  }

  if (existingContact.status === "ACTIVE") {
    return { success: false, error: "Contact is already active." };
  }

  try {
    await prisma.contact.update({
      where: { id: contactId },
      data: { status: "ACTIVE", archivedAt: null },
    });

    await recordAudit({
      action: "contact.restored",
      userId: session.user.id,
      tenantId,
      resource: "Contact",
      resourceId: contactId,
    });

    return { success: true };
  } catch (err) {
    console.error("[restoreContactAction]", err);
    return { success: false, error: "Failed to restore contact." };
  }
}

export async function getContactsAction(
  rawInput: unknown,
): Promise<ActionResult<{
  contacts: Prisma.ContactGetPayload<{ include: { addresses: true } }>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}>> {
  const session = await requireAuth();

  const result = contactQuerySchema.safeParse(rawInput);
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
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  const where: Prisma.ContactWhereInput = {
    tenantId,
    ...(type && { type }),
    ...(status && { status }),
    ...(search && {
      OR: [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { companyName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  try {
    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: { addresses: true },
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.contact.count({ where }),
    ]);

    return {
      success: true,
      data: {
        contacts,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  } catch (err) {
    console.error("[getContactsAction]", err);
    return { success: false, error: "Failed to load contacts." };
  }
}

export async function getContactAction(
  contactId: string,
  tenantId: string,
): Promise<ActionResult<{ contact: ContactWithDetails | null }>> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  try {
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      include: {
        addresses: true,
        contactItems: {
          include: { item: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return { success: true, data: { contact } };
  } catch (err) {
    console.error("[getContactAction]", err);
    return { success: false, error: "Failed to load contact." };
  }
}

export async function getContactBalanceAction(
  contactId: string,
  tenantId: string,
): Promise<ActionResult<{ balance: number }>> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, tenantId: true },
  });

  if (!contact || contact.tenantId !== tenantId) {
    return { success: false, error: "Contact not found." };
  }

  const result = await prisma.document.aggregate({
    where: {
      tenantId,
      contactId,
      status: { in: ["ISSUED", "OVERDUE", "PARTIALLY_PAID"] },
    },
    _sum: { total: true },
  });

  const balance = result._sum.total ? Number(result._sum.total) : 0;

  return { success: true, data: { balance } };
}