"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Field } from "@amisibiz/ui/field";
import { Badge } from "@amisibiz/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@amisibiz/ui/dialog";
import { ConfirmDialog } from "@amisibiz/ui/confirm-dialog";
import { EmptyState, LoadingState } from "@amisibiz/ui/state";
import {
  addPipelineStageAction,
  createPipelineAction,
  deletePipelineStageAction,
  getPipelinesAction,
  renamePipelineStageAction,
  reorderPipelineStagesAction,
  updatePipelineAction,
} from "@/server/actions/pipeline";
import type { PipelineListItem } from "@/server/services/pipeline/service";
import { cn } from "@/lib/utils";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

/**
 * Pipeline & stage editor (AGENT 02 Phase 3).
 *
 * Reads need PIPELINES_READ; every mutation needs PIPELINES_MANAGE, and the
 * engine's guards (a stage with leads cannot be deleted, the default pipeline
 * cannot be archived, reorder must be an exact permutation) arrive as
 * ordinary `ActionResult` errors — this editor shows the server's message
 * verbatim instead of trying to pre-enforce it. Reordering moves whole
 * permutations built from the CURRENT stage ids, so a stale list can never
 * smuggle a foreign stage into the payload; the service refuses the mismatch.
 */

type StageRow = PipelineListItem["stages"][number];

interface PipelinesClientProps {
  tenantId: string;
  readonly: boolean;
  canManage: boolean;
  canViewLeads: boolean;
  locale: string;
  title: string;
  description: string;
}

export function PipelinesClient({
  tenantId,
  readonly,
  canManage,
  canViewLeads,
  locale,
  title,
  description,
}: PipelinesClientProps) {
  const [pipelines, setPipelines] = React.useState<PipelineListItem[]>([]);
  const [includeArchived, setIncludeArchived] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [deletingStage, setDeletingStage] = React.useState<{
    stage: StageRow;
    pipeline: PipelineListItem;
  } | null>(null);
  const [isDeletingStage, setIsDeletingStage] = React.useState(false);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getPipelinesAction({
        tenantId,
        includeArchived,
      });
      if (!result.success) {
        setError(result.error || "Failed to load pipelines.");
        return;
      }
      if (result.data) setPipelines(result.data.pipelines);
    } catch {
      setError("Something went wrong while loading pipelines.");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, includeArchived]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (
    key: string,
    action: () => Promise<{
      success: boolean;
      error?: string;
    }>,
    successMessage: string,
  ): Promise<boolean> => {
    setBusyKey(key);
    setError(null);
    setFlash(null);
    try {
      const result = await action();
      if (!result.success) {
        // The engine's guard message is the honest one — show it verbatim.
        setError(result.error || "The change was refused.");
        return false;
      }
      setFlash(successMessage);
      await load();
      return true;
    } catch {
      setError("Something went wrong. Please try again.");
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const renamePipeline = (pipelineId: string, name: string) =>
    runAction(
      `rename-${pipelineId}`,
      () => updatePipelineAction({ tenantId, pipelineId, name }),
      "Pipeline renamed.",
    );

  const setArchived = (pipeline: PipelineListItem, archived: boolean) =>
    runAction(
      `archive-${pipeline.id}`,
      () =>
        updatePipelineAction({ tenantId, pipelineId: pipeline.id, archived }),
      archived ? "Pipeline archived." : "Pipeline restored.",
    );

  const addStage = (
    pipelineId: string,
    name: string,
    isWin: boolean,
    isLost: boolean,
  ) =>
    runAction(
      `add-${pipelineId}`,
      () =>
        addPipelineStageAction({ tenantId, pipelineId, name, isWin, isLost }),
      "Stage added.",
    );

  const renameStage = (
    stageId: string,
    patch: { name?: string; isWin?: boolean; isLost?: boolean },
  ) =>
    runAction(
      `stage-${stageId}`,
      () => renamePipelineStageAction({ tenantId, stageId, ...patch }),
      "Stage updated.",
    );

  const moveStage = async (
    pipeline: PipelineListItem,
    stageId: string,
    direction: -1 | 1,
  ) => {
    const stages = [...pipeline.stages];
    const index = stages.findIndex((stage) => stage.id === stageId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= stages.length) return;
    [stages[index], stages[target]] = [stages[target]!, stages[index]!];
    // A reorder is the FULL permutation of the pipeline's current stage ids.
    await runAction(
      `reorder-${pipeline.id}`,
      () =>
        reorderPipelineStagesAction({
          tenantId,
          pipelineId: pipeline.id,
          stageIds: stages.map((stage) => stage.id),
        }),
      "Stages reordered.",
    );
  };

  const confirmDeleteStage = async () => {
    if (!deletingStage) return;
    setIsDeletingStage(true);
    try {
      const result = await deletePipelineStageAction({
        tenantId,
        stageId: deletingStage.stage.id,
      });
      if (result.success) {
        setFlash("Stage deleted.");
        setDeletingStage(null);
        await load();
      } else {
        // e.g. "This stage still has N lead(s)…" — the guard is the message.
        setError(result.error || "Failed to delete the stage.");
      }
    } catch {
      setError("Something went wrong while deleting the stage.");
    } finally {
      setIsDeletingStage(false);
    }
  };

  const canWrite = canManage && !readonly;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Show archived pipelines"
            value={includeArchived ? "all" : "live"}
            onChange={(e) => setIncludeArchived(e.target.value === "all")}
            className="w-44"
          >
            <option value="all">With archived</option>
            <option value="live">Active only</option>
          </Select>
          {canWrite ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New pipeline
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {flash ? (
        <div className="text-sm text-success-foreground" role="status">
          {flash}
        </div>
      ) : null}

      {!canManage ? (
        <p className="text-xs text-muted-foreground">
          You can view pipelines; only owners and admins can change them.
        </p>
      ) : null}

      {isLoading ? (
        <LoadingState label="Loading pipelines" />
      ) : pipelines.length === 0 ? (
        <EmptyState
          title="No pipelines"
          description="A pipeline gives the leads board its columns. The first pipeline becomes the default; win and loss stages are guaranteed by the engine."
        />
      ) : (
        <div className="space-y-6">
          {pipelines.map((pipeline) => (
            <PipelineEditor
              key={`${pipeline.id}-${pipeline.archivedAt ? "a" : "l"}`}
              pipeline={pipeline}
              canWrite={canWrite}
              busyKey={busyKey}
              onRename={(name) => renamePipeline(pipeline.id, name)}
              onArchive={(archived) => setArchived(pipeline, archived)}
              onAddStage={(name, isWin, isLost) =>
                addStage(pipeline.id, name, isWin, isLost)
              }
              onRenameStage={(stageId, patch) => renameStage(stageId, patch)}
              onMoveStage={(stageId, direction) =>
                moveStage(pipeline, stageId, direction)
              }
              onDeleteStage={(stage) => setDeletingStage({ stage, pipeline })}
              isBusy={(key) => busyKey === key}
            />
          ))}
        </div>
      )}

      {canViewLeads ? (
        <p className="text-sm text-muted-foreground">
          Moving leads between stages happens on the{" "}
          <Link
            href={`/${locale}/app/leads`}
            className="text-primary hover:underline"
          >
            leads board
          </Link>
          .
        </p>
      ) : null}

      {showCreate ? (
        <CreatePipelineDialog
          tenantId={tenantId}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            setFlash("Pipeline created.");
            await load();
          }}
        />
      ) : null}

      {deletingStage ? (
        <ConfirmDialog
          title="Delete stage"
          description={`Delete “${deletingStage.stage.name}” from ${deletingStage.pipeline.name}? The engine refuses while leads still sit on this stage and says so.`}
          confirmLabel="Delete stage"
          variant="danger"
          isLoading={isDeletingStage}
          onConfirm={confirmDeleteStage}
          onCancel={() => setDeletingStage(null)}
        />
      ) : null}
    </div>
  );
}

function PipelineEditor({
  pipeline,
  canWrite,
  busyKey,
  onRename,
  onArchive,
  onAddStage,
  onRenameStage,
  onMoveStage,
  onDeleteStage,
  isBusy,
}: {
  pipeline: PipelineListItem;
  canWrite: boolean;
  busyKey: string | null;
  onRename: (name: string) => Promise<boolean>;
  onArchive: (archived: boolean) => Promise<unknown>;
  onAddStage: (
    name: string,
    isWin: boolean,
    isLost: boolean,
  ) => Promise<unknown>;
  onRenameStage: (
    stageId: string,
    patch: { name?: string; isWin?: boolean; isLost?: boolean },
  ) => Promise<unknown>;
  onMoveStage: (stageId: string, direction: -1 | 1) => Promise<unknown>;
  onDeleteStage: (stage: StageRow) => void;
  isBusy: (key: string) => boolean;
}) {
  const [name, setName] = React.useState(pipeline.name);
  const [newStageName, setNewStageName] = React.useState("");
  const [newStageKind, setNewStageKind] = React.useState<
    "neutral" | "win" | "lost"
  >("neutral");

  const archived = pipeline.archivedAt !== null;

  return (
    <div
      className={cn(
        "card p-4 space-y-4",
        archived && "opacity-70 border-dashed",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Input
            aria-label="Pipeline name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim();
              if (trimmed && trimmed !== pipeline.name) {
                void onRename(trimmed);
              } else {
                setName(pipeline.name);
              }
            }}
            disabled={!canWrite}
            className="w-56 font-semibold"
            maxLength={100}
          />
          {pipeline.isDefault ? <Badge tone="primary">Default</Badge> : null}
          {archived ? <Badge tone="neutral">Archived</Badge> : null}
        </div>
        {canWrite ? (
          <Button
            variant="outline"
            size="sm"
            disabled={isBusy(`archive-${pipeline.id}`)}
            onClick={() => void onArchive(!archived)}
          >
            {archived ? (
              <ArchiveRestore className="h-4 w-4 mr-2" />
            ) : (
              <Archive className="h-4 w-4 mr-2" />
            )}
            {archived ? "Restore" : "Archive"}
          </Button>
        ) : null}
      </div>

      <ol className="space-y-2">
        {pipeline.stages.map((stage, index) => (
          <li
            key={stage.id}
            className="flex flex-wrap items-center gap-2 rounded-md border p-2"
          >
            <Input
              aria-label={`Stage ${index + 1} name`}
              defaultValue={stage.name}
              disabled={!canWrite}
              maxLength={100}
              className="w-48"
              onBlur={(e) => {
                const trimmed = e.target.value.trim();
                if (trimmed && trimmed !== stage.name) {
                  void onRenameStage(stage.id, { name: trimmed });
                }
              }}
            />
            <select
              aria-label={`Outcome of ${stage.name}`}
              value={stage.isWin ? "win" : stage.isLost ? "lost" : "neutral"}
              disabled={!canWrite}
              className="h-9 rounded-md border border-input bg-card px-2 text-sm"
              onChange={(e) => {
                const kind = e.target.value;
                void onRenameStage(stage.id, {
                  isWin: kind === "win",
                  isLost: kind === "lost",
                });
              }}
            >
              <option value="neutral">In progress</option>
              <option value="win">Won</option>
              <option value="lost">Lost</option>
            </select>
            {stage._count.leads > 0 ? (
              <Badge tone="info">
                {stage._count.leads} open lead
                {stage._count.leads === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {canWrite && !archived ? (
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Move stage earlier"
                  disabled={index === 0 || isBusy(`reorder-${pipeline.id}`)}
                  onClick={() => void onMoveStage(stage.id, -1)}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Move stage later"
                  disabled={
                    index === pipeline.stages.length - 1 ||
                    isBusy(`reorder-${pipeline.id}`)
                  }
                  onClick={() => void onMoveStage(stage.id, 1)}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete stage"
                  disabled={isBusy(`stage-${stage.id}`)}
                  onClick={() => onDeleteStage(stage)}
                >
                  {isBusy(`stage-${stage.id}`) ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 text-destructive" />
                  )}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      {canWrite && !archived ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = newStageName.trim();
            if (!trimmed) return;
            void onAddStage(
              trimmed,
              newStageKind === "win",
              newStageKind === "lost",
            ).then(() => setNewStageName(""));
          }}
        >
          <Field label="New stage" className="w-48">
            <Input
              value={newStageName}
              onChange={(e) => setNewStageName(e.target.value)}
              maxLength={100}
              placeholder="e.g. Demo scheduled"
            />
          </Field>
          <Field label="Outcome" className="w-40">
            <Select
              value={newStageKind}
              onChange={(e) =>
                setNewStageKind(e.target.value as "neutral" | "win" | "lost")
              }
            >
              <option value="neutral">In progress</option>
              <option value="win">Won</option>
              <option value="lost">Lost</option>
            </Select>
          </Field>
          <Button type="submit" size="sm" disabled={busyKey !== null}>
            <Plus className="h-4 w-4 mr-1" />
            Add stage
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function CreatePipelineDialog({
  tenantId,
  onClose,
  onCreated,
}: {
  tenantId: string;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const [name, setName] = React.useState("");
  const [stageNames, setStageNames] = React.useState<string[]>([]);
  const [draftStage, setDraftStage] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<
    Record<string, string[]> | undefined
  >(undefined);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors(undefined);
    try {
      const result = await createPipelineAction({
        tenantId,
        name: name.trim(),
        ...(stageNames.length > 0
          ? {
              stages: stageNames.map((stageName) => ({
                name: stageName,
                isWin: false,
                isLost: false,
              })),
            }
          : {}),
      });
      if (!result.success) {
        setError(result.error || "Failed to create the pipeline.");
        setFieldErrors(result.fieldErrors);
        return;
      }
      await onCreated();
    } catch {
      setError("Something went wrong while creating the pipeline.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
          <DialogDescription>
            The engine appends a win and a loss stage automatically, and the
            first pipeline in the workspace becomes the default.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <Field label="Name" required error={fieldErrors?.name?.[0]}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-medium">Stages (optional)</p>
            {stageNames.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Leave empty for the engine’s default board; win/loss stages are
                always guaranteed.
              </p>
            ) : (
              <ul className="space-y-1">
                {stageNames.map((stageName, index) => (
                  <li
                    key={`${stageName}-${index}`}
                    className="flex items-center justify-between rounded-md border px-2 py-1 text-sm"
                  >
                    {stageName}
                    <button
                      type="button"
                      className="text-xs text-destructive hover:underline"
                      onClick={() =>
                        setStageNames((current) =>
                          current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                value={draftStage}
                onChange={(e) => setDraftStage(e.target.value)}
                maxLength={100}
                placeholder="Stage name"
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const trimmed = draftStage.trim();
                  if (trimmed) {
                    setStageNames((current) => [...current, trimmed]);
                    setDraftStage("");
                  }
                }}
              >
                Add
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Create pipeline
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
