"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Textarea } from "@amisibiz/ui/textarea";
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
  completeTaskAction,
  createTaskAction,
  deleteTaskAction,
  getTasksAction,
  reopenTaskAction,
} from "@/server/actions/task";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  Circle,
  Clock,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";

/**
 * Reusable task panel for the lead 360 / customer 360 surfaces.
 *
 * Tasks always hang off something, and this panel is that something: it is
 * mounted with exactly one of `leadId` / `contactId` / `documentId` and every
 * create carries that same link. Completion and reopening are their own
 * audited actions — the panel never patches `completedAt` through the edit
 * form. Reads need TASKS_READ, mutations TASKS_MANAGE, and the caller passes
 * both flags down from the role matrix; a read-only viewer sees no buttons.
 */

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  dueAt: Date | string | null;
  completedAt: Date | string | null;
  priority: "LOW" | "MEDIUM" | "HIGH";
  overdue: boolean;
  createdAt: Date | string;
};

interface TaskPanelProps {
  tenantId: string;
  leadId?: string | undefined;
  contactId?: string | undefined;
  documentId?: string | undefined;
  canRead: boolean;
  canManage: boolean;
  locale?: string | undefined;
  className?: string | undefined;
}

const PAGE_SIZE = 50;

export function TaskPanel({
  tenantId,
  leadId,
  contactId,
  documentId,
  canRead,
  canManage,
  locale = "en",
  className,
}: TaskPanelProps) {
  const [tasks, setTasks] = React.useState<TaskRow[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<
    "OPEN" | "COMPLETED" | ""
  >("");
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [deletingTask, setDeletingTask] = React.useState<TaskRow | null>(null);
  const [busyTaskId, setBusyTaskId] = React.useState<string | null>(null);

  const fetchTasks = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getTasksAction({
        tenantId,
        ...(leadId ? { leadId } : {}),
        ...(contactId ? { contactId } : {}),
        ...(documentId ? { documentId } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        page: 1,
        pageSize: PAGE_SIZE,
      });
      if (!result.success) {
        setError(result.error || "Failed to load tasks.");
        return;
      }
      if (result.data) setTasks(result.data.tasks);
    } catch {
      setError("Something went wrong while loading tasks.");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, leadId, contactId, documentId, statusFilter]);

  React.useEffect(() => {
    if (canRead) void fetchTasks();
    else setIsLoading(false);
  }, [canRead, fetchTasks]);

  const runOnTask = async (
    task: TaskRow,
    action: (input: {
      tenantId: string;
      taskId: string;
    }) => Promise<ActionResult<unknown>>,
    verb: string,
  ) => {
    setBusyTaskId(task.id);
    setError(null);
    try {
      const result = await action({ tenantId, taskId: task.id });
      if (!result.success)
        setError(result.error || `Failed to ${verb} the task.`);
      await fetchTasks();
    } catch {
      setError(`Something went wrong while trying to ${verb} the task.`);
    } finally {
      setBusyTaskId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deletingTask) return;
    setError(null);
    try {
      const result = await deleteTaskAction({
        tenantId,
        taskId: deletingTask.id,
      });
      if (result.success) {
        setDeletingTask(null);
        await fetchTasks();
      } else {
        setError(result.error || "Failed to delete the task.");
      }
    } catch {
      setError("Something went wrong while deleting the task.");
    }
  };

  if (!canRead) {
    return (
      <div className={className}>
        <EmptyState
          title="Tasks are hidden"
          description="This account cannot read tasks. Ask an owner for TASKS_READ access."
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          aria-label="Filter tasks by status"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(
              e.target.value === "OPEN" || e.target.value === "COMPLETED"
                ? e.target.value
                : "",
            )
          }
          className="w-40"
        >
          <option value="">All tasks</option>
          <option value="OPEN">Open</option>
          <option value="COMPLETED">Completed</option>
        </Select>
        {canManage ? (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New task
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <LoadingState label="Loading tasks" />
      ) : tasks.length === 0 ? (
        <EmptyState
          title="No tasks"
          description={
            statusFilter
              ? "No tasks match this filter."
              : "Nothing is being worked on for this record yet."
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {tasks.map((task) => {
            const completed = task.completedAt !== null;
            return (
              <li
                key={task.id}
                className="flex items-start justify-between gap-3 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      className={cn(
                        "text-sm font-medium",
                        completed && "line-through text-muted-foreground",
                      )}
                    >
                      {task.title}
                    </p>
                    {task.priority === "HIGH" ? (
                      <Badge tone="danger">High</Badge>
                    ) : task.priority === "LOW" ? (
                      <Badge tone="neutral">Low</Badge>
                    ) : (
                      <Badge tone="info">Medium</Badge>
                    )}
                    {completed ? (
                      <Badge tone="success">Completed</Badge>
                    ) : task.overdue ? (
                      <Badge tone="warning">Overdue</Badge>
                    ) : null}
                  </div>
                  {task.notes ? (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                      {task.notes}
                    </p>
                  ) : null}
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {task.dueAt
                      ? `Due ${new Date(task.dueAt).toLocaleDateString(locale)}`
                      : "No due date"}
                  </p>
                </div>
                {canManage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {completed ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Reopen task"
                        title="Reopen"
                        disabled={busyTaskId === task.id}
                        onClick={() =>
                          void runOnTask(task, reopenTaskAction, "reopen")
                        }
                      >
                        <Circle className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Complete task"
                        title="Complete"
                        disabled={busyTaskId === task.id}
                        onClick={() =>
                          void runOnTask(task, completeTaskAction, "complete")
                        }
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete task"
                      title="Delete"
                      disabled={busyTaskId === task.id}
                      onClick={() => setDeletingTask(task)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {deletingTask ? (
        <ConfirmDialog
          title="Delete task"
          description={`Delete "${deletingTask.title}"? The activity trail keeps its history.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingTask(null)}
          isLoading={busyTaskId === deletingTask.id}
          confirmLabel="Delete"
          variant="danger"
        />
      ) : null}

      {showCreate ? (
        <CreateTaskDialog
          tenantId={tenantId}
          leadId={leadId}
          contactId={contactId}
          documentId={documentId}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await fetchTasks();
          }}
        />
      ) : null}
    </div>
  );
}

interface CreateTaskDialogProps {
  tenantId: string;
  leadId?: string | undefined;
  contactId?: string | undefined;
  documentId?: string | undefined;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}

function CreateTaskDialog({
  tenantId,
  leadId,
  contactId,
  documentId,
  onClose,
  onCreated,
}: CreateTaskDialogProps) {
  const [title, setTitle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [priority, setPriority] = React.useState<"LOW" | "MEDIUM" | "HIGH">(
    "MEDIUM",
  );
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
      const result = await createTaskAction({
        tenantId,
        title: title.trim(),
        notes: notes.trim() || undefined,
        priority,
        ...(dueAt
          ? { dueAt: new Date(`${dueAt}T17:00:00`).toISOString() }
          : {}),
        ...(leadId ? { leadId } : {}),
        ...(contactId ? { contactId } : {}),
        ...(documentId ? { documentId } : {}),
      });
      if (!result.success) {
        setError(result.error || "Failed to create the task.");
        setFieldErrors(result.fieldErrors);
        return;
      }
      await onCreated();
    } catch {
      setError("Something went wrong while creating the task.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            A task always belongs to this record; it cannot be retargeted later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <Field label="Title" required error={fieldErrors?.title?.[0]}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
            />
          </Field>
          <Field label="Notes" error={fieldErrors?.notes?.[0]}>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={3}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Due date" error={fieldErrors?.dueAt?.[0]}>
              <Input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </Field>
            <Field label="Priority">
              <Select
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as "LOW" | "MEDIUM" | "HIGH")
                }
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <XCircle className="h-4 w-4 mr-2 animate-pulse" />
              ) : null}
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
