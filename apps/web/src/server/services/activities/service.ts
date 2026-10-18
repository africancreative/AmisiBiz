import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Unified commercial activity timeline (AGENT 02 module F).
 *
 * This is the ONLY writer of `ActivityEvent` rows. Every mutation path in the
 * CRM/commerce services appends through `appendActivity` here, so a timeline
 * entry is traceable to exactly one source action and cannot be forged from a
 * form. Rows are append-only in the database (an UPDATE/DELETE trigger raises),
 * and a retried operation is deduplicated by the (tenantId, source, sourceKey)
 * unique — a duplicate insert is swallowed, never errored, so callers on the
 * retry path see the same success they saw the first time.
 *
 * The tenant is never part of the input: it comes from the authorization
 * context the caller already passed (RLS scope is open by then).
 */

export interface ActivityInput {
  /** Open-vocabulary event name, e.g. "LEAD_CREATED", "ORDER_ISSUED". */
  readonly eventType: string;
  readonly occurredAt?: Date;
  readonly leadId?: string | null;
  readonly contactId?: string | null;
  readonly documentId?: string | null;
  readonly taskId?: string | null;
  readonly shareLinkId?: string | null;
  readonly payload?: Prisma.InputJsonValue;
  /** Stable origin id, e.g. "action:lead.create"; pairs with sourceKey. */
  readonly source?: string;
  /** Caller-supplied dedup key (idempotencyKey, operationId). */
  readonly sourceKey?: string;
}

/**
 * Append one timeline event. Never throws on a replay: a (source, sourceKey)
 * collision means this exact event was already recorded, which is the
 * desired outcome for a retried operation.
 */
export async function appendActivity(
  authz: TenantAuthzContext,
  actorId: string | null,
  input: ActivityInput,
): Promise<void> {
  try {
    await prisma.activityEvent.create({
      data: {
        tenantId: authz.tenantId,
        eventType: input.eventType,
        occurredAt: input.occurredAt ?? new Date(),
        actorId,
        leadId: input.leadId ?? null,
        contactId: input.contactId ?? null,
        documentId: input.documentId ?? null,
        taskId: input.taskId ?? null,
        shareLinkId: input.shareLinkId ?? null,
        // exactOptionalPropertyTypes: a bare `payload: input.payload` would pass
        // an explicit undefined. Omit the key entirely when there is no payload.
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        source: input.source ?? null,
        sourceKey: input.sourceKey ?? null,
      },
    });
  } catch (error) {
    // Unique-violation on (tenantId, source, sourceKey): already recorded.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return;
    }
    throw error;
  }
}

export interface TimelineFilter {
  readonly contactId?: string;
  readonly leadId?: string;
  readonly documentId?: string;
  /** Newest-first page size; defaults to 50. */
  readonly limit?: number;
  /** ISO instant; return events strictly older than this. */
  readonly before?: Date;
}

/**
 * Read the unified timeline for one participant surface. Events match when
 * they reference any of the requested ids, so a contact 360 shows the whole
 * enquiry-to-order history in one stream.
 */
export async function getTimeline(
  authz: TenantAuthzContext,
  filter: TimelineFilter,
) {
  const or: Prisma.ActivityEventWhereInput[] = [];
  if (filter.contactId) or.push({ contactId: filter.contactId });
  if (filter.leadId) or.push({ leadId: filter.leadId });
  if (filter.documentId) or.push({ documentId: filter.documentId });

  return prisma.activityEvent.findMany({
    where: {
      tenantId: authz.tenantId,
      ...(or.length > 0 ? { OR: or } : {}),
      ...(filter.before ? { occurredAt: { lt: filter.before } } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: Math.min(filter.limit ?? 50, 200),
    include: {
      actor: { select: { id: true, name: true, email: true } },
    },
  });
}
