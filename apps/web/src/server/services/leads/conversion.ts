import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { appendActivity } from "@/server/services/activities/service";
import { createContactSchema } from "@/lib/validations/contact";
import type { DocumentLineInputPayload } from "@/lib/validations/document-write";
import { createDraft } from "../documents/service";
import type { DocumentLinePayload } from "../documents/lines";
import {
  convertLeadSchema,
  type ConvertLeadInput,
} from "@/lib/validations/lead";
import { normalizeEmail } from "./dedupe";
import { CRM_AUDIT_ACTIONS, CrmServiceError } from "./service";

/**
 * Lead conversion (AGENT 02 Phase 2A) — the one path that turns a lead into
 * a customer, atomically.
 *
 * The rules this function exists to keep:
 *
 *  - Only NEW / CONTACTED / QUALIFIED leads convert; LOST and CONVERTED are
 *    refused with a VALIDATION error (§1.4: terminal states).
 *  - Create-or-reuse is explicit (`mode`), never silent: the operator chose
 *    which contact survives, after seeing the duplicate suspects.
 *  - The new-contact branch runs the SAME validation as `createContactAction`
 *    (`createContactSchema`, imported, not reimplemented) and the same field
 *    set — with `tenantId` server-set and the contact-creation audit written
 *    under the same canonical action name.
 *  - The lead state change, the contact create/link and the tenant pinning
 *    happen in ONE `prisma.$transaction`; the timeline event and the audit
 *    follow the commit (the timeline's single writer takes the authz context,
 *    not the transaction handle, and its (source, sourceKey) unique makes a
 *    retry land once).
 *  - The optional draft document is honest. `documents.createDraft` refuses a
 *    document with zero lines ("A document needs at least one line"), so the
 *    conversion NEVER fakes a quotation: with `createDraft` requested but no
 *    lines supplied, the conversion completes and the result carries
 *    `needsDraftEditor: true` so the UI opens the editor. When lines ARE
 *    supplied the draft is raised through the existing documents service —
 *    in its OWN transaction, because the engine opens one internally and a
 *    nested interactive transaction cannot share the running one; the lead's
 *    `convertedDocumentId` is then attached. The documents engine's own
 *    `idempotencyKey` makes a retried conversion return the first draft
 *    instead of burning a second one.
 */

/**
 * `ConvertLeadInput` is a discriminated UNION, and plain `Omit` is not
 * distributive — it would collapse the two branches into their common keys and
 * hide `contact` / `contactId`. Distributing first keeps each branch's mode
 * paired with its own payload (`leadId` is already required in the schema, so
 * nothing has to be re-added here).
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type ConvertLeadServiceInput = DistributiveOmit<
  ConvertLeadInput,
  "tenantId"
>;

export interface ConvertLeadResult {
  readonly leadId: string;
  readonly contactId: string;
  readonly documentId: string | null;
  /** True only when a draft document was actually created (or replayed). */
  readonly documentCreated: boolean;
  /** Draft was requested but has no lines — the UI must open the editor. */
  readonly needsDraftEditor: boolean;
}

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Map a validated line payload onto the document engine's line shape. */
function toDocumentLinePayload(
  lines: readonly DocumentLineInputPayload[],
): DocumentLinePayload[] {
  return lines.map((line) => ({
    itemId: line.itemId ?? null,
    description: line.description,
    itemCode: line.itemCode ?? null,
    unitOfMeasure: line.unitOfMeasure,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountType: line.discountType ?? null,
    discountPercent: line.discountPercent,
    discountAmount: line.discountAmount,
    taxRateId: line.taxRateId ?? null,
  }));
}

/**
 * Resolve the contact the converted lead points at: validate-and-create on the
 * new branch (field parity with `createContactAction`), verify-and-link on the
 * existing branch. Runs inside the caller's transaction handle.
 */
async function resolveContact(
  tx: Prisma.TransactionClient,
  authz: TenantAuthzContext,
  input: ConvertLeadServiceInput,
): Promise<{
  contactId: string;
  createdContact: boolean;
  createdContactType: string | null;
}> {
  if (input.mode === "existingContact") {
    const contact = await tx.contact.findFirst({
      where: { id: input.contactId, tenantId: authz.tenantId },
      select: { id: true, status: true },
    });
    if (!contact) {
      throw new CrmServiceError(
        "VALIDATION",
        "The selected customer does not exist in this business.",
        "contactId",
      );
    }
    if (contact.status !== "ACTIVE") {
      throw new CrmServiceError(
        "VALIDATION",
        "Restore the archived customer before converting a lead onto it.",
        "contactId",
      );
    }
    return {
      contactId: contact.id,
      createdContact: false,
      createdContactType: null,
    };
  }

  // Same rules as `createContactAction`, applied to a server-set tenant. The
  // blob's own `tenantId`/`id`/`status` keys are stripped by the schema and
  // overridden here — the authorized tenant is the only one written.
  const parsed = createContactSchema.safeParse({
    ...input.contact,
    tenantId: authz.tenantId,
  });
  if (!parsed.success) {
    throw new CrmServiceError(
      "VALIDATION",
      "The new customer details are not valid.",
    );
  }
  const data = parsed.data;

  const email = normalizeEmail(data.email);
  if (email) {
    const clash = await tx.contact.findFirst({
      where: { tenantId: authz.tenantId, email },
      select: { id: true },
    });
    if (clash) {
      // Never silently merge: the operator links explicitly instead.
      throw new CrmServiceError(
        "CONFLICT",
        "A customer with this email already exists. Link the lead to that customer instead of creating a new one.",
        "email",
      );
    }
  }

  const created = await tx.contact.create({
    data: {
      tenantId: authz.tenantId,
      type: data.type,
      firstName: text(data.firstName),
      lastName: text(data.lastName),
      companyName: text(data.companyName),
      email,
      phone: text(data.phone),
      mobile: text(data.mobile),
      taxPin: text(data.taxPin),
      notes: text(data.notes),
      ...(data.addresses?.length
        ? {
            addresses: {
              create: data.addresses.map((address) => ({
                type: address.type,
                line1: address.line1.trim(),
                line2: text(address.line2),
                city: text(address.city),
                state: text(address.state),
                postalCode: text(address.postalCode),
                country: text(address.country),
                isDefault: address.isDefault,
              })),
            },
          }
        : {}),
    },
    select: { id: true, type: true },
  });

  return {
    contactId: created.id,
    createdContact: true,
    createdContactType: created.type,
  };
}

export async function convertLead(
  authz: TenantAuthzContext,
  actorId: string,
  input: ConvertLeadServiceInput,
): Promise<ConvertLeadResult> {
  const converted = await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: input.leadId, tenantId: authz.tenantId },
    });
    if (!lead) {
      throw new CrmServiceError("NOT_FOUND", "Lead not found.");
    }
    if (lead.status === "LOST" || lead.status === "CONVERTED") {
      // Terminal by schema rule; reopen first (LOST) or treat as final
      // (CONVERTED). A retried conversion is NOT a silent success: the caller
      // must know the lead was already converted.
      throw new CrmServiceError(
        "VALIDATION",
        lead.status === "LOST"
          ? "Reopen the lost lead before converting it."
          : "This lead has already been converted.",
        "status",
      );
    }
    if (!["NEW", "CONTACTED", "QUALIFIED"].includes(lead.status)) {
      throw new CrmServiceError(
        "VALIDATION",
        "Only a new, contacted or qualified lead can be converted.",
        "status",
      );
    }

    const { contactId, createdContact, createdContactType } =
      await resolveContact(tx, authz, input);

    const convertedAt = new Date();
    const result = await tx.lead.updateMany({
      where: { id: lead.id, tenantId: authz.tenantId },
      data: {
        status: "CONVERTED",
        convertedAt,
        convertedContactId: contactId,
        // A converted lead's working stage link is retired; the customer is
        // the surviving record from here on.
        pipelineStageId: null,
      },
    });
    if (result.count === 0) {
      throw new CrmServiceError("NOT_FOUND", "Lead not found.");
    }

    return {
      lead,
      contactId,
      createdContact,
      createdContactType,
      convertedAt,
    };
  });

  // Field parity with `createContactAction`'s audit: same canonical action
  // name, metadata type-only, no PII — written post-commit, never inside the
  // transaction, exactly like the document engine does it.
  if (converted.createdContact && converted.createdContactType !== null) {
    await recordAudit({
      action: AUDIT_ACTIONS.CONTACT_CREATED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "Contact",
      resourceId: converted.contactId,
      metadata: { type: converted.createdContactType, via: "lead_conversion" },
    });
  }

  // The timeline writer takes the authz context (its single-writer contract);
  // it runs post-commit, and the (source, sourceKey) unique makes a replay of
  // the conversion append nothing a second time.
  await appendActivity(authz, actorId, {
    eventType: "LEAD_CONVERTED",
    leadId: input.leadId,
    contactId: converted.contactId,
    payload: {
      mode: input.mode,
      createdContact: converted.createdContact,
    },
    source: "action:lead.convert",
    sourceKey: `lead:${input.leadId}:convert`,
  });

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.LEAD_CONVERTED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Lead",
    resourceId: input.leadId,
    metadata: { mode: input.mode, createdContact: converted.createdContact },
  });

  /* ------------------------- optional draft document ------------------------ */

  if (!input.createDraft) {
    return {
      leadId: input.leadId,
      contactId: converted.contactId,
      documentId: null,
      documentCreated: false,
      needsDraftEditor: false,
    };
  }

  if (!input.draftLines || input.draftLines.length === 0) {
    // The engine refuses a zero-line document and this function will not fake
    // one. Conversion stands; the UI is told to open the editor.
    return {
      leadId: input.leadId,
      contactId: converted.contactId,
      documentId: null,
      documentCreated: false,
      needsDraftEditor: true,
    };
  }

  // Runs in the documents engine's own transaction (it opens one internally;
  // nesting it inside the conversion transaction is not possible with the
  // root client). The deterministic idempotency key means a retry of the same
  // conversion returns the first draft rather than creating a second.
  const document = await createDraft(authz, actorId, {
    type: input.createDraft === "order" ? "ORDER" : "QUOTATION",
    contactId: converted.contactId,
    currency: converted.lead.currency,
    issueDate: converted.convertedAt,
    dueDate: null,
    expiryDate: null,
    deliveryDate: null,
    customerNote: null,
    terms: null,
    deliveryNote: null,
    sourceDocumentId: null,
    replacementOfId: null,
    idempotencyKey: `lead-${input.leadId}-convert`,
    lines: toDocumentLinePayload(input.draftLines),
  });

  await prisma.lead.updateMany({
    where: { id: input.leadId, tenantId: authz.tenantId },
    data: { convertedDocumentId: document.id },
  });

  return {
    leadId: input.leadId,
    contactId: converted.contactId,
    documentId: document.id,
    documentCreated: true,
    needsDraftEditor: false,
  };
}

/** Exported so tests (and the action layer) validate payloads identically. */
export { convertLeadSchema };
