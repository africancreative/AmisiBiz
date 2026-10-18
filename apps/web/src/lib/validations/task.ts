import { z } from "zod";
import { leadPrioritySchema } from "./lead";

/**
 * Task validation (AGENT 02 Phase 2A).
 *
 * The one structural rule of the `Task` model — a task always belongs to
 * something — is enforced here: at least one of `leadId` / `contactId` /
 * `documentId` must be present (the migration carries the matching CHECK
 * constraint, so the two layers cannot drift). The ids are links the service
 * re-resolves against the authorized tenant; a foreign id fails as validation,
 * not as a cross-tenant write.
 *
 * Server-owned fields (`id`, `revision`, `completedAt`) are absent from every
 * payload: completion is an action, not a field edit.
 */

const tenantId = z.string().uuid("Invalid tenant ID");
const taskId = z.string().uuid("Invalid task ID");

const participantIds = {
  leadId: z.string().uuid("Invalid lead ID").nullish(),
  contactId: z.string().uuid("Invalid contact ID").nullish(),
  documentId: z.string().uuid("Invalid document ID").nullish(),
};

/** At least one participant must be set on a create. */
export const createTaskSchema = z
  .object({
    tenantId,
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(200, "Keep the title under 200 characters"),
    notes: z.string().max(2000).optional().or(z.literal("")),
    dueAt: z.coerce.date().nullish(),
    priority: leadPrioritySchema.optional(),
    /** The service proves the assignee is an ACTIVE member of the tenant. */
    assigneeId: z.string().uuid("Invalid user ID").nullish(),
    ...participantIds,
  })
  .superRefine((data, ctx) => {
    const hasParticipant =
      (data.leadId !== undefined && data.leadId !== null) ||
      (data.contactId !== undefined && data.contactId !== null) ||
      (data.documentId !== undefined && data.documentId !== null);
    if (!hasParticipant) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A task must reference at least one lead, contact or document",
        path: ["leadId"],
      });
    }
  });

/**
 * A patch update of the task's own facts. The participant links are immutable
 * after creation — retargeting a task at another customer is a new task, not
 * an edit, and it keeps the DB CHECK ("at least one participant") trivially
 * satisfied by the stored row.
 */
export const updateTaskSchema = z.object({
  tenantId,
  taskId,
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(200, "Keep the title under 200 characters")
    .optional(),
  notes: z.string().max(2000).optional().or(z.literal("")),
  dueAt: z.coerce.date().nullish(),
  priority: leadPrioritySchema.optional(),
  assigneeId: z.string().uuid("Invalid user ID").nullish(),
});

export const taskLocatorSchema = z.object({ tenantId, taskId });

export const taskStatusFilters = ["OPEN", "COMPLETED", "OVERDUE"] as const;
export const taskQuerySchema = z.object({
  tenantId,
  leadId: z.string().uuid("Invalid lead ID").optional(),
  contactId: z.string().uuid("Invalid contact ID").optional(),
  documentId: z.string().uuid("Invalid document ID").optional(),
  assigneeId: z
    .union([z.string().uuid("Invalid user ID"), z.literal("unassigned")])
    .optional(),
  status: z.enum(taskStatusFilters).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

export const timelineQuerySchema = z.object({
  tenantId,
  contactId: z.string().uuid("Invalid contact ID").optional(),
  leadId: z.string().uuid("Invalid lead ID").optional(),
  documentId: z.string().uuid("Invalid document ID").optional(),
  limit: z.number().int().positive().max(200).default(50),
  before: z.coerce.date().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskLocatorInput = z.infer<typeof taskLocatorSchema>;
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;
export type TimelineQueryInput = z.infer<typeof timelineQuerySchema>;
