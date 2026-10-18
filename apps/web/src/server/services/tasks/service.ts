import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { appendActivity } from "@/server/services/activities/service";
import type {
  CreateTaskInput,
  TaskQueryInput,
  UpdateTaskInput,
} from "@/lib/validations/task";
import {
  assertActiveTenantMember,
  CRM_AUDIT_ACTIONS,
  CrmServiceError,
} from "../leads/service";

/**
 * Tasks (AGENT 02 Phase 2A).
 *
 *  - A task always belongs to something: the create payload's participant
 *    rule (at least one of lead/contact/document) is mirrored by the DB
 *    CHECK, and each submitted id is re-resolved against the authorized
 *    tenant before it persists.
 *  - The assignee must be an ACTIVE member of this tenant — proven through
 *    `TenantMember` (plus `User.status`), never assumed from a session.
 *  - Completion is an action, not a field: `completedAt` moves only through
 *    complete/reopen, each appending its timeline event.
 *  - Overdue is a READ-side derivation (`dueAt < now && !completedAt`);
 *    nothing stores or cron-marks it, per the design's "no jobs" rule.
 */

export type TaskRow = Prisma.TaskGetPayload<Record<string, never>>;

export type TaskWithOverdue = TaskRow & {
  /** Derived at read time; never a stored column. */
  readonly overdue: boolean;
};

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Every participant id must resolve inside the authorized tenant. */
async function assertParticipantsInTenant(
  authz: TenantAuthzContext,
  participants: {
    leadId?: string | null | undefined;
    contactId?: string | null | undefined;
    documentId?: string | null | undefined;
  },
): Promise<void> {
  if (participants.leadId) {
    const lead = await prisma.lead.findFirst({
      where: { id: participants.leadId, tenantId: authz.tenantId },
      select: { id: true },
    });
    if (!lead) {
      throw new CrmServiceError(
        "VALIDATION",
        "The selected lead does not exist in this business.",
        "leadId",
      );
    }
  }
  if (participants.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: participants.contactId, tenantId: authz.tenantId },
      select: { id: true },
    });
    if (!contact) {
      throw new CrmServiceError(
        "VALIDATION",
        "The selected customer does not exist in this business.",
        "contactId",
      );
    }
  }
  if (participants.documentId) {
    const document = await prisma.document.findFirst({
      where: { id: participants.documentId, tenantId: authz.tenantId },
      select: { id: true },
    });
    if (!document) {
      throw new CrmServiceError(
        "VALIDATION",
        "The selected document does not exist in this business.",
        "documentId",
      );
    }
  }
}

async function loadTaskOrThrow(
  authz: TenantAuthzContext,
  taskId: string,
): Promise<TaskRow> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, tenantId: authz.tenantId },
  });
  if (!task) {
    throw new CrmServiceError("NOT_FOUND", "Task not found.");
  }
  return task;
}

function deriveOverdue(
  task: TaskRow,
  now: number = Date.now(),
): TaskWithOverdue {
  return {
    ...task,
    overdue:
      task.dueAt !== null &&
      task.completedAt === null &&
      task.dueAt.getTime() < now,
  };
}

export async function createTask(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreateTaskInput, "tenantId">,
): Promise<TaskWithOverdue> {
  // The zod refine guarantees at least one participant; the service still
  // proves each submitted id lives in this tenant.
  await assertParticipantsInTenant(authz, {
    leadId: input.leadId,
    contactId: input.contactId,
    documentId: input.documentId,
  });
  if (input.assigneeId) {
    await assertActiveTenantMember(authz, input.assigneeId, "assigneeId");
  }

  const task = await prisma.task.create({
    data: {
      tenantId: authz.tenantId,
      title: input.title.trim(),
      notes: text(input.notes),
      ...(input.dueAt !== undefined && input.dueAt !== null
        ? { dueAt: input.dueAt }
        : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assigneeId !== undefined && input.assigneeId !== null
        ? { assigneeId: input.assigneeId }
        : {}),
      ...(input.leadId !== undefined && input.leadId !== null
        ? { leadId: input.leadId }
        : {}),
      ...(input.contactId !== undefined && input.contactId !== null
        ? { contactId: input.contactId }
        : {}),
      ...(input.documentId !== undefined && input.documentId !== null
        ? { documentId: input.documentId }
        : {}),
      // `completedAt` is intentionally absent — completion is an action.
    },
  });

  await appendActivity(authz, actorId, {
    eventType: "TASK_CREATED",
    taskId: task.id,
    leadId: task.leadId,
    contactId: task.contactId,
    documentId: task.documentId,
    payload: { priority: task.priority },
    source: "service:tasks.create",
    sourceKey: `task:${task.id}:created`,
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.TASK_CREATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Task",
    resourceId: task.id,
    metadata: {
      priority: task.priority,
      participants: {
        leadId: task.leadId,
        contactId: task.contactId,
        documentId: task.documentId,
      },
    },
  });

  return deriveOverdue(task);
}

export async function updateTask(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<UpdateTaskInput, "tenantId">,
): Promise<TaskWithOverdue> {
  await loadTaskOrThrow(authz, input.taskId);
  if (input.assigneeId) {
    await assertActiveTenantMember(authz, input.assigneeId, "assigneeId");
  }

  // Unchecked form: the FK scalars were already resolved against the tenant
  // (`assertActiveTenantMember` / `assertParticipantsInTenant`), so writing
  // the scalar columns directly is the tenant-pinned path — the relation
  // input would re-open the connect-by-id surface this file avoids.
  const data: Prisma.TaskUncheckedUpdateInput = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.notes !== undefined) data.notes = text(input.notes);
  if (input.dueAt !== undefined) data.dueAt = input.dueAt ?? null;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.assigneeId !== undefined) {
    data.assigneeId = input.assigneeId ?? null;
  }

  const result = await prisma.task.updateMany({
    where: { id: input.taskId, tenantId: authz.tenantId },
    data,
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Task not found.");
  }

  await appendActivity(authz, actorId, {
    eventType: "TASK_UPDATED",
    taskId: input.taskId,
    payload: { fields: Object.keys(data) },
    source: "service:tasks.update",
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.TASK_UPDATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Task",
    resourceId: input.taskId,
    metadata: { fields: Object.keys(data) },
  });

  return deriveOverdue(await loadTaskOrThrow(authz, input.taskId));
}

/** Completing sets `completedAt`; the timeline event is replay-deduped. */
export async function completeTask(
  authz: TenantAuthzContext,
  actorId: string,
  taskId: string,
): Promise<TaskWithOverdue> {
  const task = await loadTaskOrThrow(authz, taskId);
  if (task.completedAt !== null) {
    throw new CrmServiceError("CONFLICT", "This task is already completed.");
  }

  const completedAt = new Date();
  const result = await prisma.task.updateMany({
    where: { id: taskId, tenantId: authz.tenantId },
    data: { completedAt },
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Task not found.");
  }

  await appendActivity(authz, actorId, {
    eventType: "TASK_COMPLETED",
    taskId,
    leadId: task.leadId,
    contactId: task.contactId,
    documentId: task.documentId,
    source: "service:tasks.complete",
    sourceKey: `task:${taskId}:completed`,
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.TASK_COMPLETED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Task",
    resourceId: taskId,
  });

  return deriveOverdue(await loadTaskOrThrow(authz, taskId));
}

/** Reopening clears `completedAt`; only a completed task reopens. */
export async function reopenTask(
  authz: TenantAuthzContext,
  actorId: string,
  taskId: string,
): Promise<TaskWithOverdue> {
  const task = await loadTaskOrThrow(authz, taskId);
  if (task.completedAt === null) {
    throw new CrmServiceError(
      "VALIDATION",
      "This task is not completed, so there is nothing to reopen.",
    );
  }

  const result = await prisma.task.updateMany({
    where: { id: taskId, tenantId: authz.tenantId },
    data: { completedAt: null },
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Task not found.");
  }

  await appendActivity(authz, actorId, {
    eventType: "TASK_REOPENED",
    taskId,
    source: "service:tasks.reopen",
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.TASK_REOPENED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Task",
    resourceId: taskId,
  });

  return deriveOverdue(await loadTaskOrThrow(authz, taskId));
}

export async function deleteTask(
  authz: TenantAuthzContext,
  actorId: string,
  taskId: string,
): Promise<void> {
  const task = await loadTaskOrThrow(authz, taskId);
  await prisma.task.delete({ where: { id: task.id } });

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.TASK_DELETED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Task",
    resourceId: taskId,
    // Ids and enums only — the task title is user content and stays out of
    // the audit trail.
    metadata: {
      priority: task.priority,
      participants: {
        leadId: task.leadId,
        contactId: task.contactId,
        documentId: task.documentId,
      },
    },
  });
}

/** Filtered, paginated task list; overdue is derived per row at read time. */
export async function listTasks(
  authz: TenantAuthzContext,
  query: Omit<TaskQueryInput, "tenantId">,
): Promise<{ tasks: TaskWithOverdue[]; total: number }> {
  const now = new Date();
  const where: Prisma.TaskWhereInput = {
    tenantId: authz.tenantId,
    ...(query.leadId ? { leadId: query.leadId } : {}),
    ...(query.contactId ? { contactId: query.contactId } : {}),
    ...(query.documentId ? { documentId: query.documentId } : {}),
    ...(query.assigneeId
      ? query.assigneeId === "unassigned"
        ? { assigneeId: null }
        : { assigneeId: query.assigneeId }
      : {}),
    ...(query.status === "OPEN" ? { completedAt: null } : {}),
    ...(query.status === "COMPLETED" ? { completedAt: { not: null } } : {}),
    ...(query.status === "OVERDUE"
      ? { completedAt: null, dueAt: { lt: now } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.task.count({ where }),
  ]);

  const nowMs = now.getTime();
  return {
    tasks: rows.map((task) => deriveOverdue(task, nowMs)),
    total,
  };
}

/** Single task read with the same overdue derivation; used by detail views. */
export async function getTaskDetail(
  authz: TenantAuthzContext,
  taskId: string,
): Promise<TaskWithOverdue> {
  return deriveOverdue(await loadTaskOrThrow(authz, taskId));
}
