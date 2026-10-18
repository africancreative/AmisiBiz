"use server";

import { requireAuth } from "@/lib/auth/helpers";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  authorizeTenant,
  AuthorizationError,
} from "@/server/auth/authorization";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  addPipelineStageSchema,
  createPipelineSchema,
  deletePipelineStageSchema,
  pipelineQuerySchema,
  renamePipelineStageSchema,
  reorderPipelineStagesSchema,
  updatePipelineSchema,
} from "@/lib/validations/pipeline";
import {
  CrmServiceError,
  crmErrorActionCode,
} from "@/server/services/leads/service";
import {
  addStage,
  createPipeline,
  deleteStage,
  listPipelines,
  renameStage,
  reorderStages,
  updatePipeline,
} from "@/server/services/pipeline/service";

/**
 * Pipeline & stage Server Actions (AGENT 2A).
 *
 * Two verbs only, mirroring the permission matrix: every read is
 * PIPELINES_READ, every configuration write (pipelines AND their stages) is
 * PIPELINES_MANAGE — SALES can read boards and move leads on them, but only
 * OWNER/ADMIN reshape the pipeline itself (design spec §1.4). The engine
 * enforces the rest: first pipeline auto-defaults, win/loss stages are
 * guaranteed, the default pipeline cannot be archived, and a stage with
 * leads attached cannot be deleted.
 */

function pipelineActionFailure(
  error: unknown,
  context: string,
): ActionResult<never> {
  if (error instanceof CrmServiceError) {
    return fail(error.message, {
      code: crmErrorActionCode(error.code),
      ...(error.field
        ? { fieldErrors: { [error.field]: [error.message] } }
        : {}),
    });
  }
  if (error instanceof AuthorizationError) {
    return authorizationFailure(error, context);
  }
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again later.", {
    code: "INTERNAL",
  });
}

/* --------------------------------- reads ------------------------------------ */

export async function getPipelinesAction(rawInput: unknown): Promise<
  ActionResult<{
    pipelines: Awaited<ReturnType<typeof listPipelines>>;
  }>
> {
  const session = await requireAuth();

  const parsed = pipelineQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PIPELINES_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getPipelinesAction");
  }

  try {
    const pipelines = await listPipelines(context, query);
    return { success: true, data: { pipelines } };
  } catch (err) {
    return pipelineActionFailure(err, "getPipelinesAction");
  }
}

/* -------------------------------- writes ------------------------------------ */

export async function createPipelineAction(
  rawInput: unknown,
): Promise<ActionResult<{ pipelineId: string }>> {
  const session = await requireAuth();

  const parsed = createPipelineSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PIPELINES_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "createPipelineAction");
  }

  try {
    const pipelineId = await createPipeline(context, session.user.id, data);
    return { success: true, data: { pipelineId } };
  } catch (err) {
    return pipelineActionFailure(err, "createPipelineAction");
  }
}

/** Rename and/or archive/restore. `isDefault` is never client-settable. */
export async function updatePipelineAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = updatePipelineSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PIPELINES_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "updatePipelineAction");
  }

  try {
    await updatePipeline(context, session.user.id, data);
    return { success: true };
  } catch (err) {
    return pipelineActionFailure(err, "updatePipelineAction");
  }
}

export async function addPipelineStageAction(
  rawInput: unknown,
): Promise<ActionResult<{ stageId: string }>> {
  const session = await requireAuth();

  const parsed = addPipelineStageSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PIPELINES_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "addPipelineStageAction");
  }

  try {
    const stageId = await addStage(context, session.user.id, data);
    return { success: true, data: { stageId } };
  } catch (err) {
    return pipelineActionFailure(err, "addPipelineStageAction");
  }
}

export async function renamePipelineStageAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = renamePipelineStageSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PIPELINES_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "renamePipelineStageAction");
  }

  try {
    await renameStage(context, session.user.id, data);
    return { success: true };
  } catch (err) {
    return pipelineActionFailure(err, "renamePipelineStageAction");
  }
}

export async function reorderPipelineStagesAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = reorderPipelineStagesSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PIPELINES_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "reorderPipelineStagesAction");
  }

  try {
    await reorderStages(context, session.user.id, data);
    return { success: true };
  } catch (err) {
    return pipelineActionFailure(err, "reorderPipelineStagesAction");
  }
}

export async function deletePipelineStageAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = deletePipelineStageSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, stageId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PIPELINES_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "deletePipelineStageAction");
  }

  try {
    await deleteStage(context, session.user.id, stageId);
    return { success: true };
  } catch (err) {
    return pipelineActionFailure(err, "deletePipelineStageAction");
  }
}
