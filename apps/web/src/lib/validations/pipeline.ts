import { z } from "zod";

/**
 * Pipeline & stage configuration validation (AGENT 02 Phase 2A).
 *
 * Server-owned fields (`id`, `tenantId` beyond the re-authorized locator,
 * `position`, `isDefault`, `archivedAt`) are absent from every payload: the
 * service derives position from the stage order, decides the default flag from
 * "first tenant pipeline wins", and archives only through the explicit
 * `archived` switch on the update. A client can never re-number or re-parent
 * stages behind the reorder action's back.
 */

const tenantId = z.string().uuid("Invalid tenant ID");
const pipelineId = z.string().uuid("Invalid pipeline ID");
const stageId = z.string().uuid("Invalid stage ID");

const stageName = z
  .string()
  .trim()
  .min(1, "Stage name is required")
  .max(100, "Keep the stage name under 100 characters");

/** A stage spec on create: the win/loss markers are what metrics key on. */
export const pipelineStageSpecSchema = z.object({
  name: stageName,
  isWin: z.boolean().default(false),
  isLost: z.boolean().default(false),
});

export const createPipelineSchema = z.object({
  tenantId,
  name: z
    .string()
    .trim()
    .min(1, "Pipeline name is required")
    .max(100, "Keep the name under 100 characters"),
  /** Ordered stage names; the service auto-appends a win and a loss stage. */
  stages: z.array(pipelineStageSpecSchema).max(50).optional(),
});

/**
 * Rename or archive. `isDefault` is not client-settable: making another
 * pipeline the default is a deliberate server decision (a partial unique
 * allows exactly one live default per tenant).
 */
export const updatePipelineSchema = z.object({
  tenantId,
  pipelineId,
  name: z
    .string()
    .trim()
    .min(1, "Pipeline name is required")
    .max(100, "Keep the name under 100 characters")
    .optional(),
  archived: z.boolean().optional(),
});

export const pipelineLocatorSchema = z.object({ tenantId, pipelineId });

export const addPipelineStageSchema = z.object({
  tenantId,
  pipelineId,
  name: stageName,
  isWin: z.boolean().default(false),
  isLost: z.boolean().default(false),
});

export const renamePipelineStageSchema = z.object({
  tenantId,
  stageId,
  name: stageName.optional(),
  isWin: z.boolean().optional(),
  isLost: z.boolean().optional(),
});

export const deletePipelineStageSchema = z.object({ tenantId, stageId });

/**
 * A full permutation of the pipeline's current stage ids. The service refuses
 * anything that is not exactly the current membership, so a reorder can only
 * shuffle existing stages, never smuggle in a foreign or duplicate id.
 */
export const reorderPipelineStagesSchema = z.object({
  tenantId,
  pipelineId,
  stageIds: z.array(stageId).min(1).max(50),
});

export const pipelineQuerySchema = z.object({
  tenantId,
  /** Include pipelines that have been archived. */
  includeArchived: z.boolean().default(false),
});

export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;
export type PipelineLocatorInput = z.infer<typeof pipelineLocatorSchema>;
export type AddPipelineStageInput = z.infer<typeof addPipelineStageSchema>;
export type RenamePipelineStageInput = z.infer<
  typeof renamePipelineStageSchema
>;
export type DeletePipelineStageInput = z.infer<
  typeof deletePipelineStageSchema
>;
export type ReorderPipelineStagesInput = z.infer<
  typeof reorderPipelineStagesSchema
>;
export type PipelineQueryInput = z.infer<typeof pipelineQuerySchema>;
export type PipelineStageSpec = z.infer<typeof pipelineStageSpecSchema>;
