import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import type { ActionErrorCode } from "@/lib/errors";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { appendActivity } from "@/server/services/activities/service";
import type {
  CreateLeadInput,
  LeadQueryInput,
  UpdateLeadInput,
} from "@/lib/validations/lead";
import {
  findDuplicateLeads,
  normalizeEmail,
  type DuplicateSuspect,
} from "./dedupe";

/**
 * The leads engine (AGENT 02 Phase 2A).
 *
 * Contract shared with `services/documents/service.ts`, which it mirrors:
 *
 *  - Every function takes the `TenantAuthzContext` the Server Action already
 *    authorized (`authorizeTenant` checked the permission and opened the RLS
 *    scope) and treats `authz.tenantId` as the ONLY tenant it will read or
 *    write. There is no `tenantId` parameter to forge.
 *  - Status is never a free-form field: NEW→(stage moves)→CONVERTED|LOST is
 *    driven by the dedicated operations here (move / lose / reopen / convert),
 *    and CONVERTED / LOST are terminal.
 *  - Duplicate suspects are surfaced, never enforced: `createLead` returns the
 *    scored candidates beside the created row and stores the lead anyway.
 *    Only the (tenantId, idempotencyKey) and (tenantId, source, externalId)
 *    uniques can stop a second row, and when they fire the replay returns the
 *    original lead with `created: false` — that is the retry story, end to end.
 *  - Every mutation appends exactly one `ActivityEvent` through the single
 *    writer in `services/activities/service.ts` and one audit row. The audit
 *    metadata carries opaque ids and enum values only — never a name, email
 *    or phone (constitution: no PII in logs).
 */

/* --------------------------------- errors ---------------------------------- */

export type CrmServiceErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT";

/** Raised by the CRM services; the actions map it onto the ActionResult codes. */
export class CrmServiceError extends Error {
  readonly code: CrmServiceErrorCode;
  readonly field: string | undefined;

  constructor(code: CrmServiceErrorCode, message: string, field?: string) {
    super(message);
    this.name = "CrmServiceError";
    this.code = code;
    this.field = field;
  }
}

/** Maps a CRM service error onto the shared action error vocabulary. */
export function crmErrorActionCode(code: CrmServiceErrorCode): ActionErrorCode {
  switch (code) {
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "CONFLICT":
      return "CONFLICT";
    case "VALIDATION":
      return "VALIDATION_ERROR";
  }
}

/**
 * Canonical audit action names for the CRM surfaces. `lib/audit` is outside
 * this phase's file whitelist, so these are dotted-string literals following
 * the same vocabulary convention (`domain.event`); `recordAudit` accepts any
 * string action.
 */
export const CRM_AUDIT_ACTIONS = {
  LEAD_CREATED: "lead.created",
  LEAD_UPDATED: "lead.updated",
  LEAD_STAGE_MOVED: "lead.stageMoved",
  LEAD_ASSIGNED: "lead.assigned",
  LEAD_LOST: "lead.lost",
  LEAD_REOPENED: "lead.reopened",
  LEAD_CONVERTED: "lead.converted",
  PIPELINE_CREATED: "pipeline.created",
  PIPELINE_UPDATED: "pipeline.updated",
  PIPELINE_STAGE_ADDED: "pipeline.stageAdded",
  PIPELINE_STAGE_UPDATED: "pipeline.stageUpdated",
  PIPELINE_STAGE_DELETED: "pipeline.stageDeleted",
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_COMPLETED: "task.completed",
  TASK_REOPENED: "task.reopened",
  TASK_DELETED: "task.deleted",
} as const;

/* -------------------------------- helpers ---------------------------------- */

/** A plain `Lead` row as the ORM returns it without includes. */
export type LeadRow = Prisma.LeadGetPayload<Record<string, never>>;

const TERMINAL_STATUSES: ReadonlySet<LeadRow["status"]> = new Set([
  "CONVERTED",
  "LOST",
]);

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * A user is an actionable assignee only with an ACTIVE membership in this
 * tenant: the `TenantMember` row proves the seat and `User.status` proves the
 * account is live. Shared with the tasks service for the same rule.
 */
export async function assertActiveTenantMember(
  authz: TenantAuthzContext,
  userId: string,
  field: string,
): Promise<void> {
  const membership = await prisma.tenantMember.findFirst({
    where: { tenantId: authz.tenantId, userId, user: { status: "ACTIVE" } },
    select: { userId: true },
  });
  if (!membership) {
    throw new CrmServiceError(
      "VALIDATION",
      "The selected person is not an active member of this business.",
      field,
    );
  }
}

/** Proves a pipeline stage belongs to this tenant; returns its id. */
async function assertStageInTenant(
  authz: TenantAuthzContext,
  stageId: string,
  field: string,
): Promise<string> {
  const stage = await prisma.pipelineStage.findFirst({
    where: { id: stageId, tenantId: authz.tenantId },
    select: { id: true },
  });
  if (!stage) {
    throw new CrmServiceError(
      "VALIDATION",
      "The selected stage does not exist in this business.",
      field,
    );
  }
  return stage.id;
}

async function loadLeadOrThrow(
  authz: TenantAuthzContext,
  leadId: string,
): Promise<LeadRow> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, tenantId: authz.tenantId },
  });
  if (!lead) {
    // Never disclose whether the id exists in another tenant.
    throw new CrmServiceError("NOT_FOUND", "Lead not found.");
  }
  return lead;
}

/**
 * Explicit create-data builder: every stored column is named here, so a
 * payload key that was not validated (an `id`, a `status`, a forged
 * `tenantId`, a `convertedAt`) cannot ride through a spread into the row.
 */
function leadCreateData(
  authz: TenantAuthzContext,
  input: Omit<CreateLeadInput, "tenantId">,
): Prisma.LeadUncheckedCreateInput {
  return {
    tenantId: authz.tenantId,
    // `status` is intentionally absent: a captured lead is NEW by column
    // default; only the dedicated operations move it.
    source: input.source,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    firstName: text(input.firstName),
    lastName: text(input.lastName),
    companyName: text(input.companyName),
    // Emails are stored normalized so the dedupe equality is honest.
    email: normalizeEmail(input.email),
    phone: text(input.phone),
    description: text(input.description),
    currency: input.currency,
    ...(input.estimatedValue !== undefined && input.estimatedValue !== null
      ? { estimatedValue: new Prisma.Decimal(input.estimatedValue) }
      : {}),
    sourceDetail: text(input.sourceDetail),
    utmSource: text(input.utmSource),
    utmMedium: text(input.utmMedium),
    utmCampaign: text(input.utmCampaign),
    ...(input.pipelineStageId !== undefined && input.pipelineStageId !== null
      ? { pipelineStageId: input.pipelineStageId }
      : {}),
    ...(input.assignedToUserId !== undefined && input.assignedToUserId !== null
      ? { assignedToUserId: input.assignedToUserId }
      : {}),
    ...(input.contactId !== undefined && input.contactId !== null
      ? { contactId: input.contactId }
      : {}),
    ...(input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
    ...(input.externalId !== undefined
      ? { externalId: text(input.externalId) }
      : {}),
  };
}

/* ------------------------------- operations -------------------------------- */

export interface CreateLeadResult {
  readonly lead: LeadRow;
  /** False on an idempotent replay: the ORIGINAL lead is returned. */
  readonly created: boolean;
  readonly duplicateSuspects: DuplicateSuspect[];
}

/**
 * Captures a lead. Honors `idempotencyKey` (and the source/externalId unique)
 * by replaying the original row, scores duplicate suspects without ever
 * blocking the insert, and appends the LEAD_CREATED timeline event.
 */
export async function createLead(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreateLeadInput, "tenantId">,
): Promise<CreateLeadResult> {
  // Replay gates FIRST — an idempotent retry must not re-validate links the
  // original request already proved, and must return the same row.
  if (input.idempotencyKey) {
    const existing = await prisma.lead.findFirst({
      where: {
        tenantId: authz.tenantId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (existing) {
      return { lead: existing, created: false, duplicateSuspects: [] };
    }
  }
  if (input.externalId) {
    const existing = await prisma.lead.findFirst({
      where: {
        tenantId: authz.tenantId,
        source: input.source,
        externalId: text(input.externalId),
      },
    });
    if (existing) {
      return { lead: existing, created: false, duplicateSuspects: [] };
    }
  }

  // Placement links are proven against the tenant before they can persist.
  if (input.pipelineStageId) {
    await assertStageInTenant(authz, input.pipelineStageId, "pipelineStageId");
  }
  if (input.assignedToUserId) {
    await assertActiveTenantMember(
      authz,
      input.assignedToUserId,
      "assignedToUserId",
    );
  }
  if (input.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, tenantId: authz.tenantId },
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

  let lead: LeadRow;
  try {
    lead = await prisma.lead.create({ data: leadCreateData(authz, input) });
  } catch (error) {
    // Concurrent retry landed between the find and the create: the uniques
    // fired. Return the winner's row — the replay contract holds.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      (input.idempotencyKey || input.externalId)
    ) {
      const existing = input.idempotencyKey
        ? await prisma.lead.findFirst({
            where: {
              tenantId: authz.tenantId,
              idempotencyKey: input.idempotencyKey,
            },
          })
        : await prisma.lead.findFirst({
            where: {
              tenantId: authz.tenantId,
              source: input.source,
              externalId: text(input.externalId),
            },
          });
      if (existing) {
        return { lead: existing, created: false, duplicateSuspects: [] };
      }
    }
    throw error;
  }

  await appendActivity(authz, actorId, {
    eventType: "LEAD_CREATED",
    leadId: lead.id,
    payload: { source: lead.source, priority: lead.priority },
    source: "service:leads.create",
    sourceKey: `lead:${lead.id}:created`,
  });

  await recordAudit({
    action: CRM_AUDIT_ACTIONS.LEAD_CREATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Lead",
    resourceId: lead.id,
    // Ids and enums only — no contact details in the audit trail.
    metadata: { source: lead.source, priority: lead.priority },
  });

  // Duplicates are scored AFTER the insert and exclude the row just created:
  // the operator is shown candidates, nothing is blocked.
  const duplicateSuspects = await findDuplicateLeads(authz, {
    email: lead.email,
    phone: lead.phone,
    companyName: lead.companyName,
    excludeLeadId: lead.id,
  });

  return { lead, created: true, duplicateSuspects };
}

/** Free-form detail edit. Status, stage, assignment and terminal fields are
 *  not reachable here — they have their own operations. */
export async function updateLead(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<UpdateLeadInput, "tenantId">,
): Promise<LeadRow> {
  await loadLeadOrThrow(authz, input.leadId);

  const data: Prisma.LeadUpdateInput = {};
  if (input.firstName !== undefined) data.firstName = text(input.firstName);
  if (input.lastName !== undefined) data.lastName = text(input.lastName);
  if (input.companyName !== undefined) {
    data.companyName = text(input.companyName);
  }
  if (input.email !== undefined) data.email = normalizeEmail(input.email);
  if (input.phone !== undefined) data.phone = text(input.phone);
  if (input.description !== undefined) {
    data.description = text(input.description);
  }
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.estimatedValue !== undefined) {
    data.estimatedValue =
      input.estimatedValue === null
        ? null
        : new Prisma.Decimal(input.estimatedValue);
  }
  if (input.sourceDetail !== undefined) {
    data.sourceDetail = text(input.sourceDetail);
  }
  if (input.utmSource !== undefined) data.utmSource = text(input.utmSource);
  if (input.utmMedium !== undefined) data.utmMedium = text(input.utmMedium);
  if (input.utmCampaign !== undefined) {
    data.utmCampaign = text(input.utmCampaign);
  }

  const result = await prisma.lead.updateMany({
    where: { id: input.leadId, tenantId: authz.tenantId },
    data,
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Lead not found.");
  }

  await appendActivity(authz, actorId, {
    eventType: "LEAD_UPDATED",
    leadId: input.leadId,
    payload: { fields: Object.keys(data) },
    source: "service:leads.update",
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.LEAD_UPDATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Lead",
    resourceId: input.leadId,
    metadata: { fields: Object.keys(data) },
  });

  return loadLeadOrThrow(authz, input.leadId);
}

/** Moves a lead to another stage of its own tenant. Terminal leads are frozen. */
export async function moveLeadStage(
  authz: TenantAuthzContext,
  actorId: string,
  input: { leadId: string; stageId: string },
): Promise<LeadRow> {
  const lead = await loadLeadOrThrow(authz, input.leadId);
  if (TERMINAL_STATUSES.has(lead.status)) {
    throw new CrmServiceError(
      "CONFLICT",
      "A converted or lost lead no longer moves through the pipeline.",
    );
  }
  const stageId = await assertStageInTenant(authz, input.stageId, "stageId");

  const result = await prisma.lead.updateMany({
    where: { id: input.leadId, tenantId: authz.tenantId },
    data: { pipelineStageId: stageId },
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Lead not found.");
  }

  await appendActivity(authz, actorId, {
    eventType: "LEAD_STAGE_MOVED",
    leadId: input.leadId,
    payload: { fromStageId: lead.pipelineStageId, toStageId: stageId },
    source: "service:leads.stage",
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.LEAD_STAGE_MOVED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Lead",
    resourceId: input.leadId,
    metadata: { fromStageId: lead.pipelineStageId, toStageId: stageId },
  });

  return loadLeadOrThrow(authz, input.leadId);
}

/** Assigns (or unassigns with `null`) a lead to an ACTIVE tenant member. */
export async function assignLead(
  authz: TenantAuthzContext,
  actorId: string,
  input: { leadId: string; assignedToUserId: string | null },
): Promise<LeadRow> {
  const lead = await loadLeadOrThrow(authz, input.leadId);
  if (input.assignedToUserId !== null) {
    await assertActiveTenantMember(
      authz,
      input.assignedToUserId,
      "assignedToUserId",
    );
  }

  const result = await prisma.lead.updateMany({
    where: { id: input.leadId, tenantId: authz.tenantId },
    data: { assignedToUserId: input.assignedToUserId },
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Lead not found.");
  }

  await appendActivity(authz, actorId, {
    eventType:
      input.assignedToUserId === null ? "LEAD_UNASSIGNED" : "LEAD_ASSIGNED",
    leadId: input.leadId,
    payload: {
      fromUserId: lead.assignedToUserId,
      toUserId: input.assignedToUserId,
    },
    source: "service:leads.assign",
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.LEAD_ASSIGNED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Lead",
    resourceId: input.leadId,
    metadata: { assignedToUserId: input.assignedToUserId },
  });

  return loadLeadOrThrow(authz, input.leadId);
}

/** Marks a lead LOST. The reason is mandatory — a loss nobody can read why
 *  is not auditable. */
export async function markLost(
  authz: TenantAuthzContext,
  actorId: string,
  input: { leadId: string; lostReason: string },
): Promise<LeadRow> {
  const lead = await loadLeadOrThrow(authz, input.leadId);
  if (lead.status === "LOST") {
    throw new CrmServiceError("CONFLICT", "This lead is already lost.");
  }
  if (lead.status === "CONVERTED") {
    throw new CrmServiceError(
      "CONFLICT",
      "A converted lead cannot be marked lost.",
    );
  }

  const lostAt = new Date();
  const result = await prisma.lead.updateMany({
    where: { id: input.leadId, tenantId: authz.tenantId },
    data: { status: "LOST", lostAt, lostReason: input.lostReason.trim() },
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Lead not found.");
  }

  await appendActivity(authz, actorId, {
    eventType: "LEAD_LOST",
    leadId: input.leadId,
    payload: { fromStatus: lead.status },
    source: "service:leads.lost",
    sourceKey: `lead:${input.leadId}:lost`,
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.LEAD_LOST,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Lead",
    resourceId: input.leadId,
    // The reason lives on the lead row; the audit records that it was given.
    metadata: { fromStatus: lead.status },
  });

  return loadLeadOrThrow(authz, input.leadId);
}

/** Reopens a LOST lead as NEW. CONVERTED stays final forever. */
export async function reopenLead(
  authz: TenantAuthzContext,
  actorId: string,
  leadId: string,
): Promise<LeadRow> {
  const lead = await loadLeadOrThrow(authz, leadId);
  if (lead.status !== "LOST") {
    throw new CrmServiceError(
      "VALIDATION",
      "Only a lost lead can be reopened.",
    );
  }

  const result = await prisma.lead.updateMany({
    where: { id: leadId, tenantId: authz.tenantId },
    data: { status: "NEW", lostAt: null, lostReason: null },
  });
  if (result.count === 0) {
    throw new CrmServiceError("NOT_FOUND", "Lead not found.");
  }

  await appendActivity(authz, actorId, {
    eventType: "LEAD_REOPENED",
    leadId,
    source: "service:leads.reopen",
  });
  await recordAudit({
    action: CRM_AUDIT_ACTIONS.LEAD_REOPENED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "Lead",
    resourceId: leadId,
    metadata: { fromStatus: lead.status },
  });

  return loadLeadOrThrow(authz, leadId);
}

/* --------------------------------- reads ----------------------------------- */

const leadListInclude = {
  pipelineStage: {
    select: {
      id: true,
      name: true,
      position: true,
      isWin: true,
      isLost: true,
      pipelineId: true,
    },
  },
  assignedToUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.LeadInclude;

export type LeadListItem = Prisma.LeadGetPayload<{
  include: typeof leadListInclude;
}>;

/** Filtered, paginated lead board/list read, pinned to the authorized tenant. */
export async function listLeads(
  authz: TenantAuthzContext,
  query: Omit<LeadQueryInput, "tenantId">,
): Promise<{ leads: LeadListItem[]; total: number }> {
  const where: Prisma.LeadWhereInput = {
    tenantId: authz.tenantId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.stageId ? { pipelineStageId: query.stageId } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.assignedTo
      ? query.assignedTo === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: query.assignedTo }
      : {}),
    ...(query.q
      ? {
          OR: [
            { firstName: { contains: query.q, mode: "insensitive" } },
            { lastName: { contains: query.q, mode: "insensitive" } },
            { companyName: { contains: query.q, mode: "insensitive" } },
            { email: { contains: query.q, mode: "insensitive" } },
            { phone: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      include: leadListInclude,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.lead.count({ where }),
  ]);

  return { leads, total };
}

const leadDetailInclude = {
  ...leadListInclude,
  contact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      companyName: true,
    },
  },
  convertedContact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      companyName: true,
    },
  },
  tasks: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.LeadInclude;

export type LeadDetailTask = Prisma.TaskGetPayload<Record<string, never>> & {
  /** Derived at read: overdue is a timestamp fact, never a stored flag. */
  readonly overdue: boolean;
};

export type LeadDetail = Omit<
  Prisma.LeadGetPayload<{ include: typeof leadDetailInclude }>,
  "tasks"
> & {
  readonly tasks: LeadDetailTask[];
  readonly overdueTaskCount: number;
};

/** Loads one lead with its tasks, deriving each task's overdue flag. */
export async function getLeadDetail(
  authz: TenantAuthzContext,
  leadId: string,
): Promise<LeadDetail> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, tenantId: authz.tenantId },
    include: leadDetailInclude,
  });
  if (!lead) {
    throw new CrmServiceError("NOT_FOUND", "Lead not found.");
  }

  const now = Date.now();
  const tasks: LeadDetailTask[] = lead.tasks.map((task) => ({
    ...task,
    overdue:
      task.dueAt !== null &&
      task.completedAt === null &&
      task.dueAt.getTime() < now,
  }));

  return {
    ...lead,
    tasks,
    overdueTaskCount: tasks.filter((task) => task.overdue).length,
  };
}

export interface LeadMetrics {
  /** Open (non-terminal) lead count per stage of the tenant's pipelines. */
  readonly stages: Array<{
    readonly id: string;
    readonly name: string;
    readonly position: number;
    readonly isWin: boolean;
    readonly isLost: boolean;
    readonly pipelineId: string;
    readonly openLeadCount: number;
  }>;
  readonly won: number;
  readonly lost: number;
  readonly converted: number;
  /** won / (lost + won) over the period; null when the denominator is empty. */
  readonly winRate: number | null;
  readonly period: { readonly from: Date; readonly to: Date };
}

/**
 * Pipeline metrics over a period, computed from CURRENT data only.
 *
 * SNAPSHOT METRIC — not a historical reconstruction: "won" counts leads whose
 * CURRENT stage is a win stage and whose row was last touched inside the
 * period; "lost" counts leads whose `lostAt` falls in the period. Stage
 * history lives in the activity timeline but is not replayed here, so a lead
 * that passed through a win stage and then moved away is not counted. The
 * design spec (§0 "no cron", §2) accepts this: the numbers describe the
 * board as it stands, and the timeline is the audit trail of how it got there.
 */
export async function getLeadMetrics(
  authz: TenantAuthzContext,
  period: { from: Date; to: Date },
): Promise<LeadMetrics> {
  const [stages, grouped, won, lost, converted] = await Promise.all([
    prisma.pipelineStage.findMany({
      where: { tenantId: authz.tenantId, pipeline: { archivedAt: null } },
      select: {
        id: true,
        name: true,
        position: true,
        isWin: true,
        isLost: true,
        pipelineId: true,
      },
      orderBy: { position: "asc" },
    }),
    prisma.lead.groupBy({
      by: ["pipelineStageId"],
      where: {
        tenantId: authz.tenantId,
        status: { in: ["NEW", "CONTACTED", "QUALIFIED"] },
      },
      _count: { _all: true },
    }),
    prisma.lead.count({
      where: {
        tenantId: authz.tenantId,
        pipelineStage: { isWin: true },
        updatedAt: { gte: period.from, lte: period.to },
      },
    }),
    prisma.lead.count({
      where: {
        tenantId: authz.tenantId,
        status: "LOST",
        lostAt: { gte: period.from, lte: period.to },
      },
    }),
    prisma.lead.count({
      where: {
        tenantId: authz.tenantId,
        status: "CONVERTED",
        convertedAt: { gte: period.from, lte: period.to },
      },
    }),
  ]);

  const countByStage = new Map<string, number>();
  // Leads outside a stage (e.g. freshly converted) are counted but not surfaced
  // as a stage row — the prefix marks the deliberate non-use.
  let _unassigned = 0;
  for (const row of grouped) {
    if (row.pipelineStageId === null) {
      _unassigned += row._count._all;
    } else {
      countByStage.set(row.pipelineStageId, row._count._all);
    }
  }

  const denominator = won + lost;

  return {
    stages: stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      position: stage.position,
      isWin: stage.isWin,
      isLost: stage.isLost,
      pipelineId: stage.pipelineId,
      openLeadCount: countByStage.get(stage.id) ?? 0,
    })),
    won,
    lost,
    converted,
    winRate: denominator > 0 ? won / denominator : null,
    period,
  };
}

/** Internal alias used by `conversion.ts` so the load rule lives once. */
export { loadLeadOrThrow as loadLead };
