"use server";

import type { ContactStatus, UserStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  grantPortalAccessSchema,
  portalAccessQuerySchema,
  revokePortalAccessSchema,
} from "@/lib/validations/portal-access";

/**
 * Customer portal access management — the staff-facing half of the customer
 * portal.
 *
 * The whole of a customer's portal access is one nullable column,
 * `Contact.portalUserId` (see the comment on that field in
 * `apps/web/prisma/schema.prisma`). The portal resolver
 * (`apps/web/src/server/services/documents/portal.ts`) re-reads that link on
 * every request and then refuses any document whose `contactId` is not the
 * linked contact, which gives this surface two properties worth stating:
 *
 *  - granting is only meaningful together with the account's role. A `User` may
 *    be linked here, but sees nothing until it also holds a CUSTOMER_PORTAL_USER
 *    membership in THIS tenant — and this file refuses to link an account that
 *    does not. So there is exactly one door through which a person acquires the
 *    portal role (the Team page's invitation flow), and no way to widen it from
 *    a settings screen.
 *  - revoking takes effect immediately and needs no session teardown: the next
 *    portal request finds `portalUserId` null and the portal guard reports
 *    "no portal is linked to this account". Nothing is deleted, so the customer's
 *    documents, and the audit trail of who could see them, both survive.
 *
 * Every action here asks for `PERMISSIONS.PORTAL_ACCESS_MANAGE`, which only
 * TENANT_OWNER and TENANT_ADMIN hold. It is a write permission, so
 * `authorizeTenant` additionally refuses it for a suspended workspace and for a
 * provider support grant: support can read a business's records under an explicit
 * grant, but can never hand one of its customers a portal login.
 */

const PORTAL_ROLE = "CUSTOMER_PORTAL_USER" as const;

/**
 * One projection for every contact this surface reads, declared once so the
 * Prisma payload and the returned rows cannot disagree. `portalUser` is a
 * relation read, and the `user_select` policy admits exactly the users who share
 * a tenant with the caller — so an account that somehow belongs elsewhere reads
 * back as `null` here rather than as somebody's name.
 */
const contactLinkSelect = {
  id: true,
  type: true,
  firstName: true,
  lastName: true,
  companyName: true,
  email: true,
  status: true,
  portalUserId: true,
  portalUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ContactSelect;

type LinkedContact = Prisma.ContactGetPayload<{
  select: typeof contactLinkSelect;
}>;

export interface PortalAccessCustomer {
  id: string;
  /** Company name, or the person's names, computed server-side for display. */
  displayName: string;
  type: "INDIVIDUAL" | "BUSINESS";
  email: string | null;
  status: ContactStatus;
  portalUserId: string | null;
  portalUser: { id: string; name: string | null; email: string | null } | null;
  /**
   * False when the stored link no longer leads anywhere: the account lost its
   * CUSTOMER_PORTAL_USER membership, its user row is not visible in this tenant,
   * or its own account is not ACTIVE. The row is still a real link — it just
   * cannot be used, and the screen says so instead of showing a green tick.
   */
  linkIsLive: boolean;
}

export interface PortalAccessAccount {
  userId: string;
  name: string | null;
  email: string | null;
  accountStatus: UserStatus;
  joinedAt: Date;
  /** The one customer this account can see, if any (unique per tenant). */
  linkedContactId: string | null;
  linkedContactName: string | null;
}

export interface PortalAccessOverview {
  /** Every CUSTOMER_PORTAL_USER member of the workspace. */
  accounts: PortalAccessAccount[];
  /** Every customer that currently has a link, including archived customers. */
  linked: PortalAccessCustomer[];
  /** One page of ACTIVE, not-yet-linked customers. */
  candidates: PortalAccessCustomer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Accounts nobody has linked yet — the empty state's call to action. */
  unlinkedAccountCount: number;
}

/** Matches the contacts list: a business is named by its company, a person by name. */
function displayName(contact: {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  const company = contact.companyName?.trim();
  if (company) return company;
  const person = [contact.firstName, contact.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  // A contact row may legitimately have no name at all (every text column on
  // `Contact` is nullable); the screen still needs something to label the row.
  return person || "Untitled customer";
}

function toCustomer(
  contact: LinkedContact,
  livePortalUserIds: ReadonlySet<string>,
): PortalAccessCustomer {
  return {
    id: contact.id,
    displayName: displayName(contact),
    type: contact.type,
    email: contact.email,
    status: contact.status,
    portalUserId: contact.portalUserId,
    portalUser: contact.portalUser,
    linkIsLive:
      contact.portalUserId !== null &&
      contact.portalUser !== null &&
      livePortalUserIds.has(contact.portalUserId),
  };
}

/**
 * A portal-role membership as this surface needs it. The `user` half is written
 * as possibly-null on purpose: Prisma types a required relation as always
 * present, but a row the `user_select` policy hides comes back without it, and
 * the code below behaves as though that can happen rather than trusting the
 * generated type.
 */
type PortalMemberRow = {
  userId: string;
  joinedAt: Date;
  user: {
    name: string | null;
    email: string | null;
    status: UserStatus;
  } | null;
};

/** The accounts that can be linked: portal role, this tenant. */
async function listPortalAccounts(
  tenantId: string,
): Promise<PortalMemberRow[]> {
  return prisma.tenantMember.findMany({
    where: { tenantId, role: PORTAL_ROLE },
    orderBy: { joinedAt: "asc" },
    select: {
      userId: true,
      joinedAt: true,
      user: { select: { name: true, email: true, status: true } },
    },
  });
}

export async function getPortalAccessOverviewAction(
  rawInput: unknown,
): Promise<ActionResult<PortalAccessOverview>> {
  const session = await requireAuth();

  const parsed = portalAccessQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const { tenantId, search, page, pageSize } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PORTAL_ACCESS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "getPortalAccessOverviewAction");
  }

  // Two separate lists rather than one filtered union: a business wants to see
  // who already has a login, and separately which of its customers could be
  // given one. Searching narrows the second list; the first is always complete,
  // because a forgotten link is the thing this page exists to make visible.
  const searchWhere: Prisma.ContactWhereInput = search
    ? {
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { companyName: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      }
    : {};

  const candidateWhere: Prisma.ContactWhereInput = {
    tenantId: context.tenantId,
    status: "ACTIVE",
    portalUserId: null,
    ...searchWhere,
  };

  try {
    const [members, linkedContacts, candidates, total] = await Promise.all([
      listPortalAccounts(context.tenantId),
      prisma.contact.findMany({
        where: { tenantId: context.tenantId, portalUserId: { not: null } },
        orderBy: [
          { companyName: "asc" },
          { lastName: "asc" },
          { firstName: "asc" },
        ],
        select: contactLinkSelect,
      }),
      prisma.contact.findMany({
        where: candidateWhere,
        orderBy: [
          { companyName: "asc" },
          { lastName: "asc" },
          { firstName: "asc" },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: contactLinkSelect,
      }),
      prisma.contact.count({ where: candidateWhere }),
    ]);

    const livePortalUserIds = new Set(
      members
        .filter((member) => member.user?.status === "ACTIVE")
        .map((member) => member.userId),
    );

    // `@@unique([tenantId, portalUserId])` means at most one customer per
    // account, so this join is one-to-one by construction.
    const linkByUser = new Map(
      linkedContacts
        .filter((contact) => contact.portalUserId)
        .map((contact) => [contact.portalUserId as string, contact]),
    );

    const accounts: PortalAccessAccount[] = members.map((member) => {
      const linked = linkByUser.get(member.userId);
      return {
        userId: member.userId,
        name: member.user?.name ?? null,
        email: member.user?.email ?? null,
        accountStatus: member.user?.status ?? "INACTIVE",
        joinedAt: member.joinedAt,
        linkedContactId: linked?.id ?? null,
        linkedContactName: linked ? displayName(linked) : null,
      };
    });

    return {
      success: true,
      data: {
        accounts,
        linked: linkedContacts.map((contact) =>
          toCustomer(contact, livePortalUserIds),
        ),
        candidates: candidates.map((contact) =>
          toCustomer(contact, livePortalUserIds),
        ),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        unlinkedAccountCount: accounts.filter(
          (account) => !account.linkedContactId,
        ).length,
      },
    };
  } catch (err) {
    console.error("[getPortalAccessOverviewAction]", err);
    return fail("Failed to load portal access.", { code: "INTERNAL" });
  }
}

/**
 * Grant portal access to one customer.
 *
 * The four checks below are ordered so that each failure names the thing the
 * operator can actually fix, and all of them run against rows filtered by the
 * authorized tenant id — never the one the client sent.
 */
export async function grantPortalAccessAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = grantPortalAccessSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, contactId, portalUserId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PORTAL_ACCESS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "grantPortalAccessAction");
  }

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId: context.tenantId },
    select: { id: true, status: true, portalUserId: true },
  });

  if (!contact) {
    return fail("Customer not found.", {
      code: "NOT_FOUND",
      fieldErrors: { contactId: ["Customer not found"] },
    });
  }

  // An archived customer keeps its documents, but is not a customer you can
  // hand a new login to.
  if (contact.status === "ARCHIVED") {
    return fail(
      "This customer is archived. Restore it before granting portal access.",
      {
        code: "CONFLICT",
        fieldErrors: { contactId: ["Customer is archived"] },
      },
    );
  }

  // A resubmitted form must not report a conflict: the link the operator asked
  // for already exists, so nothing further happens and the screen just reloads.
  if (contact.portalUserId === portalUserId) {
    return ok();
  }

  if (contact.portalUserId) {
    return fail(
      "This customer is already linked to a portal account. Revoke that access before linking another one.",
      {
        code: "CONFLICT",
        fieldErrors: { portalUserId: ["Already linked to another account"] },
      },
    );
  }

  // Membership is looked up by the composite unique key, so a `portalUserId`
  // from another tenant resolves to no row here. RLS reaches the same conclusion
  // independently: `tenant_member_select` only returns rows of tenants the
  // caller belongs to.
  const membership = await prisma.tenantMember.findUnique({
    where: {
      tenantId_userId: { tenantId: context.tenantId, userId: portalUserId },
    },
    select: { role: true },
  });

  if (!membership) {
    return fail(
      "That account is not a member of this workspace. Invite it on the Team page first.",
      {
        code: "NOT_FOUND",
        fieldErrors: { portalUserId: ["Account is not in this workspace"] },
      },
    );
  }

  // No silent promotion: this surface links, it does not assign roles. Changing
  // a member's role belongs to the Team page, where the rank rules and the
  // `tenant_members_guard_role_change` trigger decide who may do it.
  if (membership.role !== PORTAL_ROLE) {
    return fail(
      `That account has the ${membership.role.replace(/_/g, " ").toLowerCase()} role. Only a Customer portal user can be linked to a customer.`,
      {
        code: "CONFLICT",
        fieldErrors: {
          portalUserId: ["Change the account's role on the Team page"],
        },
      },
    );
  }

  const targetUser = await prisma.user.findFirst({
    where: { id: portalUserId },
    select: { status: true },
  });

  if (!targetUser) {
    return fail("That portal account could not be found.", {
      code: "NOT_FOUND",
      fieldErrors: { portalUserId: ["Account not found"] },
    });
  }

  if (targetUser.status !== "ACTIVE") {
    return fail(
      "That account is not active, so it could not sign in to the portal yet.",
      {
        code: "CONFLICT",
        fieldErrors: { portalUserId: ["Account is not active"] },
      },
    );
  }

  // The database's unique index would reject a second link anyway; checking
  // first turns that into a message instead of an internal error.
  const alreadyLinked = await prisma.contact.findFirst({
    where: {
      tenantId: context.tenantId,
      portalUserId,
      id: { not: contactId },
    },
    select: { id: true },
  });

  if (alreadyLinked) {
    return fail(
      "That portal account is already linked to another customer. One account can only see one customer.",
      {
        code: "CONFLICT",
        fieldErrors: { portalUserId: ["Already linked to another customer"] },
      },
    );
  }

  try {
    // Compare-and-set on the value that was read: the tenant predicate keeps the
    // write inside the authorized workspace, and `portalUserId: null` means a
    // concurrent grant that landed in between fails here rather than overwriting
    // somebody else's link.
    const result = await prisma.contact.updateMany({
      where: {
        id: contactId,
        tenantId: context.tenantId,
        portalUserId: null,
      },
      data: { portalUserId },
    });

    if (result.count === 0) {
      return fail(
        "This customer's portal access changed while you were working. Reload and try again.",
        { code: "CONFLICT" },
      );
    }

    await recordAudit({
      action: AUDIT_ACTIONS.PORTAL_ACCESS_GRANTED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Contact",
      resourceId: contactId,
      metadata: { portalUserId },
    });

    return ok();
  } catch (err) {
    console.error("[grantPortalAccessAction]", err);
    return fail("Failed to grant portal access.", { code: "INTERNAL" });
  }
}

/**
 * Revoke a customer's portal access: set the link back to NULL, which is the
 * documented way to remove it.
 *
 * The customer row and every document that references it are untouched, so the
 * historical record stays intact and re-granting later is possible. Revoking an
 * unlinked customer succeeds without writing or auditing: the end state the
 * operator asked for is already true, and a second click on a slow connection
 * must not surface an error.
 */
export async function revokePortalAccessAction(
  rawInput: unknown,
): Promise<ActionResult> {
  const session = await requireAuth();

  const parsed = revokePortalAccessSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, contactId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.PORTAL_ACCESS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "revokePortalAccessAction");
  }

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId: context.tenantId },
    select: { id: true, portalUserId: true },
  });

  if (!contact) {
    return fail("Customer not found.", {
      code: "NOT_FOUND",
      fieldErrors: { contactId: ["Customer not found"] },
    });
  }

  if (!contact.portalUserId) {
    return ok();
  }

  const previousPortalUserId = contact.portalUserId;

  try {
    const result = await prisma.contact.updateMany({
      where: {
        id: contactId,
        tenantId: context.tenantId,
        portalUserId: previousPortalUserId,
      },
      data: { portalUserId: null },
    });

    if (result.count === 0) {
      return fail(
        "This customer's portal access changed while you were working. Reload and try again.",
        { code: "CONFLICT" },
      );
    }

    // Ids only: the audit trail records that a link was removed and between
    // which rows, not the customer's name or the account holder's email.
    await recordAudit({
      action: AUDIT_ACTIONS.PORTAL_ACCESS_REVOKED,
      userId: session.user.id,
      tenantId: context.tenantId,
      resource: "Contact",
      resourceId: contactId,
      metadata: { previousPortalUserId },
    });

    return ok();
  } catch (err) {
    console.error("[revokePortalAccessAction]", err);
    return fail("Failed to revoke portal access.", { code: "INTERNAL" });
  }
}
