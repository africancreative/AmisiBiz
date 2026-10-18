import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { recordAudit } from "@/lib/audit";
import { appendActivity } from "@/server/services/activities/service";
import { ContactServiceError } from "./errors";

/**
 * Contact merge + duplicate candidates (AGENT 02, Phase 2B, design spec §1.3).
 *
 * Merge is EXPLICITLY two-step and never automatic: `previewContactMerge`
 * computes the full reparent plan read-only, `applyContactMerge` refuses to run
 * without an echoed `confirm: true`. Merged-away contacts are NEVER hard
 * deleted — every historical document stays resolvable — the loser rows go
 * `ARCHIVED` with `supersededById` pointing at the survivor.
 *
 * Refusals enforced here (all before any write):
 *  - survivor named inside the loser set,
 *  - ids that do not resolve inside the authorized tenant (cross-tenant/
 *    forged → `NOT_FOUND`, never a leak),
 *  - portal-linked contacts: a portal user's whole access is `Contact.
 *    portalUserId`, so re-pointing that link is a security decision, not a
 *    data-hygiene one. Any portal link on the survivor or a loser refuses the
 *    merge; portal revocation must happen first, deliberately.
 *  - losers that already carry `supersededById` (a contact is merged away at
 *    most once).
 *
 * Timeline note: `ActivityEvent` rows are append-only IN THE DATABASE (a
 * BEFORE UPDATE/DELETE trigger raises), so historical events are COUNTED for
 * the human plan but stay on their original row; the `MERGE_APPLIED` event
 * written here is the pointer that links the two.
 */

/**
 * Audit action for a completed merge. `AUDIT_ACTIONS` (lib/audit) has no key
 * for it and that module is outside this change's whitelist; `AuditEvent.
 * action` is a plain string, so the constant is declared beside its only
 * writer and mirrors the `contact.*` naming of its neighbours.
 */
const AUDIT_CONTACT_MERGED = "contact.merged";

/** Profile columns a survivor may absorb from a loser (empty-field absorb only). */
const ABSORB_TEXT_FIELDS = [
  "firstName",
  "lastName",
  "companyName",
  "phone",
  "mobile",
  "taxPin",
  "notes",
  "sourceDetail",
  "sourceCampaign",
] as const;

const MERGE_CONTACT_SELECT = {
  id: true,
  status: true,
  firstName: true,
  lastName: true,
  companyName: true,
  email: true,
  phone: true,
  mobile: true,
  taxPin: true,
  notes: true,
  source: true,
  sourceDetail: true,
  sourceCampaign: true,
  preferredChannel: true,
  marketingConsent: true,
  marketingConsentAt: true,
  supersededById: true,
  portalUserId: true,
} satisfies Prisma.ContactSelect;

type MergeableContact = Prisma.ContactGetPayload<{
  select: typeof MERGE_CONTACT_SELECT;
}>;

export interface MergePlanCounts {
  readonly leads: number;
  readonly convertedLeads: number;
  readonly documents: number;
  /** Loser item-agreements that move to the survivor. */
  readonly contactItems: number;
  /** Loser agreements that CANNOT move: the survivor already trades that item. */
  readonly contactItemsBlocked: number;
  readonly contactAddresses: number;
  readonly tasks: number;
  /** Informational only — timeline rows are append-owned and stay on their row. */
  readonly activityEvents: number;
  readonly contactTagsMoved: number;
  readonly contactTagsDropped: number;
}

export interface MergeConflict {
  readonly code: "PORTAL_LINKED" | "ALREADY_MERGED" | "SURVIVOR_ARCHIVED";
  readonly message: string;
  readonly contactId: string;
}

export interface ContactMergePlan {
  readonly survivorId: string;
  readonly loserIds: readonly string[];
  readonly reparentCounts: MergePlanCounts;
  readonly conflicts: readonly MergeConflict[];
  readonly canApply: boolean;
}

function isEmptyText(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/** Trimmed non-empty text as a narrowed `string`; `null` for blank input. */
function blank(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Load and validate the merge pair. Everything below the authorization gate
 * funnels through here, so preview and apply can never disagree about what a
 * valid merge request is. Throws (never returns a failure object) because both
 * callers need the same hard stop.
 */
async function loadMergePair(
  authz: TenantAuthzContext,
  survivorId: string,
  loserIdsRaw: readonly string[],
): Promise<{
  survivor: MergeableContact;
  losers: MergeableContact[];
  conflicts: MergeConflict[];
}> {
  const tenantId = authz.tenantId;

  // Dedupe, then refuse a survivor named among the losers — reparenting a row
  // onto itself is not a merge, it is a corruption waiting to happen.
  const loserIds = [...new Set(loserIdsRaw)];
  if (loserIds.includes(survivorId)) {
    throw new ContactServiceError(
      "VALIDATION",
      "The surviving contact cannot also be merged away.",
      "loserIds",
    );
  }

  const survivor = await prisma.contact.findFirst({
    where: { id: survivorId, tenantId },
    select: MERGE_CONTACT_SELECT,
  });
  if (!survivor) {
    throw new ContactServiceError(
      "NOT_FOUND",
      "The surviving contact was not found in this organisation.",
      "survivorId",
    );
  }

  const losers = await prisma.contact.findMany({
    where: { id: { in: loserIds }, tenantId },
    select: MERGE_CONTACT_SELECT,
  });
  if (losers.length !== loserIds.length) {
    // A forged id from another tenant simply finds no row under RLS; the
    // count mismatch is the only honest signal, and it must not say which.
    throw new ContactServiceError(
      "NOT_FOUND",
      "One or more contacts to merge away were not found in this organisation.",
      "loserIds",
    );
  }

  const conflicts: MergeConflict[] = [];

  if (survivor.portalUserId !== null) {
    conflicts.push({
      code: "PORTAL_LINKED",
      contactId: survivor.id,
      message:
        "The surviving contact is linked to a portal user. Revoke portal access before merging.",
    });
  }
  for (const loser of losers) {
    if (loser.portalUserId !== null) {
      conflicts.push({
        code: "PORTAL_LINKED",
        contactId: loser.id,
        message:
          "A contact to merge away is linked to a portal user. Revoke portal access before merging.",
      });
    }
    if (loser.supersededById !== null) {
      conflicts.push({
        code: "ALREADY_MERGED",
        contactId: loser.id,
        message:
          "A contact to merge away has already been merged into another contact.",
      });
    }
  }
  if (survivor.status === "ARCHIVED") {
    conflicts.push({
      code: "SURVIVOR_ARCHIVED",
      contactId: survivor.id,
      message: "Restore the archived survivor before merging into it.",
    });
  }

  return { survivor, losers, conflicts };
}

/** Deterministic dedup key for one exact merge (same set = same key). */
function mergeSourceKey(
  survivorId: string,
  loserIds: readonly string[],
): string {
  const digest = createHash("sha256")
    .update([...loserIds].sort().join(","))
    .digest("hex")
    .slice(0, 16);
  return `merge:${survivorId}:${digest}`;
}

/** The moved/blocked agreement and tag splits, computed from fresh rows. */
async function planChildRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  survivorId: string,
  loserIdsRaw: readonly string[],
) {
  // Prisma list filters want mutable arrays; the raw list stays readonly.
  const loserIds = [...loserIdsRaw];
  const [survivorItems, loserItemCount, loserItems, survivorTags, loserTags] =
    await Promise.all([
      tx.contactItem.findMany({
        where: { tenantId, contactId: survivorId },
        select: { itemId: true },
      }),
      tx.contactItem.count({
        where: { tenantId, contactId: { in: loserIds } },
      }),
      tx.contactItem.findMany({
        where: { tenantId, contactId: { in: loserIds } },
        select: { itemId: true },
      }),
      tx.contactTag.findMany({
        where: { tenantId, contactId: survivorId },
        select: { tagId: true },
      }),
      tx.contactTag.findMany({
        where: { tenantId, contactId: { in: loserIds } },
        select: { tagId: true },
      }),
    ]);

  const survivorItemIds = new Set(survivorItems.map((row) => row.itemId));
  const survivorTagIds = new Set(survivorTags.map((row) => row.tagId));

  let itemsBlocked = 0;
  for (const row of loserItems) {
    if (survivorItemIds.has(row.itemId)) itemsBlocked += 1;
  }
  let tagsDropped = 0;
  for (const row of loserTags) {
    if (survivorTagIds.has(row.tagId)) tagsDropped += 1;
  }

  return {
    counts: {
      contactItems: loserItemCount - itemsBlocked,
      contactItemsBlocked: itemsBlocked,
      contactTagsMoved: loserTags.length - tagsDropped,
      contactTagsDropped: tagsDropped,
    },
    // The item ids the survivor already trades — loser agreements on these
    // cannot move (the (tenantId, contactId, itemId) unique would collide).
    collidingItemIds: [...survivorItemIds],
    survivorTagIds: [...survivorTagIds],
  };
}

/** Read-only merge plan: what would move, what would be blocked, what refuses. */
export async function previewContactMerge(
  authz: TenantAuthzContext,
  input: { survivorId: string; loserIds: readonly string[] },
): Promise<ContactMergePlan> {
  const { survivor, losers, conflicts } = await loadMergePair(
    authz,
    input.survivorId,
    input.loserIds,
  );
  const tenantId = authz.tenantId;
  const loserIds = losers.map((row) => row.id);

  const child = await planChildRows(prisma, tenantId, survivor.id, loserIds);

  const [
    leads,
    convertedLeads,
    documents,
    contactAddresses,
    tasks,
    activityEvents,
  ] = await Promise.all([
    prisma.lead.count({ where: { tenantId, contactId: { in: loserIds } } }),
    prisma.lead.count({
      where: { tenantId, convertedContactId: { in: loserIds } },
    }),
    prisma.document.count({ where: { tenantId, contactId: { in: loserIds } } }),
    prisma.contactAddress.count({
      where: { contactId: { in: loserIds }, contact: { tenantId } },
    }),
    prisma.task.count({ where: { tenantId, contactId: { in: loserIds } } }),
    prisma.activityEvent.count({
      where: { tenantId, contactId: { in: loserIds } },
    }),
  ]);

  return {
    survivorId: survivor.id,
    loserIds,
    reparentCounts: {
      leads,
      convertedLeads,
      documents,
      contactItems: child.counts.contactItems,
      contactItemsBlocked: child.counts.contactItemsBlocked,
      contactAddresses,
      tasks,
      activityEvents,
      contactTagsMoved: child.counts.contactTagsMoved,
      contactTagsDropped: child.counts.contactTagsDropped,
    },
    conflicts,
    canApply: conflicts.length === 0,
  };
}

export interface ContactMergeResult {
  readonly survivorId: string;
  readonly mergedContactIds: readonly string[];
  readonly reparentedLeads: number;
  readonly reparentedDocuments: number;
  readonly reparentedTasks: number;
  readonly reparentedAddresses: number;
  readonly movedContactItems: number;
  readonly movedContactTags: number;
}

/**
 * Execute the merge in ONE transaction. Row-level effects mirror the plan:
 * bulk `updateMany` reparents, collision-skipped agreements, tag union
 * (duplicate links dropped), empty-field absorption onto the survivor, then
 * the losers go ARCHIVED + `supersededById` — never deleted.
 */
export async function applyContactMerge(
  authz: TenantAuthzContext,
  actorId: string,
  input: {
    survivorId: string;
    loserIds: readonly string[];
    confirm: boolean;
  },
): Promise<ContactMergeResult> {
  if (input.confirm !== true) {
    throw new ContactServiceError(
      "VALIDATION",
      "Merging contacts must be explicitly confirmed.",
      "confirm",
    );
  }

  const { survivor, losers, conflicts } = await loadMergePair(
    authz,
    input.survivorId,
    input.loserIds,
  );
  const [firstConflict] = conflicts;
  if (firstConflict) {
    throw new ContactServiceError("CONFLICT", firstConflict.message);
  }

  const tenantId = authz.tenantId;
  const survivorId = survivor.id;
  const loserIds = losers.map((row) => row.id);

  const result = await prisma.$transaction(async (tx) => {
    const child = await planChildRows(tx, tenantId, survivorId, loserIds);

    // ── Reparent ────────────────────────────────────────────────────────────
    const leadsMoved = await tx.lead.updateMany({
      where: { tenantId, contactId: { in: loserIds } },
      data: { contactId: survivorId },
    });
    await tx.lead.updateMany({
      where: { tenantId, convertedContactId: { in: loserIds } },
      data: { convertedContactId: survivorId },
    });
    const documentsMoved = await tx.document.updateMany({
      where: { tenantId, contactId: { in: loserIds } },
      data: { contactId: survivorId },
    });
    const tasksMoved = await tx.task.updateMany({
      where: { tenantId, contactId: { in: loserIds } },
      data: { contactId: survivorId },
    });
    const addressesMoved = await tx.contactAddress.updateMany({
      where: { contactId: { in: loserIds }, contact: { tenantId } },
      data: { contactId: survivorId },
    });
    // Agreements the survivor already holds for the same item stay on the
    // archived loser — they are historical facts about that agreement, and a
    // move would violate the (tenantId, contactId, itemId) unique.
    const itemsMoved = await tx.contactItem.updateMany({
      where: {
        tenantId,
        contactId: { in: loserIds },
        ...(child.collidingItemIds.length > 0
          ? { itemId: { notIn: child.collidingItemIds } }
          : {}),
      },
      data: { contactId: survivorId },
    });
    // Tag union: move links the survivor lacks, then drop the losers' duplicate
    // links (the (contactId, tagId) primary key forbids moving those).
    const tagsMoved = await tx.contactTag.updateMany({
      where: {
        tenantId,
        contactId: { in: loserIds },
        ...(child.survivorTagIds.length > 0
          ? { tagId: { notIn: child.survivorTagIds } }
          : {}),
      },
      data: { contactId: survivorId },
    });
    await tx.contactTag.deleteMany({
      where: { tenantId, contactId: { in: loserIds } },
    });

    // ── Absorb empty profile fields onto the survivor ──────────────────────
    const absorb: Prisma.ContactUpdateInput = {};
    for (const field of ABSORB_TEXT_FIELDS) {
      if (blank(survivor[field]) !== null) continue;
      for (const loser of losers) {
        const value = blank(loser[field]);
        if (value !== null) {
          absorb[field] = value;
          break;
        }
      }
    }
    // Email is uniqueness-checked app-side everywhere else; absorption keeps
    // that rule: only an email no OTHER contact in the tenant claims moves up.
    if (blank(survivor.email) === null) {
      for (const loser of losers) {
        const candidate = blank(loser.email);
        if (candidate === null) continue;
        const claimer = await tx.contact.findFirst({
          where: {
            tenantId,
            email: candidate,
            NOT: { id: { in: [survivorId, ...loserIds] } },
          },
          select: { id: true },
        });
        if (!claimer) {
          absorb.email = candidate;
          break;
        }
      }
    }
    if (survivor.source === null) {
      const donor = losers.find((row) => row.source !== null);
      if (donor?.source !== undefined) absorb.source = donor.source;
    }
    if (survivor.preferredChannel === null) {
      const donor = losers.find((row) => row.preferredChannel !== null);
      if (donor?.preferredChannel !== undefined) {
        absorb.preferredChannel = donor.preferredChannel;
      }
    }
    // Consent is generous in one direction only: a loser's granted consent
    // carries to the survivor (it is the same human/company record), and the
    // EARLIEST recorded grant timestamp wins. Consent is never removed by a
    // merge — that would silently delete a legal basis.
    if (!survivor.marketingConsent) {
      const consenting = losers.filter((row) => row.marketingConsent);
      if (consenting.length > 0) {
        absorb.marketingConsent = true;
        const stamps = consenting
          .map((row) => row.marketingConsentAt)
          .filter((stamp): stamp is Date => stamp !== null)
          .map((stamp) => stamp.getTime());
        absorb.marketingConsentAt =
          stamps.length > 0 ? new Date(Math.min(...stamps)) : new Date();
      }
    }
    if (Object.keys(absorb).length > 0) {
      const survivorUpdated = await tx.contact.updateMany({
        where: { id: survivorId, tenantId },
        data: absorb,
      });
      if (survivorUpdated.count === 0) {
        throw new ContactServiceError(
          "CONFLICT",
          "The contacts changed while merging; nothing was applied.",
        );
      }
    }

    // ── Archive the losers, pointing at the survivor. Never a delete. ──────
    const archived = await tx.contact.updateMany({
      where: { tenantId, id: { in: loserIds } },
      data: {
        status: "ARCHIVED",
        archivedAt: new Date(),
        supersededById: survivorId,
      },
    });
    if (archived.count !== loserIds.length) {
      throw new ContactServiceError(
        "CONFLICT",
        "The contacts changed while merging; nothing was applied.",
      );
    }

    return {
      reparentedLeads: leadsMoved.count,
      reparentedDocuments: documentsMoved.count,
      reparentedTasks: tasksMoved.count,
      reparentedAddresses: addressesMoved.count,
      movedContactItems: itemsMoved.count,
      movedContactTags: tagsMoved.count,
    };
  });

  // After the transaction: the timeline pointer and the audit row. The event
  // is retry-idempotent — the same survivor + loser SET produces the same
  // sourceKey, and `appendActivity` swallows the unique collision.
  await appendActivity(authz, actorId, {
    eventType: "MERGE_APPLIED",
    contactId: survivorId,
    source: "contact:merge",
    sourceKey: mergeSourceKey(survivorId, loserIds),
    payload: { survivorId, loserIds },
  });

  await recordAudit({
    action: AUDIT_CONTACT_MERGED,
    userId: actorId,
    tenantId,
    resource: "Contact",
    resourceId: survivorId,
    // No PII: ids and counts only.
    metadata: { survivorId, loserIds },
  });

  return { survivorId, mergedContactIds: loserIds, ...result };
}

/* ─────────────────────── duplicate candidates (§1.3) ───────────────────────── */

export interface DuplicateCandidate {
  readonly contactId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly score: "strong" | "medium" | "weak";
  readonly basis: readonly string[];
}

interface CandidateRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
}

const CANDIDATE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  companyName: true,
  email: true,
  phone: true,
} satisfies Prisma.ContactSelect;

const SCORE_RANK: Record<DuplicateCandidate["score"], number> = {
  strong: 0,
  medium: 1,
  weak: 2,
};

/**
 * Score contacts that MIGHT duplicate the given identity and hand them to a
 * human. This function never merges and the UI must never auto-merge: an exact
 * normalized email/phone hit is "strong", company+last name is "medium", and
 * a bare name match is deliberately labelled "weak-ambiguous" because common
 * names collide.
 */
export async function findContactDuplicateCandidates(
  authz: TenantAuthzContext,
  query: {
    email?: string | undefined;
    phone?: string | undefined;
    companyName?: string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
  },
): Promise<readonly DuplicateCandidate[]> {
  const tenantId = authz.tenantId;
  const email = query.email?.trim().toLowerCase() || null;
  const phone = query.phone?.trim() || null;
  const companyName = query.companyName?.trim() || null;
  const firstName = query.firstName?.trim() || null;
  const lastName = query.lastName?.trim() || null;

  const emptyRows: Prisma.ContactGetPayload<{
    select: typeof CANDIDATE_SELECT;
  }>[] = [];

  const runs = await Promise.all([
    email
      ? prisma.contact.findMany({
          where: { tenantId, status: "ACTIVE", email },
          select: CANDIDATE_SELECT,
        })
      : Promise.resolve(emptyRows),
    phone
      ? prisma.contact.findMany({
          where: {
            tenantId,
            status: "ACTIVE",
            OR: [{ phone }, { mobile: phone }],
          },
          select: CANDIDATE_SELECT,
        })
      : Promise.resolve(emptyRows),
    companyName && lastName
      ? prisma.contact.findMany({
          where: {
            tenantId,
            status: "ACTIVE",
            companyName: { equals: companyName, mode: "insensitive" },
            lastName: { equals: lastName, mode: "insensitive" },
          },
          select: CANDIDATE_SELECT,
        })
      : Promise.resolve(emptyRows),
    firstName && lastName
      ? prisma.contact.findMany({
          where: {
            tenantId,
            status: "ACTIVE",
            firstName: { equals: firstName, mode: "insensitive" },
            lastName: { equals: lastName, mode: "insensitive" },
          },
          select: CANDIDATE_SELECT,
        })
      : Promise.resolve(emptyRows),
  ]);

  const scored: [DuplicateCandidate["score"], string][] = [
    ["strong", "email"],
    ["strong", "phone"],
    ["medium", "companyName+lastName"],
    ["weak", "firstName+lastName"],
  ];

  const byId = new Map<
    string,
    { row: CandidateRow; score: DuplicateCandidate["score"]; basis: string[] }
  >();
  runs.forEach((rows, index) => {
    const entry = scored[index];
    if (!entry) return;
    const [score, basis] = entry;
    if (!score || !basis) return;
    for (const row of rows) {
      const seen = byId.get(row.id);
      if (!seen) {
        byId.set(row.id, { row, score, basis: [basis] });
        continue;
      }
      seen.basis.push(basis);
      if (SCORE_RANK[score] < SCORE_RANK[seen.score]) seen.score = score;
    }
  });

  const candidates = [...byId.values()]
    .map(({ row, score, basis }) => ({
      contactId: row.id,
      displayName:
        [row.firstName, row.lastName]
          .filter((part) => !isEmptyText(part))
          .join(" ") ||
        row.companyName ||
        "Unnamed contact",
      email: row.email,
      score,
      basis: [...new Set(basis)],
    }))
    .sort(
      (a, b) =>
        SCORE_RANK[a.score] - SCORE_RANK[b.score] ||
        a.displayName.localeCompare(b.displayName),
    );

  return candidates.slice(0, 25);
}
