import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantRole } from "@prisma/client";

/**
 * AGENT 4 — customer portal access management.
 *
 * These suites run the real Server Actions in
 * `apps/web/src/server/actions/portal-access.ts` against a mocked Prisma client
 * and assert on the arguments handed to Prisma, because those arguments ARE the
 * production query. Three properties matter and each is tested directly:
 *
 *  1. Nothing is trusted from the client but a locator. The tenant predicate on
 *     every read and every write is the tenant id the authorization layer
 *     resolved, so a forged `tenantId`, `contactId` or `portalUserId` reads as
 *     "not found" rather than touching another workspace's row.
 *  2. A portal login is granted only in combination with the CUSTOMER_PORTAL_USER
 *     role that the Team page's invitation flow owns. This surface links; it
 *     never promotes, never creates an identity, and never overwrites a link
 *     that already exists.
 *  3. Only the link column moves. A payload carrying contact fields must not be
 *     able to write them, which is asserted on the literal `data` object Prisma
 *     receives.
 *
 * The fake contact/member tables below are deliberately strict: a query that
 * dropped its `tenantId` filter would match nothing and fail the test, rather
 * than quietly returning a foreign row.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));

import { prismaMock, auditsFor } from "./prisma-mock";
import { authMock } from "./auth-mock";
import { AUDIT_ACTIONS } from "@/lib/audit";
import {
  getPortalAccessOverviewAction,
  grantPortalAccessAction,
  revokePortalAccessAction,
  type PortalAccessOverview,
} from "@/server/actions/portal-access";
import {
  grantPortalAccessSchema,
  portalAccessQuerySchema,
  revokePortalAccessSchema,
} from "@/lib/validations/portal-access";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

const CONTACT_LINKED = "33333333-3333-4333-8333-333333330002";
const CONTACT_ARCHIVED = "33333333-3333-4333-8333-333333330003";
const CONTACT_STALE = "33333333-3333-4333-8333-333333330004";
const CONTACT_FREE = "33333333-3333-4333-8333-333333330001";
const FOREIGN_CONTACT = "33333333-3333-4333-8333-333333330009";

const PORTAL_LINKED_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const PORTAL_FREE_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
const PORTAL_UNLINKED_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
const STAFF_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";

type ContactRow = {
  id: string;
  tenantId: string;
  type: "INDIVIDUAL" | "BUSINESS";
  status: "ACTIVE" | "ARCHIVED";
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  portalUserId: string | null;
  /** A column this surface must never write, used as the mass-assignment marker. */
  notes: string;
};

type MemberRow = {
  tenantId: string;
  userId: string;
  role: TenantRole;
  joinedAt: Date;
  userStatus: "ACTIVE" | "INACTIVE" | "INVITED" | "SUSPENDED";
  name: string | null;
  email: string | null;
};

function contactRow(
  id: string,
  overrides: Partial<ContactRow> = {},
): ContactRow {
  return {
    id,
    tenantId: TENANT_ID,
    type: "INDIVIDUAL",
    status: "ACTIVE",
    firstName: "Customer",
    lastName: id.slice(-1),
    companyName: null,
    email: `c${id.slice(-1)}@example.com`,
    portalUserId: null,
    notes: "unchanged",
    ...overrides,
  };
}

function memberRow(
  userId: string,
  role: TenantRole,
  overrides: Partial<MemberRow> = {},
): MemberRow {
  return {
    tenantId: TENANT_ID,
    userId,
    role,
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
    userStatus: "ACTIVE",
    name: `User ${userId.slice(-2)}`,
    email: `${userId.slice(-2)}@customer.example`,
    ...overrides,
  };
}

let contacts: ContactRow[];
let members: MemberRow[];

/** Every read/write of this suite's own tenant, and nothing else's. */
function resetRows() {
  contacts = [
    contactRow(CONTACT_FREE),
    contactRow(CONTACT_LINKED, { portalUserId: PORTAL_LINKED_USER }),
    contactRow(CONTACT_ARCHIVED, {
      status: "ARCHIVED",
      portalUserId: PORTAL_FREE_USER,
    }),
    contactRow(CONTACT_STALE, { portalUserId: STAFF_MEMBER }),
    // Another workspace, reachable only by a query that forgot its tenant.
    contactRow(FOREIGN_CONTACT, {
      tenantId: OTHER_TENANT_ID,
      portalUserId: OUTSIDER,
    }),
  ];
  members = [
    memberRow(ACTOR_ID, "TENANT_OWNER"),
    memberRow(PORTAL_LINKED_USER, "CUSTOMER_PORTAL_USER"),
    memberRow(PORTAL_FREE_USER, "CUSTOMER_PORTAL_USER"),
    // A portal account with no customer yet — the state the picker is for.
    memberRow(PORTAL_UNLINKED_USER, "CUSTOMER_PORTAL_USER"),
    memberRow(STAFF_MEMBER, "VIEWER"),
    // The outsider belongs to the other workspace only.
    memberRow(OUTSIDER, "CUSTOMER_PORTAL_USER", { tenantId: OTHER_TENANT_ID }),
  ];
}

function contains(value: unknown, needle: unknown): boolean {
  const term = (needle as { contains?: string }).contains ?? "";
  return String(value ?? "")
    .toLowerCase()
    .includes(String(term).toLowerCase());
}

/**
 * `Contact` predicate evaluation. Strict on `tenantId`: a query without the
 * authorized tenant id matches no row, so a missing tenant predicate cannot pass
 * a test by accident.
 */
function matchesContact(row: ContactRow, where: Record<string, unknown>) {
  if (typeof where.tenantId === "string") {
    if (row.tenantId !== where.tenantId) return false;
  } else {
    return false;
  }

  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (where.id && typeof where.id !== "string") {
    const not = (where.id as { not?: string }).not;
    if (not !== undefined && row.id === not) return false;
  }
  if (typeof where.status === "string" && row.status !== where.status) {
    return false;
  }

  if (where.portalUserId === null && row.portalUserId !== null) return false;
  if (typeof where.portalUserId === "string") {
    if (row.portalUserId !== where.portalUserId) return false;
  } else if (where.portalUserId && typeof where.portalUserId === "object") {
    const not = (where.portalUserId as { not?: unknown }).not;
    // `{ not: null }` is the "has a link" filter.
    if (not === null && row.portalUserId === null) return false;
  }

  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (or) {
    const columns = row as unknown as Record<string, unknown>;
    const hit = or.some((clause) =>
      Object.keys(clause).some((key) => contains(columns[key], clause[key])),
    );
    if (!hit) return false;
  }

  return true;
}

/** The `portalUser` relation, resolved the way RLS would: co-members only. */
function project(row: ContactRow) {
  const linked = row.portalUserId
    ? members.find(
        (member) =>
          member.tenantId === row.tenantId &&
          member.userId === row.portalUserId,
      )
    : undefined;

  return {
    ...row,
    portalUser: linked
      ? { id: linked.userId, name: linked.name, email: linked.email }
      : null,
  };
}

function findArg(args: unknown): Record<string, unknown> {
  return (args as { where?: Record<string, unknown> }).where ?? {};
}

/** Rows ordered, sliced and projected exactly as the action asks for them. */
function contactFindMany(args: unknown) {
  const all = args as {
    where?: Record<string, unknown>;
    skip?: number;
    take?: number;
  };
  const matched = contacts.filter((row) => matchesContact(row, findArg(all)));
  const skipped = matched.slice(all.skip ?? 0);
  return skipped.slice(0, all.take ?? skipped.length).map(project);
}

/**
 * `TenantMember.findUnique` on the composite key serves BOTH the authorization
 * lookup of the actor and the target-account role check, because the action uses
 * the same delegate for both. Dispatching on the key keeps that honest: the
 * target's role is read from the rows below, never assumed.
 */
function memberFindUnique(args: unknown) {
  const key =
    (
      args as {
        where?: { tenantId_userId?: { tenantId?: string; userId?: string } };
      }
    ).where?.tenantId_userId ?? {};
  const member = members.find(
    (row) => row.tenantId === key.tenantId && row.userId === key.userId,
  );
  if (!member) return null;
  const tenantStatus =
    member.tenantId === key.tenantId ? tenantStatusForActor : "PENDING";
  return { role: member.role, tenant: { status: tenantStatus } };
}

type TenantStatus = "ACTIVE" | "SUSPENDED" | "PENDING";
let tenantStatusForActor: TenantStatus = "ACTIVE";

/** Neutral delegate state so no implementation leaks between cases. */
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  resetRows();
  tenantStatusForActor = "ACTIVE";

  authMock.mockResolvedValue({
    id: ACTOR_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: null,
    status: "ACTIVE",
  });

  prismaMock.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(prismaMock)
      : await Promise.all(arg as Promise<unknown>[]),
  );

  prismaMock.contact.findFirst.mockImplementation(async (args: unknown) => {
    const found = contacts.find((row) => matchesContact(row, findArg(args)));
    return found ? project(found) : null;
  });
  prismaMock.contact.findMany.mockImplementation(contactFindMany);
  prismaMock.contact.count.mockImplementation(
    async (args: unknown) =>
      contacts.filter((row) => matchesContact(row, findArg(args))).length,
  );
  prismaMock.contact.updateMany.mockImplementation(async () => ({ count: 1 }));

  prismaMock.tenantMember.findUnique.mockImplementation(async (args: unknown) =>
    memberFindUnique(args),
  );
  prismaMock.tenantMember.findMany.mockImplementation(async (args: unknown) => {
    const where = findArg(args);
    return members
      .filter(
        (row) =>
          row.tenantId === where.tenantId &&
          (typeof where.role === "string" ? row.role === where.role : true),
      )
      .map((row) => ({
        userId: row.userId,
        joinedAt: row.joinedAt,
        user: { name: row.name, email: row.email, status: row.userStatus },
      }));
  });

  prismaMock.user.findFirst.mockImplementation(async (args: unknown) => {
    const where = findArg(args);
    const member = members.find((row) => row.userId === where.id);
    return member ? { status: member.userStatus } : null;
  });

  /**
   * `resolvePlatformClaims` reads the ACTOR's own platform standing through a
   * unique lookup and throws UNAUTHENTICATED when that row is missing — so every
   * case must answer it, or the action never reaches its tenant check and the
   * failure looks like a permission bug that isn't one. Only the actor is read
   * this way; the target account's status stays on `findFirst` above.
   */
  prismaMock.user.findUnique.mockImplementation(async (args: unknown) => {
    const where = findArg(args);
    const actor = members.find(
      (row) => row.userId === where.id && row.tenantId === TENANT_ID,
    );
    if (!actor) return null;
    return { platformRole: null, status: actor.userStatus };
  });

  prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
});

/** Acts as `role` in the workspace, with the given tenant status. */
function asRole(role: TenantRole, status: TenantStatus = "ACTIVE") {
  members = members.map((row) =>
    row.userId === ACTOR_ID && row.tenantId === TENANT_ID
      ? { ...row, role }
      : row,
  );
  tenantStatusForActor = status;
}

function loose(result: unknown) {
  return result as {
    success: boolean;
    data?: PortalAccessOverview;
    error?: string;
    code?: string;
    fieldErrors?: Record<string, string[]>;
  };
}

function updateArg(index = 0) {
  const calls = prismaMock.contact.updateMany.mock.calls as unknown as Record<
    string,
    unknown
  >[][];
  return (calls[index]?.[0] ?? {}) as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
}

/**
 * The one audit row an action must have written, returned non-optional.
 *
 * `auditsFor` gives back an array, and this project type-checks with
 * `noUncheckedIndexedAccess`, so reading `[audit]` off it yields
 * `MockAuditRow | undefined` — asserting on `audit.metadata` would then be
 * inspecting a value the type system cannot guarantee exists. This keeps
 * "exactly one row was written, and here it is" a single honest step.
 */
function onlyAudit(action: string) {
  const rows = auditsFor(action);
  expect(rows, `expected exactly one "${action}" audit row`).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error(`no "${action}" audit row was written`);
  return row;
}

const grantPayload = {
  tenantId: TENANT_ID,
  contactId: CONTACT_FREE,
  portalUserId: PORTAL_UNLINKED_USER,
};

// ─── Validation schemas ───────────────────────────────────────────────────────

describe("portal access validation schemas", () => {
  it("accepts three uuids and nothing else", () => {
    const parsed = grantPortalAccessSchema.safeParse(grantPayload);
    expect(parsed.success).toBe(true);
  });

  it("rejects a malformed portal account id", () => {
    const parsed = grantPortalAccessSchema.safeParse({
      ...grantPayload,
      portalUserId: "not-a-uuid",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.portalUserId).toBeDefined();
    }
  });

  it("strips every field that is not a locator", () => {
    const parsed = grantPortalAccessSchema.safeParse({
      ...grantPayload,
      notes: "hacked",
      status: "ARCHIVED",
      role: "TENANT_OWNER",
      portalUserId2: PORTAL_LINKED_USER,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual([
        "contactId",
        "portalUserId",
        "tenantId",
      ]);
    }
  });

  it("bounds the overview page so the screen cannot be flooded", () => {
    expect(
      portalAccessQuerySchema.safeParse({ tenantId: TENANT_ID }).success,
    ).toBe(true);
    expect(
      portalAccessQuerySchema.safeParse({
        tenantId: TENANT_ID,
        pageSize: 51,
      }).success,
    ).toBe(false);
    const defaulted = portalAccessQuerySchema.parse({ tenantId: TENANT_ID });
    expect(defaulted).toMatchObject({ page: 1, pageSize: 25 });
  });

  it("keeps a revoke payload to the two locators", () => {
    const parsed = revokePortalAccessSchema.safeParse({
      tenantId: TENANT_ID,
      contactId: CONTACT_LINKED,
      portalUserId: PORTAL_LINKED_USER,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual([
        "contactId",
        "tenantId",
      ]);
    }
  });
});

// ─── Overview ─────────────────────────────────────────────────────────────────

describe("getPortalAccessOverviewAction", () => {
  const query = { tenantId: TENANT_ID };

  it("requires a session", async () => {
    authMock.mockResolvedValue(null);
    await expect(getPortalAccessOverviewAction(query)).rejects.toThrow(
      "REDIRECT:/en/login",
    );
  });

  it("refuses every staff role that does not manage portal access", async () => {
    for (const role of [
      "SALES",
      "FINANCE",
      "OPERATIONS",
      "VIEWER",
      "CUSTOMER_PORTAL_USER",
    ] as TenantRole[]) {
      asRole(role);
      const result = loose(await getPortalAccessOverviewAction(query));
      expect(result.success).toBe(false);
      expect(result.code).toBe("FORBIDDEN");
      // A denial never describes what the caller could not see.
      expect(result.error).toBe(
        "You are not permitted to perform this action.",
      );
    }
  });

  it("refuses a forged tenant id", async () => {
    const result = loose(
      await getPortalAccessOverviewAction({ tenantId: OTHER_TENANT_ID }),
    );
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.contact.findMany).not.toHaveBeenCalled();
  });

  it("refuses to manage logins for a suspended workspace", async () => {
    asRole("TENANT_OWNER", "SUSPENDED");
    const result = loose(await getPortalAccessOverviewAction(query));
    expect(result.code).toBe("FORBIDDEN");
    // The refusal is the audited evidence the suspension is being enforced.
    expect(auditsFor(AUDIT_ACTIONS.TENANT_WRITE_DENIED)).toHaveLength(1);
  });

  it("splits accounts, live links and customers still waiting", async () => {
    const result = loose(await getPortalAccessOverviewAction(query));
    expect(result.success).toBe(true);
    const data = result.data;
    expect(data).toBeDefined();

    // Only this tenant's portal members are listed.
    expect(data?.accounts.map((account) => account.userId).sort()).toEqual(
      [PORTAL_FREE_USER, PORTAL_LINKED_USER, PORTAL_UNLINKED_USER].sort(),
    );
    expect(
      data?.accounts.find((account) => account.userId === PORTAL_LINKED_USER)
        ?.linkedContactId,
    ).toBe(CONTACT_LINKED);
    expect(
      data?.accounts.find((account) => account.userId === PORTAL_FREE_USER)
        ?.linkedContactName,
    ).toContain("Customer");
    expect(data?.unlinkedAccountCount).toBe(1);

    // The archived customer keeps its link so the owner can revoke it.
    expect(data?.linked.map((row) => row.id).sort()).toEqual(
      [CONTACT_ARCHIVED, CONTACT_LINKED, CONTACT_STALE].sort(),
    );

    // Candidates are ACTIVE and unlinked only, and never from another tenant.
    expect(data?.candidates.map((row) => row.id)).toEqual([CONTACT_FREE]);
    expect(data?.total).toBe(1);
    expect(data?.totalPages).toBe(1);
  });

  it("marks a link that no longer leads anywhere", async () => {
    const result = loose(await getPortalAccessOverviewAction(query));
    const stale = result.data?.linked.find((row) => row.id === CONTACT_STALE);
    // `CONTACT_STALE` points at a VIEWER: the row exists, but that account has
    // no portal role, so it cannot sign in.
    expect(stale?.portalUserId).toBe(STAFF_MEMBER);
    expect(stale?.linkIsLive).toBe(false);

    const live = result.data?.linked.find((row) => row.id === CONTACT_LINKED);
    expect(live?.linkIsLive).toBe(true);
  });

  it("treats a non-active account as an unusable link", async () => {
    members = members.map((row) =>
      row.userId === PORTAL_LINKED_USER
        ? { ...row, userStatus: "SUSPENDED" }
        : row,
    );
    const result = loose(await getPortalAccessOverviewAction(query));
    expect(
      result.data?.linked.find((row) => row.id === CONTACT_LINKED)?.linkIsLive,
    ).toBe(false);
  });

  it("searches the customers waiting for access", async () => {
    const result = loose(
      await getPortalAccessOverviewAction({
        tenantId: TENANT_ID,
        search: "nobody-here",
      }),
    );
    expect(result.data?.candidates).toEqual([]);
    expect(result.data?.total).toBe(0);
    // The complete link list is not filtered by a search.
    expect(result.data?.linked).toHaveLength(3);
  });

  it("never reads another workspace's customers", async () => {
    const result = loose(await getPortalAccessOverviewAction(query));
    const ids = [
      ...(result.data?.linked ?? []),
      ...(result.data?.candidates ?? []),
    ].map((row) => row.id);
    expect(ids).not.toContain(FOREIGN_CONTACT);
  });
});

// ─── Grant ────────────────────────────────────────────────────────────────────

describe("grantPortalAccessAction", () => {
  it("refuses an invalid payload before touching the database", async () => {
    const result = loose(
      await grantPortalAccessAction({
        tenantId: TENANT_ID,
        contactId: "nope",
        portalUserId: PORTAL_FREE_USER,
      }),
    );
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.contactId).toBeDefined();
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a role that cannot manage portal access", async () => {
    asRole("SALES");
    const result = loose(await grantPortalAccessAction(grantPayload));
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.PORTAL_ACCESS_GRANTED)).toHaveLength(0);
  });

  it("reads a foreign contact as not found", async () => {
    const result = loose(
      await grantPortalAccessAction({
        ...grantPayload,
        contactId: FOREIGN_CONTACT,
      }),
    );
    expect(result.code).toBe("NOT_FOUND");
    expect(result.fieldErrors?.contactId).toBeDefined();
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a portal account from another workspace", async () => {
    const result = loose(
      await grantPortalAccessAction({
        ...grantPayload,
        portalUserId: OUTSIDER,
      }),
    );
    expect(result.code).toBe("NOT_FOUND");
    expect(result.error).toContain("not a member of this workspace");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("will not grant access to an archived customer", async () => {
    const result = loose(
      await grantPortalAccessAction({
        ...grantPayload,
        contactId: CONTACT_ARCHIVED,
        portalUserId: PORTAL_LINKED_USER,
      }),
    );
    expect(result.code).toBe("CONFLICT");
    expect(result.error).toContain("archived");
  });

  it("does not overwrite a link that already exists", async () => {
    const result = loose(
      await grantPortalAccessAction({
        ...grantPayload,
        contactId: CONTACT_LINKED,
        portalUserId: PORTAL_FREE_USER,
      }),
    );
    expect(result.code).toBe("CONFLICT");
    expect(result.error).toContain("Revoke");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("succeeds idempotently when the link the operator asked for is already there", async () => {
    const result = loose(
      await grantPortalAccessAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_LINKED,
        portalUserId: PORTAL_LINKED_USER,
      }),
    );
    expect(result.success).toBe(true);
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.PORTAL_ACCESS_GRANTED)).toHaveLength(0);
  });

  it("refuses to promote a staff account by linking it", async () => {
    const result = loose(
      await grantPortalAccessAction({
        ...grantPayload,
        portalUserId: STAFF_MEMBER,
      }),
    );
    expect(result.code).toBe("CONFLICT");
    expect(result.error).toContain("Customer portal user");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an account that could not sign in yet", async () => {
    members = members.map((row) =>
      row.userId === PORTAL_UNLINKED_USER
        ? { ...row, userStatus: "INVITED" }
        : row,
    );
    const result = loose(await grantPortalAccessAction(grantPayload));
    expect(result.code).toBe("CONFLICT");
    expect(result.error).toContain("not active");
  });

  it("refuses a second customer for the same portal account", async () => {
    const result = loose(
      await grantPortalAccessAction({
        tenantId: TENANT_ID,
        // `PORTAL_LINKED_USER` already points at `CONTACT_LINKED`.
        contactId: CONTACT_FREE,
        portalUserId: PORTAL_LINKED_USER,
      }),
    );
    expect(result.code).toBe("CONFLICT");
    expect(result.error).toContain("another customer");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("writes only the link column, scoped to the authorized tenant", async () => {
    const result = loose(
      await grantPortalAccessAction({
        ...grantPayload,
        // Mass assignment: none of these reach Prisma.
        notes: "hacked",
        status: "ARCHIVED",
      }),
    );
    expect(result.success).toBe(true);

    const arg = updateArg();
    expect(Object.keys(arg.data)).toEqual(["portalUserId"]);
    expect(arg.data.portalUserId).toBe(PORTAL_UNLINKED_USER);
    expect(arg.where).toEqual({
      id: CONTACT_FREE,
      tenantId: TENANT_ID,
      // Compare-and-set: the write only lands while the customer is unlinked.
      portalUserId: null,
    });

    const audit = onlyAudit(AUDIT_ACTIONS.PORTAL_ACCESS_GRANTED);
    expect(audit).toMatchObject({
      tenantId: TENANT_ID,
      userId: ACTOR_ID,
      resource: "Contact",
      resourceId: CONTACT_FREE,
    });
    // Ids only — no name, no email address in the audit trail.
    expect(audit.metadata).toEqual({ portalUserId: PORTAL_UNLINKED_USER });
  });

  it("reports a conflict when the link changed underneath it", async () => {
    prismaMock.contact.updateMany.mockResolvedValue({ count: 0 });
    const result = loose(await grantPortalAccessAction(grantPayload));
    expect(result.code).toBe("CONFLICT");
    expect(result.error).toContain("while you were working");
    expect(auditsFor(AUDIT_ACTIONS.PORTAL_ACCESS_GRANTED)).toHaveLength(0);
  });

  it("reports an internal failure without a message from the database", async () => {
    prismaMock.contact.updateMany.mockRejectedValue(
      new Error("invalid input for query argument: $1::uuid"),
    );
    const result = loose(await grantPortalAccessAction(grantPayload));
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to grant portal access.");
  });
});

// ─── Revoke ───────────────────────────────────────────────────────────────────

describe("revokePortalAccessAction", () => {
  const payload = { tenantId: TENANT_ID, contactId: CONTACT_LINKED };

  it("refuses a role that cannot manage portal access", async () => {
    asRole("OPERATIONS");
    const result = loose(await revokePortalAccessAction(payload));
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("reads a foreign contact as not found", async () => {
    const result = loose(
      await revokePortalAccessAction({
        tenantId: TENANT_ID,
        contactId: FOREIGN_CONTACT,
      }),
    );
    expect(result.code).toBe("NOT_FOUND");
  });

  it("clears the link, keeping the customer row", async () => {
    const result = loose(await revokePortalAccessAction(payload));
    expect(result.success).toBe(true);

    const arg = updateArg();
    expect(Object.keys(arg.data)).toEqual(["portalUserId"]);
    expect(arg.data.portalUserId).toBeNull();
    expect(arg.where).toEqual({
      id: CONTACT_LINKED,
      tenantId: TENANT_ID,
      portalUserId: PORTAL_LINKED_USER,
    });

    const audit = onlyAudit(AUDIT_ACTIONS.PORTAL_ACCESS_REVOKED);
    expect(audit).toMatchObject({
      tenantId: TENANT_ID,
      resource: "Contact",
      resourceId: CONTACT_LINKED,
    });
    expect(audit.metadata).toEqual({
      previousPortalUserId: PORTAL_LINKED_USER,
    });
  });

  it("succeeds quietly when there is nothing to revoke", async () => {
    const result = loose(
      await revokePortalAccessAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_FREE,
      }),
    );
    expect(result.success).toBe(true);
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.PORTAL_ACCESS_REVOKED)).toHaveLength(0);
  });

  it("revokes an archived customer's still-live link", async () => {
    // Archiving a customer must not silently keep a portal login working; the
    // owner has to be able to see and remove it.
    const result = loose(
      await revokePortalAccessAction({
        tenantId: TENANT_ID,
        contactId: CONTACT_ARCHIVED,
      }),
    );
    expect(result.success).toBe(true);
    expect(updateArg().where).toEqual({
      id: CONTACT_ARCHIVED,
      tenantId: TENANT_ID,
      portalUserId: PORTAL_FREE_USER,
    });
  });

  it("reports a conflict when the link changed underneath it", async () => {
    prismaMock.contact.updateMany.mockResolvedValue({ count: 0 });
    const result = loose(await revokePortalAccessAction(payload));
    expect(result.code).toBe("CONFLICT");
    expect(auditsFor(AUDIT_ACTIONS.PORTAL_ACCESS_REVOKED)).toHaveLength(0);
  });
});
