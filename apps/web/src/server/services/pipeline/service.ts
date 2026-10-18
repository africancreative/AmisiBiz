import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import type {
  AddPipelineStageInput,
  CreatePipelineInput,
  PipelineQueryInput,
  RenamePipelineStageInput,
  ReorderPipelineStagesInput,
  UpdatePipelineInput,
} from "@/lib/validations/pipeline";
import { CRM_AUDIT_ACTIONS, CrmServiceError } from "../leads/service";

/**
 * Pipeline & stage configuration (AGENT 02 Phase 2A).
 *
 * The rules this service keeps:
 *
 *  - The FIRST live pipeline of a tenant auto-defaults (`isDefault`), because
 *    the migration's partial unique allows exactly one live default and a
 *    board without one has no landing stage for new leads. Later pipelines
 *    never self-declare as default through this API.
 *  - A usable pipeline always has a win stage and a loss stage: the metrics
 *    need terminal markers, so the missing ones are auto-appended
 *    ("Won" isWin / "Lost" isLost) when the caller's list omits them.
 *  - Archiving the DEFAULT pipeline is refused — it would strand every lead
 *    that landed on its board (and the partial unique's meaning depends on
 *    the live default being live).
 *  - Deleting a stage with leads attached is refused with a VALIDATION error
 *    before the Restrict FK can raise; the operator moves the leads first.
 *  - Reorder is a full permutation check: the submitted ids must be exactly
 *    the pipeline's current stages, then positions are rewritten in two
 *    passes so the (tenantId, pipelineId, position) unique is never violated
 *    mid-transaction.
 */

/** Open-lead statuses used for per-stage counts (terminal ones excluded). */
const OPEN_LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED"] as const;

const DEFAULT_WIN_STAGE = { name: "Won", isWin: true, isLost: false };
const DEFAULT_LOSS_STAGE = { name: "Lost", isWin: false, isLost: true };

const FALLBACK_STAGES = [
  { name: "New", isWin: false, isLost: false },
  { name: "Contacted", isWin: false, isLost: false },
  { name: "Qualified", isWin: false, isLost: false },
];

async function loadPipelineOrThrow(
  authz: TenantAuthzContext,
  pipelineId: string,
): Promise<Prisma.PipelineGetPayload<Record<string, never>>> {
  const pipeline = await prisma.pipeline.findFirst({
    where: { id: pipelineId, tenantId: authz.tenantId },
  });
  if (!pipeline) {
    throw new CrmServiceError("NOT_FOUND", "Pipeline not found.");
  }
  return pipeline;
}

async function loadStageOrThrow(
  authz: TenantAuthzContext,
  stageId: string,
): Promise<Prisma.PipelineStageGetPayload<Record<string, never>>> {
  const stage = await prisma.pipelineStage.findFirst({
    where: { id: stageId, tenantId: authz.tenantId },
  });
  if (!stage) {
    throw new CrmServiceError("NOT_FOUND", "Stage not found.");
  }
  return stage;
}

/**
 * Build the stage list to persist: the caller's ordered names, with a win
 * and a loss marker appended if the caller's list has neither. Duplicate
 * names inside one request are a validation error, not a silent merge.
 */
function withTerminalStages(
  requested: CreatePipelineInput["stages"],
): Array<{ name: string; isWin: boolean; isLost: boolean }> {
  const names = (requested ?? FALLBACK_STAGES).map((stage) => ({
    ...stage,
    name: stage.name.trim(),
  }));

  const lowercased = new Set(names.map((stage) => stage.name.toLowerCase()));
  if (lowercased.size !== names.length) {
    throw new CrmServiceError(
      "VALIDATION",
      "Stage names must be unique within a pipeline.",
      "stages",
    );
  }

  const hasWin = names.some((stage) => stage.isWin);
  const hasLoss = names.some((stage) => stage.isLost);
  return [
    ...names,
    ...(hasWin ? [] : [DEFAULT_WIN_STAGE]),
    ...(hasLoss ? [] : [DEFAULT_LOSS_STAGE]),
  ];
}

export async function createPipeline(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreatePipelineInput, "tenantId">,
): Promise<string> {
  const stages = withTerminalStages(input.stages);

  // The first pipeline in the workspace is the default: the partial unique
  // `(tenantId) WHERE isDefault AND archivedAt IS NULL` allows exactly one,
  // and a board needs a landing configuration before anyone configures one.
  const liveCount = await prisma.pipeline.count({
    where: { tenantId: authz.tenantId },
  });

  const pipeline = await prisma.$transaction(async (tx) => {
    const created = await tx.pipeline.create({
      data: {
        tenantId: authz.tenantId,
        name: input.name.trim(),
        isDefault: liveCount === 0,
      },
      select: { id: true, name: true, isDefault: true },
    });

    await tx.pipelineStage.createMany({
      data: stages.map((stage, index) => ({
        tenantId: authz.tenantId,
        pipelineId: created.id,
        name: stage.name,
        position: index + 1,
        isWin: stage.isWin,
        isLost: stage.isLost,
      })),
    });

    return created;
  });

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.PIPELINE_CREATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Pipeline",
    resourceId: pipeline.id,
    metadata: { stageCount: stages.length, isDefault: pipeline.isDefault },
  });

  return pipeline.id;
}

export async function updatePipeline(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<UpdatePipelineInput, "tenantId">,
): Promise<void> {
  const pipeline = await loadPipelineOrThrow(authz, input.pipelineId);

  if (input.archived === true && pipeline.isDefault) {
    throw new CrmServiceError(
      "VALIDATION",
      "The default pipeline cannot be archived. Promote another live pipeline first.",
      "archived",
    );
  }

  const data: Prisma.PipelineUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.archived !== undefined) {
    data.archivedAt = input.archived ? new Date() : null;
  }

  const result = await prisma.pipeline.updateMany({
    where: { id: input.pipelineId, tenantId: authz.tenantId },
    data,
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Pipeline not found.");
  }

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.PIPELINE_UPDATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Pipeline",
    resourceId: input.pipelineId,
    metadata: { fields: Object.keys(data) },
  });
}

export async function addStage(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<AddPipelineStageInput, "tenantId">,
): Promise<string> {
  const pipeline = await loadPipelineOrThrow(authz, input.pipelineId);
  if (pipeline.archivedAt !== null) {
    throw new CrmServiceError(
      "CONFLICT",
      "This pipeline is archived; restore it before adding stages.",
    );
  }

  const name = input.name.trim();
  const clash = await prisma.pipelineStage.findFirst({
    where: { tenantId: authz.tenantId, pipelineId: input.pipelineId, name },
    select: { id: true },
  });
  if (clash) {
    throw new CrmServiceError(
      "VALIDATION",
      "A stage with this name already exists in the pipeline.",
      "name",
    );
  }

  // Positions are assigned server-side, one past the current maximum.
  const top = await prisma.pipelineStage.findFirst({
    where: { tenantId: authz.tenantId, pipelineId: input.pipelineId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const stage = await prisma.pipelineStage.create({
    data: {
      tenantId: authz.tenantId,
      pipelineId: input.pipelineId,
      name,
      position: (top?.position ?? 0) + 1,
      isWin: input.isWin,
      isLost: input.isLost,
    },
    select: { id: true },
  });

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.PIPELINE_STAGE_ADDED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "PipelineStage",
    resourceId: stage.id,
    metadata: {
      pipelineId: input.pipelineId,
      position: (top?.position ?? 0) + 1,
    },
  });

  return stage.id;
}

export async function renameStage(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<RenamePipelineStageInput, "tenantId">,
): Promise<void> {
  const stage = await loadStageOrThrow(authz, input.stageId);

  const data: Prisma.PipelineStageUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    const clash = await prisma.pipelineStage.findFirst({
      where: {
        tenantId: authz.tenantId,
        pipelineId: stage.pipelineId,
        name,
        id: { not: stage.id },
      },
      select: { id: true },
    });
    if (clash) {
      throw new CrmServiceError(
        "VALIDATION",
        "A stage with this name already exists in the pipeline.",
        "name",
      );
    }
    data.name = name;
  }
  if (input.isWin !== undefined) data.isWin = input.isWin;
  if (input.isLost !== undefined) data.isLost = input.isLost;

  const result = await prisma.pipelineStage.updateMany({
    where: { id: input.stageId, tenantId: authz.tenantId },
    data,
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Stage not found.");
  }

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.PIPELINE_STAGE_UPDATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "PipelineStage",
    resourceId: input.stageId,
    metadata: { fields: Object.keys(data) },
  });
}

export async function reorderStages(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<ReorderPipelineStagesInput, "tenantId">,
): Promise<void> {
  await loadPipelineOrThrow(authz, input.pipelineId);

  const current = await prisma.pipelineStage.findMany({
    where: { tenantId: authz.tenantId, pipelineId: input.pipelineId },
    select: { id: true },
  });

  // Exact-permutation check: duplicates, foreign stages and missing stages
  // all fail, so the position rewrite below is total.
  const currentIds = new Set(current.map((stage) => stage.id));
  const submitted = new Set(input.stageIds);
  if (
    submitted.size !== input.stageIds.length ||
    submitted.size !== currentIds.size ||
    [...submitted].some((id) => !currentIds.has(id))
  ) {
    throw new CrmServiceError(
      "VALIDATION",
      "The reorder must list each of the pipeline's stages exactly once.",
      "stageIds",
    );
  }

  await prisma.$transaction(async (tx) => {
    // Pass 1 parks every stage at a distinct negative position so no two rows
    // ever hold the same (pipelineId, position); pass 2 assigns the final
    // order. A direct rewrite would collide mid-flight on the unique index.
    for (const [index, id] of input.stageIds.entries()) {
      await tx.pipelineStage.updateMany({
        where: { id, tenantId: authz.tenantId },
        data: { position: -(index + 1) },
      });
    }
    for (const [index, id] of input.stageIds.entries()) {
      await tx.pipelineStage.updateMany({
        where: { id, tenantId: authz.tenantId },
        data: { position: index + 1 },
      });
    }
  });

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.PIPELINE_STAGE_UPDATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Pipeline",
    resourceId: input.pipelineId,
    metadata: { reorder: true, stageCount: input.stageIds.length },
  });
}

export async function deleteStage(
  authz: TenantAuthzContext,
  actorId: string,
  stageId: string,
): Promise<void> {
  const stage = await loadStageOrThrow(authz, stageId);

  // The FK is Restrict anyway; checking first turns a driver-level error into
  // the actionable message the operator needs.
  const attachedLeads = await prisma.lead.count({
    where: { tenantId: authz.tenantId, pipelineStageId: stage.id },
  });
  if (attachedLeads > 0) {
    throw new CrmServiceError(
      "VALIDATION",
      `This stage still has ${attachedLeads} lead(s) on it. Move them before deleting the stage.`,
      "stageId",
    );
  }

  await prisma.pipelineStage.delete({ where: { id: stage.id } });

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.PIPELINE_STAGE_DELETED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "PipelineStage",
    resourceId: stage.id,
    metadata: { pipelineId: stage.pipelineId },
  });
}

const pipelineListInclude = {
  stages: {
    orderBy: { position: "asc" as const },
    include: {
      _count: {
        select: {
          leads: { where: { status: { in: [...OPEN_LEAD_STATUSES] } } },
        },
      },
    },
  },
} satisfies Prisma.PipelineInclude;

export type PipelineListItem = Prisma.PipelineGetPayload<{
  include: typeof pipelineListInclude;
}>;

/** Pipelines with their ordered stages and the open-lead count per stage. */
export async function listPipelines(
  authz: TenantAuthzContext,
  query: Omit<PipelineQueryInput, "tenantId">,
): Promise<PipelineListItem[]> {
  return prisma.pipeline.findMany({
    where: {
      tenantId: authz.tenantId,
      ...(query.includeArchived ? {} : { archivedAt: null }),
    },
    include: pipelineListInclude,
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}
