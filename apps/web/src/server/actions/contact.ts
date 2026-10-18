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
  mergePreviewSchema,
  mergeApplySchema,
  duplicateCandidateQuerySchema,
  contactExportSchema,
  importPreviewSchema,
  importCommitSchema,
} from "@/lib/validations/contact";
import type {
  ContactChannelValue,
  ContactSourceValue,
} from "@/lib/validations/contact";
import {
  addressCreateData,
  createContactRecord,
} from "@/server/services/contacts/create";
import { replaceContactTags } from "@/server/services/contacts/tags";
import {
  ContactServiceError,
  contactErrorActionCode,
} from "@/server/services/contacts/errors";
import {
  applyContactMerge,
  findContactDuplicateCandidates,
  previewContactMerge,
} from "@/server/services/contacts/merge";
import type {
  ContactMergePlan,
  ContactMergeResult,
} from "@/server/services/contacts/merge";
import { exportContacts } from "@/server/services/contacts/export";
import type { ContactExportResult } from "@/server/services/contacts/export";
import {
  importContactsCommit,
  importContactsPreview,
} from "@/server/services/contacts/import";
import type {
  ImportCommitResult,
  ImportPreviewResult,
} from "@/server/services/contacts/import";

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
    select: {
      id: true,
      tenantId: true,
      email: true,
      status: true,
      // Read by the update path to time a marketing-consent flip server-side.
      marketingConsent: true,
    },
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
  source?: ContactSourceValue | null | undefined;
  sourceDetail?: string | null | undefined;
  sourceCampaign?: string | null | undefined;
  preferredChannel?: ContactChannelValue | null | undefined;
  marketingConsent?: boolean | undefined;
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
  // AGENT 02 profile extensions. `marketingConsentAt` is NEVER taken from the
  // payload: the action stamps it when the flag flips true (see below).
  if (data.source !== undefined) update.source = data.source;
  if (data.sourceDetail !== undefined)
    update.sourceDetail = text(data.sourceDetail);
  if (data.sourceCampaign !== undefined)
    update.sourceCampaign = text(data.sourceCampaign);
  if (data.preferredChannel !== undefined)
    update.preferredChannel = data.preferredChannel;
  if (data.marketingConsent !== undefined)
    update.marketingConsent = data.marketingConsent;
  return update;
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

  const { tenantId, ...data } = parsed.data;

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

  // The shared create core (services/contacts/create.ts): identical code path
  // for a form create and a committed import row — same email-conflict rule,
  // same consent stamping, same tag folding, same audit action. `options.rowId`
  // stays outside the validated payload, so a form can never set row identity.
  try {
    const outcome = await createContactRecord(context, data, options);
    if (!outcome.ok) {
      return {
        success: false,
        error: "A contact with this email already exists.",
        code: "CONFLICT",
        fieldErrors: { email: ["Email already in use"] },
      };
    }
    return { success: true, data: { contactId: outcome.contactId } };
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

  const { contactId, tenantId, addresses, tags, ...data } = parsed.data;

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

  // Consent is a legal basis, so its timestamp is a SERVER fact: the instant
  // is recorded exactly when the flag flips false -> true. Flipping back to
  // false keeps the historical stamp; the update never clears evidence.
  if (data.marketingConsent === true && !existingContact.marketingConsent) {
    updateData.marketingConsentAt = new Date();
  }

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

      // Tags arrive as NAMES; get-or-create + case-insensitive dedupe is the
      // tag service's job, inside this same transaction.
      if (tags !== undefined) {
        await replaceContactTags(tx, context.tenantId, contactId, tags);
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
        tagsUpdated: tags !== undefined,
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

/* ─────────────────── AGENT 02 contact operations (Phase 2B) ─────────────── */

/**
 * One failure translator for every contacts-operation action: service errors
 * map onto the shared `ActionResult` codes via `contactErrorActionCode`,
 * unexpected errors log and return generic INTERNAL — the operation services
 * throw (they are not entry points), the ACTIONS never do.
 */
function contactOperationFailure(
  error: unknown,
  context: string,
): ActionResult<never> {
  if (error instanceof ContactServiceError) {
    return fail(error.message, {
      code: contactErrorActionCode(error.code),
      ...(error.field
        ? { fieldErrors: { [error.field]: [error.message] } }
        : {}),
    });
  }
  console.error(`[${context}]`, error);
  return fail("Failed to process the contact request.", { code: "INTERNAL" });
}

/**
 * Read-only merge PLAN (step 1 of the two-step merge). Gated on
 * CONTACTS_UPDATE rather than a read: the plan exposes how many rows sit
 * behind a contact, which is exactly the reconnaissance a merge attacker
 * would want, and nobody who may not merge should preview one.
 */
export async function previewContactMergeAction(
  rawInput: unknown,
): Promise<ActionResult<{ plan: ContactMergePlan }>> {
  const session = await requireAuth();

  const parsed = mergePreviewSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const { tenantId, survivorId, loserIds } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "previewContactMergeAction");
  }

  try {
    const plan = await previewContactMerge(context, { survivorId, loserIds });
    return { success: true, data: { plan } };
  } catch (err) {
    return contactOperationFailure(err, "previewContactMergeAction");
  }
}

/** Execute the merge. Refuses without `confirm: true` — the two-step is server-enforced. */
export async function applyContactMergeAction(
  rawInput: unknown,
): Promise<ActionResult<{ result: ContactMergeResult }>> {
  const session = await requireAuth();

  const parsed = mergeApplySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const { tenantId, survivorId, loserIds, confirm } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "applyContactMergeAction");
  }

  try {
    const result = await applyContactMerge(context, session.user.id, {
      survivorId,
      loserIds,
      confirm,
    });
    return { success: true, data: { result } };
  } catch (err) {
    return contactOperationFailure(err, "applyContactMergeAction");
  }
}

/**
 * Scored duplicate CANDIDATES for a human to review. A read — and the only
 * dedupe affordance the UI gets: nothing here ever merges by itself.
 */
export async function findContactDuplicateCandidatesAction(
  rawInput: unknown,
): Promise<
  ActionResult<{
    candidates: Awaited<ReturnType<typeof findContactDuplicateCandidates>>;
  }>
> {
  const session = await requireAuth();

  const parsed = duplicateCandidateQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "findContactDuplicateCandidatesAction");
  }

  try {
    const candidates = await findContactDuplicateCandidates(context, query);
    return { success: true, data: { candidates } };
  } catch (err) {
    return contactOperationFailure(err, "findContactDuplicateCandidatesAction");
  }
}

/** Server-built CSV of the authorized tenant's contacts. */
export async function exportContactsAction(
  rawInput: unknown,
): Promise<ActionResult<ContactExportResult>> {
  const session = await requireAuth();

  const parsed = contactExportSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const { tenantId, search, type, status } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.CONTACTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "exportContactsAction");
  }

  try {
    const result = await exportContacts(context, {
      ...(search !== undefined ? { search } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    return { success: true, data: result };
  } catch (err) {
    return contactOperationFailure(err, "exportContactsAction");
  }
}

/**
 * Parse + classify an import file WITHOUT writing anything. Gated on
 * DATA_IMPORT — which SALES holds and the portal user does not exist for;
 * every import path refuses roles the permission matrix stops at
 * `authorizeTenant`, and there is deliberately no second softer gate.
 */
export async function importContactsPreviewAction(
  rawInput: unknown,
): Promise<ActionResult<ImportPreviewResult>> {
  const session = await requireAuth();

  const parsed = importPreviewSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const { tenantId, csvText } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DATA_IMPORT,
    );
  } catch (err) {
    return authorizationFailure(err, "importContactsPreviewAction");
  }

  try {
    const preview = await importContactsPreview(context, csvText);
    return { success: true, data: preview };
  } catch (err) {
    return contactOperationFailure(err, "importContactsPreviewAction");
  }
}

/**
 * Create the reviewed rows under an `operationId`. Re-running the same
 * operationId is safe: rows whose `import:<operationId>:<rowIndex>` timeline
 * event already exists are skipped, never duplicated.
 */
export async function importContactsCommitAction(
  rawInput: unknown,
): Promise<ActionResult<ImportCommitResult>> {
  const session = await requireAuth();

  const parsed = importCommitSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }
  const { tenantId, operationId, rows } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DATA_IMPORT,
    );
  } catch (err) {
    return authorizationFailure(err, "importContactsCommitAction");
  }

  try {
    const result = await importContactsCommit(context, session.user.id, {
      operationId,
      rows,
    });
    return { success: true, data: result };
  } catch (err) {
    return contactOperationFailure(err, "importContactsCommitAction");
  }
}
