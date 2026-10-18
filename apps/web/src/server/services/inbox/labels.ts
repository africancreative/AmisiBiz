import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import {
  SOCIAL_AUDIT_ACTIONS,
  SocialServiceError,
} from "@/server/services/integrations/errors";
import type {
  AttachLabelInput,
  CreateLabelInput,
  DeleteLabelInput,
  UpdateLabelInput,
} from "@/lib/validations/inbox";

/**
 * Inbox labels (AGENT 03 module B). Tenant-scoped CRUD plus attach/detach onto a
 * conversation. The (tenantId, name) unique and the migration's case-insensitive
 * functional index mean a duplicate name (any case) is a CONFLICT, not a second
 * row. `ConversationLabel` carries its own tenantId and a DB trigger proves both
 * its conversation and label belong to it, so a forged cross-tenant label id is
 * refused at the row level even if a query forgot its predicate — and we also
 * prove both ids in-tenant here for a clear message.
 */

export type LabelRow = Prisma.LabelGetPayload<Record<string, never>>;

export async function createLabel(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreateLabelInput, "tenantId">,
): Promise<LabelRow> {
  try {
    const label = await prisma.label.create({
      data: {
        tenantId: authz.tenantId,
        name: input.name.trim(),
        color: input.color ?? null,
      },
    });
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.LABEL_CREATED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "Label",
      resourceId: label.id,
      metadata: {},
    });
    return label;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new SocialServiceError(
        "CONFLICT",
        "A label with that name already exists.",
        "name",
      );
    }
    throw error;
  }
}

export async function updateLabel(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<UpdateLabelInput, "tenantId">,
): Promise<LabelRow> {
  const existing = await prisma.label.findFirst({
    where: { id: input.labelId, tenantId: authz.tenantId },
  });
  if (!existing) {
    throw new SocialServiceError("NOT_FOUND", "Label not found.");
  }

  const data: Prisma.LabelUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.color !== undefined) data.color = input.color ?? null;

  try {
    const label = await prisma.label.update({
      where: { id: input.labelId },
      data,
    });
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.LABEL_UPDATED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "Label",
      resourceId: label.id,
      metadata: {},
    });
    return label;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new SocialServiceError(
        "CONFLICT",
        "A label with that name already exists.",
        "name",
      );
    }
    throw error;
  }
}

export async function deleteLabel(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<DeleteLabelInput, "tenantId">,
): Promise<void> {
  const result = await prisma.label.deleteMany({
    where: { id: input.labelId, tenantId: authz.tenantId },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Label not found.");
  }
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.LABEL_DELETED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Label",
    resourceId: input.labelId,
    metadata: {},
  });
}

export async function listLabels(
  authz: TenantAuthzContext,
): Promise<LabelRow[]> {
  return prisma.label.findMany({
    where: { tenantId: authz.tenantId },
    orderBy: { name: "asc" },
  });
}

/* ------------------------------- attach / detach ------------------------------ */

export async function attachLabel(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<AttachLabelInput, "tenantId">,
): Promise<void> {
  // Both the conversation and the label must belong to this tenant. The DB
  // trigger is the backstop; these checks give the operator a clear message.
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!conversation) {
    throw new SocialServiceError("NOT_FOUND", "Conversation not found.");
  }
  const label = await prisma.label.findFirst({
    where: { id: input.labelId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!label) {
    throw new SocialServiceError("NOT_FOUND", "Label not found.");
  }

  try {
    await prisma.conversationLabel.create({
      data: {
        tenantId: authz.tenantId,
        conversationId: input.conversationId,
        labelId: input.labelId,
      },
    });
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.LABEL_ATTACHED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "Conversation",
      resourceId: input.conversationId,
      metadata: { labelId: input.labelId },
    });
  } catch (error) {
    // Already attached: idempotent, the composite PK swallowed the replay.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return;
    }
    throw error;
  }
}

export async function detachLabel(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<AttachLabelInput, "tenantId">,
): Promise<void> {
  const result = await prisma.conversationLabel.deleteMany({
    where: {
      conversationId: input.conversationId,
      labelId: input.labelId,
      tenantId: authz.tenantId,
    },
  });
  if (result.count === 0) {
    throw new SocialServiceError(
      "NOT_FOUND",
      "That label is not on this conversation.",
    );
  }
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.LABEL_ATTACHED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Conversation",
    resourceId: input.conversationId,
    metadata: { labelId: input.labelId, attached: false },
  });
}
