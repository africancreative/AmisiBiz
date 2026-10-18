import type { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import type {
  AddressInput,
  CreateContactInput,
} from "@/lib/validations/contact";
import { replaceContactTags } from "./tags";

/**
 * Shared create core for contacts (AGENT 02, Phase 2B).
 *
 * `createContactAction` and `importContactsCommit` create rows through THIS
 * function, so the promise "a committed import row went through the same code
 * path as a form create" is structural, not aspirational: identical field
 * normalisation, identical email-conflict rule, identical consent timestamping,
 * identical tag folding, identical audit action.
 *
 * The caller supplies an already-authorized `context` — this module never
 * authorizes, and it never trusts a client id: the tenant comes from the
 * context alone.
 */

/** The validated create payload minus the tenant, which comes from the context. */
export type CreateContactRecordData = Omit<CreateContactInput, "tenantId">;

export type CreateContactOutcome =
  | { readonly ok: true; readonly contactId: string }
  | { readonly ok: false; readonly reason: "EMAIL_CONFLICT" };

/** Map validated address rows onto `ContactAddress` create data. */
export function addressCreateData(
  contactId: string,
  addresses: readonly AddressInput[],
): Prisma.ContactAddressCreateManyInput[] {
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

/**
 * Create one contact inside a single transaction: the row, its addresses and
 * its tag set are all-or-nothing. The email-conflict check runs INSIDE the
 * transaction so a concurrent create of the same email cannot slip between the
 * read and the write.
 *
 * Consent timestamping is server-side and automatic: when `marketingConsent`
 * arrives true, `marketingConsentAt` is stamped here (design spec §1.1 — a
 * client never supplies a consent date).
 */
export async function createContactRecord(
  context: TenantAuthzContext,
  data: CreateContactRecordData,
  options?: { readonly rowId?: string },
): Promise<CreateContactOutcome> {
  const tenantId = context.tenantId;
  const email = data.email?.trim().toLowerCase() || null;

  const created = await prisma.$transaction(async (tx) => {
    if (email) {
      const existing = await tx.contact.findFirst({
        where: { tenantId, email },
        select: { id: true },
      });
      if (existing) return null;
    }

    const contact = await tx.contact.create({
      data: {
        // The offline path supplies the id the device minted (`options.rowId`),
        // so a replayed create is recognised as the same row. It is not part of
        // the validated payload, so a form cannot set a row's identity.
        ...(options?.rowId !== undefined ? { id: options.rowId } : {}),
        tenantId,
        type: data.type,
        firstName: data.firstName?.trim() || null,
        lastName: data.lastName?.trim() || null,
        companyName: data.companyName?.trim() || null,
        email,
        phone: data.phone?.trim() || null,
        mobile: data.mobile?.trim() || null,
        taxPin: data.taxPin?.trim() || null,
        notes: data.notes?.trim() || null,
        // Capture-channel fields are written only when the caller sent them
        // (`exactOptionalPropertyTypes`: never assign an explicit undefined).
        ...(data.source !== undefined ? { source: data.source } : {}),
        ...(data.sourceDetail !== undefined
          ? { sourceDetail: data.sourceDetail.trim() || null }
          : {}),
        ...(data.sourceCampaign !== undefined
          ? { sourceCampaign: data.sourceCampaign.trim() || null }
          : {}),
        ...(data.preferredChannel !== undefined
          ? { preferredChannel: data.preferredChannel }
          : {}),
        ...(data.marketingConsent !== undefined
          ? {
              marketingConsent: data.marketingConsent,
              marketingConsentAt: data.marketingConsent ? new Date() : null,
            }
          : {}),
      },
      select: { id: true, type: true },
    });

    if (data.addresses && data.addresses.length > 0) {
      await tx.contactAddress.createMany({
        data: addressCreateData(contact.id, data.addresses),
      });
    }

    if (data.tags !== undefined) {
      await replaceContactTags(tx, tenantId, contact.id, data.tags);
    }

    return contact;
  });

  if (!created) {
    return { ok: false, reason: "EMAIL_CONFLICT" };
  }

  // Audit deliberately omits contact PII (email, phone, postal address).
  await recordAudit({
    action: AUDIT_ACTIONS.CONTACT_CREATED,
    userId: context.userId,
    tenantId,
    resource: "Contact",
    resourceId: created.id,
    metadata: { type: created.type },
  });

  return { ok: true, contactId: created.id };
}
