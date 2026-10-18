import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import type {
  CreateCampaignInput,
  ListCampaignsInput,
  UpdateCampaignInput,
} from "@/lib/validations/marketing";
import {
  SOCIAL_AUDIT_ACTIONS,
  SocialServiceError,
} from "@/server/services/integrations/errors";

/**
 * Marketing campaigns (AGENT 03 module B).
 *
 * A campaign is UTM attribution text plus an INFORMATIONAL budget — never a
 * gate or an entitlement (the same posture the platform's `Plan` takes). The
 * lifecycle DRAFT → ACTIVE → PAUSED → ARCHIVED moves only through the dedicated
 * operations; `status` is never a client field. `tenantId` comes from the
 * authorization context, never the payload. Archiving a campaign never eats a
 * distributed `ShareLink` (the `ShareLink.campaignId` FK is SetNull), and UTM
 * text stays the attribution authority.
 */

export type CampaignRow = Prisma.MarketingCampaignGetPayload<
  Record<string, never>
>;

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const ACTIVE_TO: ReadonlySet<CampaignRow["status"]> = new Set([
  "DRAFT",
  "PAUSED",
]);

async function loadCampaign(
  authz: TenantAuthzContext,
  campaignId: string,
): Promise<CampaignRow> {
  const row = await prisma.marketingCampaign.findFirst({
    where: { id: campaignId, tenantId: authz.tenantId },
  });
  if (!row) {
    throw new SocialServiceError("NOT_FOUND", "Campaign not found.");
  }
  return row;
}

function budgetDecimal(value: string | undefined): Prisma.Decimal | null {
  return value === undefined || value === "" ? null : new Prisma.Decimal(value);
}

/* ---------------------------------- create ---------------------------------- */

export async function createCampaign(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<CreateCampaignInput, "tenantId">,
): Promise<CampaignRow> {
  const created = await prisma.marketingCampaign.create({
    data: {
      tenantId: authz.tenantId,
      name: input.name.trim(),
      // `status` intentionally absent: DRAFT by column default; only the
      // activate/pause/archive verbs move it.
      objective: text(input.objective),
      utmSource: text(input.utmSource),
      utmMedium: text(input.utmMedium),
      utmCampaign: text(input.utmCampaign),
      budgetCurrency: input.budgetCurrency,
      budgetAmount: budgetDecimal(input.budgetAmount),
    },
  });

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CAMPAIGN_CREATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "MarketingCampaign",
    resourceId: created.id,
    metadata: { status: created.status },
  });

  return created;
}

/* ---------------------------------- update ---------------------------------- */

export async function updateCampaign(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<UpdateCampaignInput, "tenantId">,
): Promise<CampaignRow> {
  await loadCampaign(authz, input.campaignId);

  const data: Prisma.MarketingCampaignUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.objective !== undefined) data.objective = text(input.objective);
  if (input.utmSource !== undefined) data.utmSource = text(input.utmSource);
  if (input.utmMedium !== undefined) data.utmMedium = text(input.utmMedium);
  if (input.utmCampaign !== undefined) {
    data.utmCampaign = text(input.utmCampaign);
  }
  if (input.budgetCurrency !== undefined) {
    data.budgetCurrency = input.budgetCurrency;
  }
  if (input.budgetAmount !== undefined) {
    data.budgetAmount =
      input.budgetAmount === null
        ? null
        : new Prisma.Decimal(input.budgetAmount);
  }

  const result = await prisma.marketingCampaign.updateMany({
    where: { id: input.campaignId, tenantId: authz.tenantId },
    data,
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Campaign not found.");
  }

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CAMPAIGN_UPDATED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "MarketingCampaign",
    resourceId: input.campaignId,
    metadata: { fields: Object.keys(data) },
  });

  return loadCampaign(authz, input.campaignId);
}

/* --------------------------------- lifecycle -------------------------------- */

/** DRAFT/PAUSED → ACTIVE. */
export async function activateCampaign(
  authz: TenantAuthzContext,
  actorId: string,
  campaignId: string,
): Promise<CampaignRow> {
  const campaign = await loadCampaign(authz, campaignId);
  if (!ACTIVE_TO.has(campaign.status)) {
    throw new SocialServiceError(
      "CONFLICT",
      "Only a draft or paused campaign can be activated.",
    );
  }
  return transitionCampaign(
    authz,
    actorId,
    campaignId,
    "ACTIVE",
    campaign.status,
  );
}

/** ACTIVE → PAUSED. */
export async function pauseCampaign(
  authz: TenantAuthzContext,
  actorId: string,
  campaignId: string,
): Promise<CampaignRow> {
  const campaign = await loadCampaign(authz, campaignId);
  if (campaign.status !== "ACTIVE") {
    throw new SocialServiceError(
      "CONFLICT",
      "Only an active campaign can be paused.",
    );
  }
  return transitionCampaign(
    authz,
    actorId,
    campaignId,
    "PAUSED",
    campaign.status,
  );
}

/** Any non-archived → ARCHIVED. Distributed links survive (SetNull). */
export async function archiveCampaign(
  authz: TenantAuthzContext,
  actorId: string,
  campaignId: string,
): Promise<CampaignRow> {
  const campaign = await loadCampaign(authz, campaignId);
  if (campaign.status === "ARCHIVED") {
    throw new SocialServiceError(
      "CONFLICT",
      "This campaign is already archived.",
    );
  }
  return transitionCampaign(
    authz,
    actorId,
    campaignId,
    "ARCHIVED",
    campaign.status,
  );
}

async function transitionCampaign(
  authz: TenantAuthzContext,
  actorId: string,
  campaignId: string,
  to: CampaignRow["status"],
  from: CampaignRow["status"],
): Promise<CampaignRow> {
  const result = await prisma.marketingCampaign.updateMany({
    where: { id: campaignId, tenantId: authz.tenantId },
    data: { status: to },
  });
  if (result.count === 0) {
    throw new SocialServiceError("NOT_FOUND", "Campaign not found.");
  }

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CAMPAIGN_STATUS,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "MarketingCampaign",
    resourceId: campaignId,
    metadata: { from, to },
  });

  return loadCampaign(authz, campaignId);
}

/* ----------------------------------- reads ---------------------------------- */

export async function listCampaigns(
  authz: TenantAuthzContext,
  query: Omit<ListCampaignsInput, "tenantId">,
): Promise<{ campaigns: CampaignRow[]; total: number }> {
  const where: Prisma.MarketingCampaignWhereInput = {
    tenantId: authz.tenantId,
    ...(query.status ? { status: query.status } : {}),
  };
  const [campaigns, total] = await Promise.all([
    prisma.marketingCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.marketingCampaign.count({ where }),
  ]);
  return { campaigns, total };
}

export async function getCampaign(
  authz: TenantAuthzContext,
  campaignId: string,
): Promise<CampaignRow> {
  return loadCampaign(authz, campaignId);
}
