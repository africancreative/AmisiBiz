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
  createTaskSchema,
  taskLocatorSchema,
  taskQuerySchema,
  updateTaskSchema,
} from "@/lib/validations/task";
import {
  CrmServiceError,
  crmErrorActionCode,
} from "@/server/services/leads/service";
import {
  completeTask,
  createTask,
  deleteTask,
  listTasks,
  reopenTask,
  updateTask,
  type TaskWithOverdue,
} from "@/server/services/tasks/service";

/**
 * Task Server Actions (AGENT 02 Phase 2A).
 *
 * Permission wiring (design spec §1.6): reads are TASKS_READ, every mutation
 * (create/update/complete/reopen/delete) is TASKS_MANAGE. There is deliberately
 * no TASKS_UPDATE verb in the matrix, and no per-actor "my tasks" gate: the
 * list surface exposes an `assigneeId` filter instead.
 *
 * The engine behind these actions keeps the invariants: at least one
 * participant (lead/contact/document, all re-resolved inside the authorized
 * tenant), an ACTIVE tenant membership for the assignee, completion as an
 * action, and OVERDUE derived on the read side — never stored.
 */

function taskActionFailure(
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

export async function getTasksAction(rawInput: unknown): Promise<
  ActionResult<{
    tasks: TaskWithOverdue[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = taskQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.TASKS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getTasksAction");
  }

  try {
    const { tasks, total } = await listTasks(context, query);
    return {
      success: true,
      data: {
        tasks,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    return taskActionFailure(err, "getTasksAction");
  }
}

/* -------------------------------- writes ------------------------------------ */

export async function createTaskAction(
  rawInput: unknown,
): Promise<ActionResult<{ task: TaskWithOverdue }>> {
  const session = await requireAuth();

  const parsed = createTaskSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.TASKS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "createTaskAction");
  }

  try {
    const task = await createTask(context, session.user.id, data);
    return { success: true, data: { task } };
  } catch (err) {
    return taskActionFailure(err, "createTaskAction");
  }
}

/** Participant links are immutable; this edits the task's own facts only. */
export async function updateTaskAction(
  rawInput: unknown,
): Promise<ActionResult<{ task: TaskWithOverdue }>> {
  const session = await requireAuth();

  const parsed = updateTaskSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.TASKS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateTaskAction");
  }

  try {
    const task = await updateTask(context, session.user.id, data);
    return { success: true, data: { task } };
  } catch (err) {
    return taskActionFailure(err, "updateTaskAction");
  }
}

export async function completeTaskAction(
  rawInput: unknown,
): Promise<ActionResult<{ task: TaskWithOverdue }>> {
  const session = await requireAuth();

  const parsed = taskLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, taskId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.TASKS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "completeTaskAction");
  }

  try {
    const task = await completeTask(context, session.user.id, taskId);
    return { success: true, data: { task } };
  } catch (err) {
    return taskActionFailure(err, "completeTaskAction");
  }
}

export async function reopenTaskAction(
  rawInput: unknown,
): Promise<ActionResult<{ task: TaskWithOverdue }>> {
  const session = await requireAuth();

  const parsed = taskLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, taskId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.TASKS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "reopenTaskAction");
  }

  try {
    const task = await reopenTask(context, session.user.id, taskId);
    return { success: true, data: { task } };
  } catch (err) {
    return taskActionFailure(err, "reopenTaskAction");
  }
}

export async function deleteTaskAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = taskLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, taskId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.TASKS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "deleteTaskAction");
  }

  try {
    await deleteTask(context, session.user.id, taskId);
    return { success: true };
  } catch (err) {
    return taskActionFailure(err, "deleteTaskAction");
  }
}
