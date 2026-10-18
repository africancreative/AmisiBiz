import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import {
  SOCIAL_AUDIT_ACTIONS,
  SocialServiceError,
} from "@/server/services/integrations/errors";
import type {
  CreateQuickReplyInput,
  DeleteQuickReplyInput,
  UpdateQuickReplyInput,
} from "@/lib/validations/inbox";

/**
 * Quick replies (AGENT 03 module B). Tenant canned replies keyed by a unique
 * (tenantId, shortcut). `aiProvenance` is a SERVER-owned provenance seam: it is
 * never a client field (the create schema has no key for it), so an operator
 * cannot launder a hand-written reply as AI-generated or vice-versa. Provenance
 * defaults false and would only be set true by a trusted AI-drafting path.
 */

export type QuickReplyRow = Prisma.QuickReplyGetPayload<Record<string, never>>;

export async function createQuickReply(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreateQuickReplyInput, "tenantId">,
): Promise<QuickReplyRow> {
  // Position defaults to the end of the tenant's list when not supplied.
  let position = input.position;
  if (position === undefined) {
    const last = await prisma.quickReply.findFirst({
      where: { tenantId: authz.tenantId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    position = (last?.position ?? -1) + 1;
  }

  try {
    const reply = await prisma.quickReply.create({
      data: {
        tenantId: authz.tenantId,
        shortcut: input.shortcut.trim(),
        body: input.body.trim(),
        position,
        // Provenance is server-set; a client-authored canned reply is not AI.
        aiProvenance: false,
      },
    });
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.QUICK_REPLY_CREATED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "QuickReply",
      resourceId: reply.id,
      metadata: {},
    });
    return reply;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new SocialServiceError(
        "CONFLICT",
        "A quick reply with that shortcut already exists.",
        "shortcut",
      );
    }
    throw error;
  }
}

export async function updateQuickReply(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<UpdateQuickReplyInput, "tenantId">,
): Promise<QuickReplyRow> {
  const existing = await prisma.quickReply.findFirst({
    where: { id: input.quickReplyId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!existing) {
    throw new SocialServiceError("NOT_FOUND", "Quick reply not found.");
  }

  const data: Prisma.QuickReplyUpdateInput = {};
  if (input.shortcut !== undefined) data.shortcut = input.shortcut.trim();
  if (input.body !== undefined) data.body = input.body.trim();
  if (input.position !== undefined) data.position = input.position;

  try {
    const reply = await prisma.quickReply.update({
      where: { id: input.quickReplyId },
      data,
    });
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.QUICK_REPLY_UPDATED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "QuickReply",
      resourceId: reply.id,
      metadata: {},
    });
    return reply;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new SocialServiceError(
        "CONFLICT",
        "A quick reply with that shortcut already exists.",
        "shortcut",
      );
    }
    throw error;
  }
}

export async function deleteQuickReply(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<DeleteQuickReplyInput, "tenantId">,
): Promise<void> {
  const result = await prisma.quickReply.deleteMany({
    where: { id: input.quickReplyId, tenantId: authz.tenantId },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Quick reply not found.");
  }
  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.QUICK_REPLY_DELETED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "QuickReply",
    resourceId: input.quickReplyId,
    metadata: {},
  });
}

export async function listQuickReplies(
  authz: TenantAuthzContext,
): Promise<QuickReplyRow[]> {
  return prisma.quickReply.findMany({
    where: { tenantId: authz.tenantId },
    orderBy: { position: "asc" },
  });
}
