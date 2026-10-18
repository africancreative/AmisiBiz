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
  assignLeadSchema,
  convertLeadSchema,
  createLeadSchema,
  leadLocatorSchema,
  leadMetricsQuerySchema,
  leadQuerySchema,
  loseLeadSchema,
  moveLeadStageSchema,
  reopenLeadSchema,
  updateLeadSchema,
} from "@/lib/validations/lead";
import {
  assignLead,
  createLead,
  crmErrorActionCode,
  CrmServiceError,
  getLeadDetail,
  getLeadMetrics,
  listLeads,
  markLost,
  moveLeadStage,
  reopenLead,
  updateLead,
  type LeadRow,
} from "@/server/services/leads/service";
import { convertLead } from "@/server/services/leads/conversion";
import {
  findDuplicateLeads,
  type DuplicateSuspect,
} from "@/server/services/leads/dedupe";
import { getTimeline } from "@/server/services/activities/service";

/**
 * Lead Server Actions (AGENT 02 Phase 2A).
 *
 * Shape mirrors `actions/item.ts` exactly: authenticate → validate with the
 * schema (unknown/server-owned keys stripped) → `authorizeTenant` with the
 * verb-specific permission (this also opens the RLS scope) → delegate to the
 * leads engine, which takes the authorized context and never a client
 * `tenantId`. Actions never throw; every failure lands as an `ActionResult`.
 *
 * Permission wiring (design spec §1.4):
 *  - create            → LEADS_CREATE
 *  - update/move/assign/lose/reopen → LEADS_UPDATE
 *  - convert           → LEADS_CONVERT (a distinct verb: it mints a customer)
 *  - list/detail/metrics → LEADS_READ
 * Suspension/support-read-only contexts are refused inside `authorizeTenant`
 * for every write verb (`isWritePermission` → `assertWritableContext`).
 */

/** Maps engine failures onto the shared action error vocabulary. */
function crmActionFailure(
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

/* -------------------------------- writes ----------------------------------- */

export async function createLeadAction(rawInput: unknown): Promise<
  ActionResult<{
    leadId: string;
    created: boolean;
    duplicateSuspects: DuplicateSuspect[];
  }>
> {
  const session = await requireAuth();

  const parsed = createLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_CREATE,
    );
  } catch (err) {
    return authorizationFailure(err, "createLeadAction");
  }

  try {
    const result = await createLead(context, session.user.id, data);
    return {
      success: true,
      data: {
        leadId: result.lead.id,
        created: result.created,
        duplicateSuspects: result.duplicateSuspects,
      },
    };
  } catch (err) {
    return crmActionFailure(err, "createLeadAction");
  }
}

export async function updateLeadAction(
  rawInput: unknown,
): Promise<ActionResult<{ lead: LeadRow }>> {
  const session = await requireAuth();

  const parsed = updateLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "updateLeadAction");
  }

  try {
    const lead = await updateLead(context, session.user.id, data);
    return { success: true, data: { lead } };
  } catch (err) {
    return crmActionFailure(err, "updateLeadAction");
  }
}

export async function moveLeadStageAction(
  rawInput: unknown,
): Promise<ActionResult<{ lead: LeadRow }>> {
  const session = await requireAuth();

  const parsed = moveLeadStageSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, leadId, stageId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "moveLeadStageAction");
  }

  try {
    const lead = await moveLeadStage(context, session.user.id, {
      leadId,
      stageId,
    });
    return { success: true, data: { lead } };
  } catch (err) {
    return crmActionFailure(err, "moveLeadStageAction");
  }
}

export async function assignLeadAction(
  rawInput: unknown,
): Promise<ActionResult<{ lead: LeadRow }>> {
  const session = await requireAuth();

  const parsed = assignLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, leadId, assignedToUserId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "assignLeadAction");
  }

  try {
    const lead = await assignLead(context, session.user.id, {
      leadId,
      assignedToUserId,
    });
    return { success: true, data: { lead } };
  } catch (err) {
    return crmActionFailure(err, "assignLeadAction");
  }
}

export async function loseLeadAction(
  rawInput: unknown,
): Promise<ActionResult<{ lead: LeadRow }>> {
  const session = await requireAuth();

  const parsed = loseLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, leadId, lostReason } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "loseLeadAction");
  }

  try {
    const lead = await markLost(context, session.user.id, {
      leadId,
      lostReason,
    });
    return { success: true, data: { lead } };
  } catch (err) {
    return crmActionFailure(err, "loseLeadAction");
  }
}

export async function reopenLeadAction(
  rawInput: unknown,
): Promise<ActionResult<{ lead: LeadRow }>> {
  const session = await requireAuth();

  const parsed = reopenLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, leadId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_UPDATE,
    );
  } catch (err) {
    return authorizationFailure(err, "reopenLeadAction");
  }

  try {
    const lead = await reopenLead(context, session.user.id, leadId);
    return { success: true, data: { lead } };
  } catch (err) {
    return crmActionFailure(err, "reopenLeadAction");
  }
}

/**
 * Converts a lead into a customer (optionally raising a draft). The distinct
 * LEADS_CONVERT verb is what the SALES/FINANCE matrix difference hinges on,
 * so it must never collapse into LEADS_UPDATE.
 */
export async function convertLeadAction(rawInput: unknown): Promise<
  ActionResult<{
    leadId: string;
    contactId: string;
    documentId: string | null;
    documentCreated: boolean;
    needsDraftEditor: boolean;
  }>
> {
  const session = await requireAuth();

  const parsed = convertLeadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid conversion request.");
  }

  // Object rest over a discriminated union keeps the branch pairing: the
  // `contact` blob of the new-contact branch and the `contactId` of the
  // existing-contact branch travel separately, exactly as the engine expects.
  const { tenantId, ...conversion } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_CONVERT,
    );
  } catch (err) {
    return authorizationFailure(err, "convertLeadAction");
  }

  try {
    const result = await convertLead(context, session.user.id, conversion);
    return { success: true, data: result };
  } catch (err) {
    return crmActionFailure(err, "convertLeadAction");
  }
}

/* --------------------------------- reads ----------------------------------- */

export async function getLeadsAction(rawInput: unknown): Promise<
  ActionResult<{
    leads: Awaited<ReturnType<typeof listLeads>>["leads"];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = leadQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, ...query } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getLeadsAction");
  }

  try {
    const { leads, total } = await listLeads(context, query);
    return {
      success: true,
      data: {
        leads,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  } catch (err) {
    return crmActionFailure(err, "getLeadsAction");
  }
}

/**
 * Lead detail for the drawer/board: the row with its tasks (overdue derived on
 * the read side), the duplicate candidates a human should see before working
 * the lead, and the timeline slice for this lead.
 */
export async function getLeadAction(rawInput: unknown): Promise<
  ActionResult<{
    lead: Awaited<ReturnType<typeof getLeadDetail>>;
    duplicateSuspects: DuplicateSuspect[];
    timeline: Awaited<ReturnType<typeof getTimeline>>;
  }>
> {
  const session = await requireAuth();

  const parsed = leadLocatorSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, leadId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getLeadAction");
  }

  try {
    const lead = await getLeadDetail(context, leadId);

    const [duplicateSuspects, timeline] = await Promise.all([
      findDuplicateLeads(context, {
        email: lead.email,
        phone: lead.phone,
        companyName: lead.companyName,
        excludeLeadId: lead.id,
      }),
      getTimeline(context, { leadId }),
    ]);

    return { success: true, data: { lead, duplicateSuspects, timeline } };
  } catch (err) {
    return crmActionFailure(err, "getLeadAction");
  }
}

/**
 * Per-stage open counts and the period win/lost rate. SNAPSHOT metric — it
 * reads the board as it stands (see the long comment in
 * `services/leads/service.ts`); it is not a historical reconstruction.
 */
export async function getLeadMetricsAction(rawInput: unknown): Promise<
  ActionResult<{
    metrics: Awaited<ReturnType<typeof getLeadMetrics>>;
  }>
> {
  const session = await requireAuth();

  const parsed = leadMetricsQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid metrics query.");
  }

  const { tenantId, from, to } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.LEADS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getLeadMetricsAction");
  }

  try {
    const metrics = await getLeadMetrics(context, { from, to });
    return { success: true, data: { metrics } };
  } catch (err) {
    return crmActionFailure(err, "getLeadMetricsAction");
  }
}
