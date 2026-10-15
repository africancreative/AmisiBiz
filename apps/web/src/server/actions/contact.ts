"use server";

import { Prisma } from "@prisma/client";
import type { DocumentStatus } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import type { CreateActionOptions } from "@/server/actions/_shared";
import {
  createContactSchema,
  updateContactSchema,
  archiveContactSchema,
  restoreContactSchema,
  contactLocatorSchema,
  contactQuerySchema,
} from "@/lib/validations/contact";

/**
 * Detail projection for a single contact: addresses, its customer-specific
 * catalogue (with the default item and that item's tax link) and its document
 * history. Declared once so the returned Prisma payload and the action's return
 * type can never disagree. Exported as a TYPE ONLY (erased at build time) so the
 * detail screen renders the real shape instead of casting it.
 */
const contactDetailInclude = {
  addresses: {
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  },
  contactItems: {
    include: {
      item: { include: { taxRate: { include: { category: true } } } },
    },
    orderBy: { createdAt: "desc" },
  },
  documents: {
    orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
    take: 50,
    select: {
      id: true,
      type: true,
      number: true,
      status: true,
      total: true,
      currency: true,
      issuedAt: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ContactInclude;

export type ContactWithDetails = Prisma.ContactGetPayload<{
  include: typeof contactDetailInclude;
}>;

/**
 * Tenant-scoped lookups always filter on BOTH the row id and the tenant id that
 * was just authorized, so a forged id from another tenant reads as "not found"
 * instead of leaking.
 */
async function findOwnedContact(contactId: string, tenantId: string) {
  return prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { id: true, tenantId: true, email: true, status: true },
  });
}

/** Map only the fields a contact update is allowed to change. */
function toContactUpdateData(data: {
  type?: "INDIVIDUAL" | "BUSINESS" | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  companyName?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  mobile?: string | null | undefined;
  taxPin?: string | null | undefined;
  notes?: string | null | undefined;
}): Prisma.ContactUpdateInput {
  // Every key is written explicitly. Nothing is spread or assigned from a
  // computed key, so an unexpected property in the payload cannot reach Prisma.
  const text = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };

  const update: Prisma.ContactUpdateInput = {};
  if (data.type !== undefined) update.type = data.type;
  if (data.firstName !== undefined) update.firstName = text(data.firstName);
  if (data.lastName !== undefined) update.lastName = text(data.lastName);
  if (data.companyName !== undefined)
    update.companyName = text(data.companyName);
  if (data.email !== undefined) update.email = text(data.email?.toLowerCase());
  if (data.phone !== undefined) update.phone = text(data.phone);
  if (data.mobile !== undefined) update.mobile = text(data.mobile);
  if (data.taxPin !== undefined) update.taxPin = text(data.taxPin);
  if (data.notes !== undefined) update.notes = text(data.notes);
  return update;
}

function addressCreateData(
  contactId: string,
  addresses: NonNullable<
    ReturnType<typeof createContactSchema.parse>["addresses"]
  >,
) {
  return addresses.map((addr) => ({
    contactId,
    type: addr.type,
    line1: addr.line1.trim(),
    line2: addr.line2?.trim() || null,
    city: addr.city?.trim() || null,
    state: addr.state?.trim() || null,
    postalCode: addr.postalCode?.trim() || null,
    country: addr.country?.trim().toUpperCase() || null,
    isDefault: addr.isDefault,
  }));
}

export async function createContactAction(
  rawInput: unknown,
  options?: CreateActionOptions,
): Promise<ActionResult<{ contactId: string }>> {
  const session = await requireAuth();

  const parsed = createContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, addresses, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_CREATE,
    );
  } catch (err) {
    return authorizationFailure(err, "createContactAction");
  }

  const email = data.email?.trim().toLowerCase() || null;

  if (email) {
    const existing = await prisma.contact.findFirst({
      where: { tenantId: context.tenantId, email },
      select: { id: true },
    });
    if (existing) {
      return {
        success: false,
        error: "A contact with this email already exists.",
        code: "CONFLICT",
        fieldErrors: { email: ["Email already in use"] },
      };
    }
  }

  try {
    const contact = await prisma.$transaction(async (tx) => {
      const created = await tx.contact.create({
        data: {
          // The offline path supplies the id the device minted (`options.rowId`),
          // so a replayed create is recognised as the same row. It is not part of
          // the validated payload, so a form cannot set a row's identity.
          ...(options?.rowId !== undefined ? { id: options.rowId } : {}),
          tenantId: context.tenantId,
          type: data.type,
          firstName: data.firstName?.trim() || null,
          lastName: data.lastName?.trim() || null,
          companyName: data.companyName?.trim() || null,
          email,
          phone: data.phone?.trim() || null,
          mobile: data.mobile?.trim() || null,
          taxPin: data.taxPin?.trim() || null,
          notes: data.notes?.trim() || null,
        },
        select: {
          id: true,
          type: true,
          companyName: true,
          firstName: true,
          lastName: true,
        },
      });

      if (addresses && addresses.length > 0) {
        await tx.contactAddress.createMany({
          data: addressCreateData(created.id, addresses),
        });
      }

      return created;
    });

    // Audit deliberately omits contact PII (email, phone, postal address).
    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_CREATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Contact",
      resourceId: contact.id,
      metadata: { type: contact.type },
    });

    return { success: true, data: { contactId: contact.id } };
  } catch (err) {
    console.error("[createContactAction]", err);
    return fail("Failed to create contact.", { code: "INTERNAL" });
  }
}

export async function updateContactAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updateContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { contactId, tenantId, addresses, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateContactAction");
  }

  const existingContact = await findOwnedContact(contactId, context.tenantId);

  if (!existingContact) {
    return fail("Contact not found.", { code: "NOT_FOUND" });
  }

  const email =
    data.email !== undefined
      ? data.email.trim().toLowerCase() || null
      : undefined;

  if (email && email !== existingContact.email) {
    const emailExists = await prisma.contact.findFirst({
      where: { tenantId: context.tenantId, email, NOT: { id: contactId } },
      select: { id: true },
    });
    if (emailExists) {
      return {
        success: false,
        error: "A contact with this email already exists.",
        code: "CONFLICT",
        fieldErrors: { email: ["Email already in use"] },
      };
    }
  }

  const updateData = toContactUpdateData({ ...data, email });

  try {
    await prisma.$transaction(async (tx) => {
      // The tenant predicate is part of the update itself: a row that moved
      // tenants between the check and the write cannot be touched.
      const result = await tx.contact.updateMany({
        where: { id: contactId, tenantId: context.tenantId },
        data: updateData,
      });
      if (result.count === 0) {
        throw new Error("CONTACT_NOT_IN_TENANT");
      }

      if (addresses && addresses.length > 0) {
        await tx.contactAddress.deleteMany({
          where: { contactId, contact: { tenantId: context.tenantId } },
        });
        await tx.contactAddress.createMany({
          data: addressCreateData(contactId, addresses),
        });
      }
    });

    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_UPDATED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Contact",
      resourceId: contactId,
      metadata: {
        fields: Object.keys(updateData),
        addressesUpdated: Boolean(addresses && addresses.length > 0),
      },
    });

    return { success: true };
  } catch (err) {
    if (err instanceof Error && err.message === "CONTACT_NOT_IN_TENANT") {
      return fail("Contact not found.", { code: "NOT_FOUND" });
    }
    console.error("[updateContactAction]", err);
    return fail("Failed to update contact.", { code: "INTERNAL" });
  }
}

export async function archiveContactAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = archiveContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { contactId, tenantId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_DELETE,
    );
  } catch (err) {
    return authorizationFailure(err, "archiveContactAction");
  }

  const existingContact = await findOwnedContact(contactId, context.tenantId);

  if (!existingContact) {
    return fail("Contact not found.", { code: "NOT_FOUND" });
  }

  if (existingContact.status === "ARCHIVED") {
    return fail("Contact is already archived.", { code: "CONFLICT" });
  }

  try {
    // Soft delete only. Issued documents keep pointing at this contact, so the
    // historical record is preserved rather than cascade-destroyed.
    const result = await prisma.contact.updateMany({
      where: { id: contactId, tenantId: context.tenantId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    if (result.count === 0) {
      return fail("Contact is already archived.", { code: "CONFLICT" });
    }

    const linkedDocuments = await prisma.document.count({
      where: { contactId, tenantId: context.tenantId },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_ARCHIVED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Contact",
      resourceId: contactId,
      metadata: { linkedDocuments },
    });

    return { success: true };
  } catch (err) {
    console.error("[archiveContactAction]", err);
    return fail("Failed to archive contact.", { code: "INTERNAL" });
  }
}

export async function restoreContactAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  // Same shape as `archiveContactAction`: the client never gets to name the
  // field it wants flipped, only the locator.
  const parsed = restoreContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const { contactId, tenantId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "restoreContactAction");
  }

  const existingContact = await findOwnedContact(contactId, context.tenantId);

  if (!existingContact) {
    return fail("Contact not found.", { code: "NOT_FOUND" });
  }

  if (existingContact.status === "ACTIVE") {
    return fail("Contact is already active.", { code: "CONFLICT" });
  }

  try {
    const result = await prisma.contact.updateMany({
      where: { id: contactId, tenantId: context.tenantId, status: "ARCHIVED" },
      data: { status: "ACTIVE", archivedAt: null },
    });

    if (result.count === 0) {
      return fail("Contact is already active.", { code: "CONFLICT" });
    }

    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_RESTORED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Contact",
      resourceId: contactId,
    });

    return { success: true };
  } catch (err) {
    console.error("[restoreContactAction]", err);
    return fail("Failed to restore contact.", { code: "INTERNAL" });
  }
}

export async function getContactsAction(rawInput: unknown): Promise<
  ActionResult<{
    contacts: Prisma.ContactGetPayload<{ include: { addresses: true } }>[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = contactQuerySchema.safeParse(rawInput);
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
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getContactsAction");
  }

  const where: Prisma.ContactWhereInput = {
    tenantId: context.tenantId,
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
            { companyName: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { phone: { contains: search, mode: "insensitive" } },
            { mobile: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  try {
    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: { addresses: true },
        // sortBy is constrained by the zod enum above — never free text.
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
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (err) {
    console.error("[getContactsAction]", err);
    return fail("Failed to load contacts.", { code: "INTERNAL" });
  }
}

export async function getContactAction(
  contactId: string,
  tenantId: string,
): Promise<ActionResult<{ contact: ContactWithDetails | null }>> {
  const session = await requireAuth();

  const parsed = contactLocatorSchema.safeParse({ contactId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const scoped = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      scoped.tenantId,
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getContactAction");
  }

  try {
    const contact = await prisma.contact.findFirst({
      where: { id: scoped.contactId, tenantId: context.tenantId },
      include: contactDetailInclude,
    });

    return { success: true, data: { contact } };
  } catch (err) {
    console.error("[getContactAction]", err);
    return fail("Failed to load contact.", { code: "INTERNAL" });
  }
}

/**
 * Outstanding balance derived from recorded documents.
 *
 * The sum comes back from PostgreSQL as `Decimal` and is returned as a decimal
 * STRING. The figure is the total of documents in an unsettled status; payment
 * application is a Phase 06 concern, so this is the "amount invoiced and not
 * voided/drafted" summary, labelled as such by the caller.
 */
export async function getContactBalanceAction(
  contactId: string,
  tenantId: string,
): Promise<
  ActionResult<{ outstanding: string; currency: string; documentCount: number }>
> {
  const session = await requireAuth();

  const parsed = contactLocatorSchema.safeParse({ contactId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getContactBalanceAction");
  }

  const contact = await findOwnedContact(contactId, context.tenantId);
  if (!contact) {
    return fail("Contact not found.", { code: "NOT_FOUND" });
  }

  // The statuses that still owe money, typed against the document enum so a
  // renamed status cannot silently turn the balance into a zero.
  const OUTSTANDING_STATUSES: DocumentStatus[] = [
    "ISSUED",
    "OVERDUE",
    "PARTIALLY_PAID",
  ];

  try {
    const [aggregate, documentCount, branding, tenant] = await Promise.all([
      prisma.document.aggregate({
        where: {
          tenantId: context.tenantId,
          contactId,
          status: { in: OUTSTANDING_STATUSES },
        },
        _sum: { total: true },
      }),
      prisma.document.count({
        where: {
          tenantId: context.tenantId,
          contactId,
          status: { in: OUTSTANDING_STATUSES },
        },
      }),
      prisma.tenantBranding.findUnique({
        where: { tenantId: context.tenantId },
        select: { currency: true },
      }),
      prisma.tenant.findUnique({
        where: { id: context.tenantId },
        select: { currency: true },
      }),
    ]);

    const outstanding = (
      aggregate._sum.total ?? new Prisma.Decimal(0)
    ).toFixed();

    return {
      success: true,
      data: {
        outstanding,
        currency: branding?.currency || tenant?.currency || "KES",
        documentCount,
      },
    };
  } catch (err) {
    console.error("[getContactBalanceAction]", err);
    return fail("Failed to load balance.", { code: "INTERNAL" });
  }
}
