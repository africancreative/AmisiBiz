import { randomBytes } from "node:crypto";
import { Prisma, type MarketingEventType } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Marketing event stream — the SINGLE writer (AGENT 03 module B).
 *
 * Mirrors the `appendActivity` contract exactly, because this stream carries the
 * same guarantees plus a consent surface:
 *
 *  - **One writer.** Every marketing analytics row lands through
 *    `appendMarketingEvent`; nothing writes `MarketingEvent` elsewhere. The row
 *    is append-only in the database (an UPDATE/DELETE trigger raises), so it is
 *    corrected by writing another event, never edited.
 *  - **Retry-safe dedup.** Identity is `(tenantId, eventType, uniqueEventId)`
 *    (migration §4). A duplicate insert is swallowed (`P2002`) — the caller sees
 *    the same success it saw the first time — so a replayed webhook or a retried
 *    click records once, never twice.
 *  - **Consent gate.** `contactId` is written ONLY when the referenced
 *    `Contact.marketingConsent` is `true`. Otherwise the event is de-identified
 *    (no `contactId`) and the `consented` column records which branch it took.
 *    This is a server rule, never a client field: the caller names a candidate
 *    contact and the writer decides whether the row may be identifiable.
 *  - **No IP, no raw PII in `sourceMeta`.** Callers pass only de-identified
 *    referrer/device-class facts; the writer will not accept an IP-bearing shape
 *    here (documented, and the caller — e.g. the webhook router — is responsible
 *    for passing already de-identified meta). The tenant comes exclusively from
 *    the authorization context.
 */

/**
 * Mint an opaque, collision-resistant click id. The public share resolver uses
 * this as a CAMPAIGN_LINK_CLICK `uniqueEventId` so a single measured click is
 * recorded exactly once even if the client retries; it is random (never
 * sequential, never derived from user data) and carries no PII.
 */
export function mintClickId(): string {
  return `clk_${randomBytes(12).toString("hex")}`;
}

export interface AppendMarketingEventInput {
  readonly eventType: MarketingEventType;
  /** Required retry identity — dedup key. */
  readonly uniqueEventId: string;
  readonly occurredAt?: Date;
  readonly shareLinkId?: string | null;
  readonly campaignId?: string | null;
  /** Candidate contact; identified ONLY if its marketingConsent is true. */
  readonly contactId?: string | null;
  readonly leadId?: string | null;
  readonly documentId?: string | null;
  readonly itemId?: string | null;
  readonly clickId?: string | null;
  /** De-identified referrer/device facts only — never an IP. */
  readonly sourceMeta?: Prisma.InputJsonValue;
}

/** Whether the writer attached the contact (consent true) or de-identified. */
export interface AppendMarketingEventResult {
  readonly recorded: boolean;
  readonly consented: boolean;
}

/**
 * Append one marketing event under the authorization context's tenant.
 *
 * Never throws on a replay: a (tenantId, eventType, uniqueEventId) collision
 * means this exact event was already recorded.
 */
export async function appendMarketingEvent(
  authz: TenantAuthzContext,
  input: AppendMarketingEventInput,
): Promise<AppendMarketingEventResult> {
  // Consent gate: the contact may be attached ONLY with proven consent. A
  // contactId that does not resolve to this tenant's consented contact is
  // dropped (the event still records, just de-identified).
  let consentedContactId: string | null = null;
  if (input.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, tenantId: authz.tenantId },
      select: { id: true, marketingConsent: true },
    });
    consentedContactId =
      contact && contact.marketingConsent === true ? contact.id : null;
  }

  try {
    await prisma.marketingEvent.create({
      data: {
        tenantId: authz.tenantId,
        eventType: input.eventType,
        occurredAt: input.occurredAt ?? new Date(),
        uniqueEventId: input.uniqueEventId,
        shareLinkId: input.shareLinkId ?? null,
        campaignId: input.campaignId ?? null,
        contactId: consentedContactId,
        leadId: input.leadId ?? null,
        documentId: input.documentId ?? null,
        itemId: input.itemId ?? null,
        clickId: input.clickId ?? null,
        // exactOptionalPropertyTypes: a bare `sourceMeta: undefined` would be a
        // type error; omit the key entirely when there is none.
        ...(input.sourceMeta === undefined
          ? {}
          : { sourceMeta: input.sourceMeta }),
        consented: consentedContactId !== null,
      },
    });
    return { recorded: true, consented: consentedContactId !== null };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { recorded: false, consented: consentedContactId !== null };
    }
    throw error;
  }
}

/**
 * Aggregate the funnel counts a campaign/analytics view needs, over a period,
 * pinned to the authorized tenant. READ side only — never a writer.
 */
export async function marketingFunnelCounts(
  authz: TenantAuthzContext,
  period: { from: Date; to: Date },
  campaignId?: string,
): Promise<Record<string, number>> {
  const grouped = await prisma.marketingEvent.groupBy({
    by: ["eventType"],
    where: {
      tenantId: authz.tenantId,
      occurredAt: { gte: period.from, lte: period.to },
      ...(campaignId ? { campaignId } : {}),
    },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const row of grouped) {
    counts[row.eventType] = row._count._all;
  }
  return counts;
}
