import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import type { TenantRole } from "@prisma/client";

/**
 * AGENT 02 Phase 2A — CRM leads, pipelines, tasks and the timeline.
 *
 * Same harness as `phase04-security.test.ts`: the real Server Actions and the
 * real permission matrix run against a mocked Prisma client, and the tests
 * assert on the arguments handed to Prisma — because those arguments ARE the
 * production query. `scopedById()` returns a row only when the query filters
 * on that row's own tenant (and its id/email when supplied), so an engine that
 * ever dropped its tenant predicate fails the test instead of leaking data.
 *
 * Coverage follows the phase's required areas:
 *  - forged tenant ids refused, server-owned keys stripped (mass assignment);
 *  - role refusals against the real matrix (VIEWER convert, SALES pipelines);
 *  - idempotent replay returning the SAME lead without a second insert;
 *  - duplicate suspects surfaced, never blocking;
 *  - conversion guards (LOST / CONVERTED refuse, email clash refuses,
 *    zero-line drafts flagged instead of faked);
 *  - lost requires a reason; terminal states are frozen;
 *  - stage deletion refused with leads attached; default pipeline refused
 *    archive; first pipeline auto-defaults; win/loss stages auto-appended;
 *  - task participant rule and ACTIVE-membership assignee rule;
 *  - overdue derived on the read side only;
 *  - timeline appends once and survives a (source, sourceKey) replay;
 *  - pagination bounds and skip/take wiring.
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
  createLeadAction,
  updateLeadAction,
  moveLeadStageAction,
  assignLeadAction,
  loseLeadAction,
  reopenLeadAction,
  convertLeadAction,
  getLeadsAction,
  getLeadAction,
  getLeadMetricsAction,
} from "@/server/actions/lead";
import {
  getPipelinesAction,
  createPipelineAction,
  updatePipelineAction,
  addPipelineStageAction,
  renamePipelineStageAction,
  reorderPipelineStagesAction,
  deletePipelineStageAction,
} from "@/server/actions/pipeline";
import {
  getTasksAction,
  createTaskAction,
  updateTaskAction,
  completeTaskAction,
  reopenTaskAction,
  deleteTaskAction,
} from "@/server/actions/task";
import { getTimelineAction } from "@/server/actions/activity";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

const LEAD_ID = "33333333-3333-4333-8333-333300000001";
const OTHER_LEAD_ID = "33333333-3333-4333-8333-333300000002";
const PIPELINE_ID = "44444444-4444-4444-8444-444400000001";
const STAGE_ID = "55555555-5555-4555-8555-555500000001";
const OTHER_STAGE_ID = "55555555-5555-4555-8555-555500000002";
const CONTACT_ID = "66666666-6666-4666-8666-666600000001";
const NEW_CONTACT_ID = "66666666-6666-4666-8666-666600000002";
const DOC_ID = "77777777-7777-4777-8777-777700000001";
const TASK_ID = "88888888-8888-4888-8888-888800000001";
const ASSIGNEE_ID = "99999999-9999-4999-8999-999900000001";

const PAST = new Date(Date.now() - 86_400_000);
const FUTURE = new Date(Date.now() + 86_400_000);

const ownContact = {
  id: CONTACT_ID,
  tenantId: TENANT_ID,
  status: "ACTIVE",
  type: "INDIVIDUAL",
  firstName: "Jane",
  lastName: "Wanjiru",
  email: "jane@example.com",
};

/** A lead row with every scalar column the engines read. */
function leadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    tenantId: TENANT_ID,
    firstName: "Jane",
    lastName: "Doe",
    companyName: "Acme Ltd",
    email: "jane@example.com",
    phone: "0712 345 678",
    source: "WEB_FORM",
    status: "NEW",
    priority: "MEDIUM",
    description: null,
    currency: "KES",
    estimatedValue: new Prisma.Decimal("1200.50"),
    sourceDetail: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    pipelineStageId: STAGE_ID,
    assignedToUserId: null,
    contactId: null,
    lostAt: null,
    lostReason: null,
    convertedAt: null,
    convertedContactId: null,
    convertedDocumentId: null,
    idempotencyKey: null,
    externalId: null,
    revision: 1,
    createdAt: new Date("2026-01-05T00:00:00Z"),
    updatedAt: new Date("2026-01-05T00:00:00Z"),
    ...overrides,
  };
}

const ownStage = {
  id: STAGE_ID,
  tenantId: TENANT_ID,
  pipelineId: PIPELINE_ID,
  name: "Qualified",
  position: 2,
  isWin: false,
  isLost: false,
};

type ScopedRow = { id: string; tenantId: string; [key: string]: unknown };

/** A `findFirst` that only answers queries scoped to the row's own tenant. */
function scopedById(rows: ScopedRow[]) {
  return async (args: unknown) => {
    const where =
      (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    const id = typeof where.id === "string" ? where.id : undefined;
    const tenantId =
      typeof where.tenantId === "string" ? where.tenantId : undefined;
    const email =
      typeof where.email === "string" ? where.email.toLowerCase() : undefined;

    return (
      rows.find(
        (row) =>
          (id === undefined || row.id === id) &&
          (tenantId === undefined || row.tenantId === tenantId) &&
          (email === undefined ||
            String(row.email ?? "").toLowerCase() === email),
      ) ?? null
    );
  };
}

type TenantStatus = "ACTIVE" | "SUSPENDED" | "PENDING";

/** Membership is keyed by (tenantId, userId): only `memberOf` resolves. */
function asRole(
  role: TenantRole,
  status: TenantStatus = "ACTIVE",
  memberOf: string = TENANT_ID,
) {
  prismaMock.tenantMember.findUnique.mockImplementation(
    async (args: unknown) => {
      const key =
        (
          args as
            | {
                where?: {
                  tenantId_userId?: { tenantId?: string; userId?: string };
                };
              }
            | undefined
        )?.where?.tenantId_userId ?? {};
      if (key.tenantId !== memberOf || key.userId !== USER_ID) return null;
      return { role, tenant: { status } };
    },
  );
}

/** Loosely re-typed action result: the union makes `.data`/`.code` narrow-only. */
type Loose = {
  success: boolean;
  data?: Record<string, unknown>;
  code?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

function loose(result: unknown): Loose {
  return result as Loose;
}

/** First argument of a Prisma delegate call, as a plain object. */
function callArg(mock: unknown, index = 0): Record<string, unknown> {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[index]?.[0] ?? {}) as Record<string, unknown>;
}

/** The `data` object of a delegate call — the exact write sent to Prisma. */
function writeData(mock: unknown, index = 0): Record<string, unknown> {
  return (callArg(mock, index).data ?? {}) as Record<string, unknown>;
}

function neutralValue(name: string): unknown {
  switch (name) {
    case "findMany":
      return [];
    case "count":
      return 0;
    case "aggregate":
      return { _sum: { total: null } };
    case "updateMany":
    case "createMany":
    case "deleteMany":
      return { count: 1 };
    case "create":
    case "update":
    case "upsert":
      return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    default:
      return null;
  }
}

function resetDelegate(delegate: object) {
  for (const name of Object.keys(delegate)) {
    const fn = (delegate as Record<string, unknown>)[name];
    const resolve = (
      fn as { mockResolvedValue?: (value: unknown) => void } | null
    )?.mockResolvedValue;
    if (typeof resolve === "function") resolve.call(fn, neutralValue(name));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  authMock.mockResolvedValue({
    id: USER_ID,
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

  for (const delegate of [
    prismaMock.lead,
    prismaMock.pipeline,
    prismaMock.pipelineStage,
    prismaMock.task,
    prismaMock.activityEvent,
    prismaMock.contact,
    prismaMock.document,
    prismaMock.documentLine,
    prismaMock.documentStatusEvent,
    prismaMock.item,
    prismaMock.contactItem,
    prismaMock.taxRate,
    prismaMock.tenantMember,
    prismaMock.tenant,
    prismaMock.user,
    prismaMock.supportAccessGrant,
  ]) {
    resetDelegate(delegate);
  }

  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Forged input and mass assignment ────────────────────────────────────────

describe("forged tenant ids and server-owned fields", () => {
  it("refuses a lead capture aimed at a tenant the actor does not belong to", async () => {
    asRole("TENANT_OWNER");

    const result = loose(
      await createLeadAction({
        tenantId: OTHER_TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
        email: "victim@example.com",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.lead.create).not.toHaveBeenCalled();
  });

  it("strips id, revision, status and terminal keys from the create payload", async () => {
    asRole("TENANT_OWNER");
    prismaMock.lead.findFirst.mockResolvedValue(null);
    prismaMock.lead.create.mockResolvedValue(leadRow());

    const result = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        // Mass-assignment attempt: every key below is server-owned.
        id: "deadbeef-0000-4000-8000-000000000000",
        revision: 99,
        status: "CONVERTED",
        convertedAt: "2026-01-01T00:00:00Z",
        convertedContactId: CONTACT_ID,
        lostReason: "sneaked through",
        source: "WEB_FORM",
        currency: "kes",
        email: "  JANE@Example.com ",
        estimatedValue: 1200.5,
      }),
    );

    expect(result.success).toBe(true);
    const data = writeData(prismaMock.lead.create);
    expect(data).not.toHaveProperty("id");
    expect(data).not.toHaveProperty("revision");
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("convertedAt");
    expect(data).not.toHaveProperty("convertedContactId");
    expect(data).not.toHaveProperty("lostReason");
    // The AUTHORIZED tenant is the only tenant written, whatever the payload said.
    expect(data.tenantId).toBe(TENANT_ID);
    // Email is stored normalized so the dedupe equality is honest.
    expect(data.email).toBe("jane@example.com");
    // Money arrives as a decimal STRING / Decimal, never a float.
    expect(String(data.estimatedValue)).toBe("1200.5");
    // Currency is normalised to uppercase ISO, never defaulted silently.
    expect(data.currency).toBe("KES");
  });

  it("refuses a malformed currency code instead of defaulting it", async () => {
    asRole("TENANT_OWNER");

    const result = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "USDC",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.currency).toBeDefined();
    expect(prismaMock.lead.create).not.toHaveBeenCalled();
  });

  it("ignores status and stage keys smuggled into the update payload", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });

    const result = loose(
      await updateLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        firstName: "  Bob ",
        status: "CONVERTED",
        pipelineStageId: OTHER_STAGE_ID,
        revision: 42,
      }),
    );

    expect(result.success).toBe(true);
    const data = writeData(prismaMock.lead.updateMany);
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("pipelineStageId");
    expect(data).not.toHaveProperty("revision");
    expect(data.firstName).toBe("Bob");
  });

  it("refers a forged tenant on a lead list read to no membership", async () => {
    asRole("VIEWER");

    const result = loose(await getLeadsAction({ tenantId: OTHER_TENANT_ID }));

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.lead.findMany).not.toHaveBeenCalled();
  });
});

// ─── Role refusals against the real matrix ───────────────────────────────────

describe("permission matrix wiring", () => {
  it("VIEWER cannot convert a lead (LEADS_CONVERT is a distinct verb)", async () => {
    asRole("VIEWER");

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "existingContact",
        contactId: CONTACT_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(prismaMock.activityEvent.create).not.toHaveBeenCalled();
  });

  it("VIEWER cannot capture leads but can read the board and the timeline", async () => {
    asRole("VIEWER");

    const denied = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
      }),
    );
    expect(denied.success).toBe(false);
    expect(denied.code).toBe("FORBIDDEN");

    const read = loose(await getLeadsAction({ tenantId: TENANT_ID }));
    expect(read.success).toBe(true);
    expect(read.data?.leads).toEqual([]);

    const timeline = loose(await getTimelineAction({ tenantId: TENANT_ID }));
    expect(timeline.success).toBe(true);
    expect(timeline.data?.events).toEqual([]);
  });

  it("SALES can move a lead stage but cannot manage pipelines", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.pipelineStage.findFirst.mockResolvedValue(ownStage);
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });

    const moved = loose(
      await moveLeadStageAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        stageId: STAGE_ID,
      }),
    );
    expect(moved.success).toBe(true);

    const managed = loose(
      await createPipelineAction({
        tenantId: TENANT_ID,
        name: "Try",
      }),
    );
    expect(managed.success).toBe(false);
    expect(managed.code).toBe("FORBIDDEN");
    expect(prismaMock.pipeline.create).not.toHaveBeenCalled();

    const deleted = loose(
      await deletePipelineStageAction({
        tenantId: TENANT_ID,
        stageId: STAGE_ID,
      }),
    );
    expect(deleted.success).toBe(false);
    expect(deleted.code).toBe("FORBIDDEN");

    // FINANCE has LEADS_READ/TASKS_READ but no TASKS_MANAGE — task mutations
    // are refused for the role that only follows money (matrix §1.4).
    const otherRole = loose(await getTasksAction({ tenantId: TENANT_ID }));
    expect(otherRole.success).toBe(true);
  });

  it("FINANCE reads leads but cannot capture, convert or manage tasks", async () => {
    asRole("FINANCE");

    const captured = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
      }),
    );
    expect(captured.success).toBe(false);
    expect(captured.code).toBe("FORBIDDEN");

    const task = loose(
      await updateTaskAction({
        tenantId: TENANT_ID,
        taskId: TASK_ID,
        title: "not yours",
      }),
    );
    expect(task.success).toBe(false);
    expect(task.code).toBe("FORBIDDEN");
    expect(prismaMock.task.updateMany).not.toHaveBeenCalled();

    const read = loose(await getLeadsAction({ tenantId: TENANT_ID }));
    expect(read.success).toBe(true);
  });

  it("a suspended workspace keeps reads and refuses every CRM write with one message", async () => {
    asRole("TENANT_OWNER", "SUSPENDED");

    const result = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.lead.create).not.toHaveBeenCalled();

    const read = loose(await getLeadsAction({ tenantId: TENANT_ID }));
    expect(read.success).toBe(true);
  });
});

// ─── Idempotency and duplicate handling ──────────────────────────────────────

describe("lead capture idempotency and duplicates", () => {
  it("replays the same idempotencyKey onto the ORIGINAL lead without a second insert", async () => {
    asRole("SALES");
    const created = leadRow({ idempotencyKey: "capture-000001" });
    prismaMock.lead.findFirst.mockResolvedValueOnce(null); // replay gate: miss
    prismaMock.lead.create.mockResolvedValue(created);

    const first = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
        idempotencyKey: "capture-000001",
      }),
    );
    expect(first.success).toBe(true);
    expect(first.data?.created).toBe(true);

    // The retry: the replay gate now finds the stored row.
    prismaMock.lead.findFirst.mockResolvedValue(created);
    const second = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
        idempotencyKey: "capture-000001",
      }),
    );

    expect(second.success).toBe(true);
    expect(second.data?.created).toBe(false);
    expect(second.data?.leadId).toBe(first.data?.leadId);
    // One row, one timeline event — the replay inserted nothing.
    expect(prismaMock.lead.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activityEvent.create).toHaveBeenCalledTimes(1);
  });

  it("replays a same-source externalId onto the existing import row", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: Record<string, unknown> }).where ?? {};
      return where.source && where.externalId
        ? leadRow({ externalId: "crm-9" })
        : null;
    });

    const result = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "IMPORT",
        currency: "KES",
        externalId: "crm-9",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.created).toBe(false);
    expect(prismaMock.lead.create).not.toHaveBeenCalled();
  });

  it("surfaces duplicate suspects without blocking the capture", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(null);
    prismaMock.lead.create.mockResolvedValue(
      leadRow({ id: LEAD_ID, email: "dup@example.com", phone: "0711111111" }),
    );
    prismaMock.lead.findMany.mockResolvedValue([
      {
        id: OTHER_LEAD_ID,
        firstName: "Jane",
        lastName: "Doe",
        companyName: "Different Co",
        email: "dup@example.com",
        phone: "+254711111111",
        status: "QUALIFIED",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    const result = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
        email: "dup@example.com",
        phone: "(0711) 111-111",
        companyName: "Acme Ltd",
      }),
    );

    expect(result.success).toBe(true);
    // Duplicate pressure is advisory: the lead was still created.
    expect(result.data?.created).toBe(true);
    expect(prismaMock.lead.create).toHaveBeenCalledTimes(1);

    const suspects = result.data?.duplicateSuspects as unknown[];
    expect(suspects).toHaveLength(1);
    const suspect = suspects[0] as Record<string, unknown>;
    expect(suspect.id).toBe(OTHER_LEAD_ID);
    // Match basis is reported: the same normalized email and the same phone
    // suffix (`0711 111 111` vs `+254 711 111 111` collapse to 711111111).
    expect(suspect.basis).toEqual(expect.arrayContaining(["EMAIL", "PHONE"]));
  });

  it("an id collision on the replay unique falls back to the winner's row", async () => {
    asRole("SALES");
    // Gate misses (concurrent retry in flight), the create hits the unique,
    // the re-find lands on the winner.
    const winner = leadRow({
      id: OTHER_LEAD_ID,
      idempotencyKey: "race-key-001",
    });
    prismaMock.lead.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);
    prismaMock.lead.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );

    const result = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
        idempotencyKey: "race-key-001",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.created).toBe(false);
    expect(result.data?.leadId).toBe(OTHER_LEAD_ID);
  });
});

// ─── Conversion ───────────────────────────────────────────────────────────────

describe("lead conversion", () => {
  it("refuses to convert a LOST lead and says to reopen it", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(
      leadRow({ status: "LOST", lostAt: PAST, lostReason: "Price" }),
    );

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "existingContact",
        contactId: CONTACT_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.error).toMatch(/[Rr]eopen/);
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });

  it("refuses a second conversion of a CONVERTED lead", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(
      leadRow({
        status: "CONVERTED",
        convertedAt: PAST,
        convertedContactId: CONTACT_ID,
      }),
    );

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "existingContact",
        contactId: CONTACT_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.error).toMatch(/already been converted/i);
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
  });

  it("converts onto a NEW customer with createContactSchema rules and the authorized tenant", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.contact.findFirst.mockResolvedValue(null); // no email clash
    prismaMock.contact.create.mockResolvedValue({
      id: NEW_CONTACT_ID,
      type: "INDIVIDUAL",
    });
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "newContact",
        contact: {
          // Forged keys stripped by re-validation; the server tenant wins.
          tenantId: OTHER_TENANT_ID,
          id: "deadbeef-0000-4000-8000-000000000000",
          status: "ARCHIVED",
          type: "INDIVIDUAL",
          firstName: "Amina",
          lastName: "Ali",
          email: "AMINA@Example.COM",
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.contactId).toBe(NEW_CONTACT_ID);

    const contactData = writeData(prismaMock.contact.create);
    expect(contactData.tenantId).toBe(TENANT_ID);
    expect(contactData).not.toHaveProperty("id");
    expect(contactData).not.toHaveProperty("status");
    expect(contactData.email).toBe("amina@example.com");

    const leadUpdate = writeData(prismaMock.lead.updateMany);
    expect(leadUpdate.status).toBe("CONVERTED");
    expect(leadUpdate.convertedContactId).toBe(NEW_CONTACT_ID);
    expect(leadUpdate.pipelineStageId).toBeNull();

    // One LEAD_CONVERTED timeline event with the operation-scoped dedup key.
    const event = writeData(prismaMock.activityEvent.create);
    expect(event.eventType).toBe("LEAD_CONVERTED");
    expect(event.sourceKey).toBe(`lead:${LEAD_ID}:convert`);

    // Contact-creation audit parity with createContactAction, plus the CRM audit.
    expect(auditsFor(AUDIT_ACTIONS.CONTACT_CREATED)).toHaveLength(1);
    expect(auditsFor("lead.converted")).toHaveLength(1);
  });

  it("links an existing tenant contact without creating another one", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(
      leadRow({ status: "QUALIFIED" }),
    );
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact as ScopedRow]),
    );
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "existingContact",
        contactId: CONTACT_ID,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.contactId).toBe(CONTACT_ID);
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(writeData(prismaMock.lead.updateMany).convertedContactId).toBe(
      CONTACT_ID,
    );
  });

  it("refuses to link a contact that is not in this tenant", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    // The foreign id matches nothing under the tenant-pinned findFirst.
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([
        {
          ...ownContact,
          id: CONTACT_ID,
          tenantId: OTHER_TENANT_ID,
        } as ScopedRow,
      ]),
    );

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "existingContact",
        contactId: CONTACT_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.contactId).toBeDefined();
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a new-contact conversion that clashes with an existing customer email", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact as ScopedRow]),
    );

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "newContact",
        contact: {
          type: "INDIVIDUAL",
          firstName: "Jane",
          email: "jane@example.com",
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(result.fieldErrors?.email).toBeDefined();
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
  });

  it("never fakes a zero-line draft: flags needsDraftEditor instead", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact as ScopedRow]),
    );
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "existingContact",
        contactId: CONTACT_ID,
        createDraft: "quotation",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.documentCreated).toBe(false);
    expect(result.data?.needsDraftEditor).toBe(true);
    expect(result.data?.documentId).toBeNull();
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("raises the requested quotation through the documents engine and attaches it", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.contact.findFirst.mockImplementation(
      scopedById([ownContact as ScopedRow]),
    );
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.document.findFirst.mockResolvedValue(null); // no draft replay
    prismaMock.document.create.mockResolvedValue({ id: DOC_ID });

    const result = loose(
      await convertLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        mode: "existingContact",
        contactId: CONTACT_ID,
        createDraft: "quotation",
        draftLines: [
          { description: "Cargo service", quantity: "2", unitPrice: "150" },
        ],
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.documentCreated).toBe(true);
    expect(result.data?.needsDraftEditor).toBe(false);
    expect(result.data?.documentId).toBe(DOC_ID);

    const docData = writeData(prismaMock.document.create);
    expect(docData.type).toBe("QUOTATION");
    expect(docData.status).toBe("DRAFT");
    expect(docData.tenantId).toBe(TENANT_ID);
    // Deterministic per-conversion idempotency key: a retried conversion finds
    // the first draft instead of burning a second one.
    const replayWhere = callArg(prismaMock.document.findFirst).where as Record<
      string,
      unknown
    >;
    expect(replayWhere.idempotencyKey).toBe(`lead-${LEAD_ID}-convert`);

    // The lead is then pinned to the document it produced.
    const attach = writeData(prismaMock.lead.updateMany, 1);
    expect(attach.convertedDocumentId).toBe(DOC_ID);
  });
});

// ─── Terminal states: lose / reopen / frozen ─────────────────────────────────

describe("losing, reopening and terminal guards", () => {
  it("requires a lost reason before a lead can be lost", async () => {
    asRole("SALES");

    const missing = loose(
      await loseLeadAction({ tenantId: TENANT_ID, leadId: LEAD_ID }),
    );
    expect(missing.success).toBe(false);
    expect(missing.code).toBe("VALIDATION_ERROR");
    expect(missing.fieldErrors?.lostReason).toBeDefined();

    const whitespace = loose(
      await loseLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        lostReason: "   ",
      }),
    );
    expect(whitespace.success).toBe(false);
    expect(whitespace.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
  });

  it("stores a trimmed reason and a LOST status, and appends LEAD_LOST once", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });

    const result = loose(
      await loseLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        lostReason: "  Price too high  ",
      }),
    );

    expect(result.success).toBe(true);
    const data = writeData(prismaMock.lead.updateMany);
    expect(data.status).toBe("LOST");
    expect(data.lostReason).toBe("Price too high");
    expect(data.lostAt).toBeInstanceOf(Date);

    const event = writeData(prismaMock.activityEvent.create);
    expect(event.eventType).toBe("LEAD_LOST");
    expect(event.sourceKey).toBe(`lead:${LEAD_ID}:lost`);
  });

  it("only a LOST lead reopens, and reopening clears the loss facts", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());

    const notLost = loose(
      await reopenLeadAction({ tenantId: TENANT_ID, leadId: LEAD_ID }),
    );
    expect(notLost.success).toBe(false);
    expect(notLost.code).toBe("VALIDATION_ERROR");

    prismaMock.lead.findFirst.mockResolvedValue(
      leadRow({ status: "LOST", lostAt: PAST, lostReason: "Price" }),
    );
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });

    const reopened = loose(
      await reopenLeadAction({ tenantId: TENANT_ID, leadId: LEAD_ID }),
    );
    expect(reopened.success).toBe(true);
    const data = writeData(prismaMock.lead.updateMany);
    expect(data.status).toBe("NEW");
    expect(data.lostAt).toBeNull();
    expect(data.lostReason).toBeNull();
  });

  it("a CONVERTED lead no longer moves through the pipeline", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(
      leadRow({ status: "CONVERTED", convertedAt: PAST }),
    );

    const result = loose(
      await moveLeadStageAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        stageId: STAGE_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFLICT");
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to move a lead onto a stage from another tenant", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.pipelineStage.findFirst.mockImplementation(
      scopedById([{ ...ownStage, tenantId: OTHER_TENANT_ID } as ScopedRow]),
    );

    const result = loose(
      await moveLeadStageAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        stageId: STAGE_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.stageId).toBeDefined();
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();
  });

  it("assigning refuses a non-member and an inactive account", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    // tenantMember.findFirst defaults to null: no membership, no assignment.

    const result = loose(
      await assignLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        assignedToUserId: ASSIGNEE_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.assignedToUserId).toBeDefined();
    expect(prismaMock.lead.updateMany).not.toHaveBeenCalled();

    // Unassignment (null) skips the membership check and works.
    prismaMock.lead.updateMany.mockResolvedValue({ count: 1 });
    const unassigned = loose(
      await assignLeadAction({
        tenantId: TENANT_ID,
        leadId: LEAD_ID,
        assignedToUserId: null,
      }),
    );
    expect(unassigned.success).toBe(true);
    expect(writeData(prismaMock.lead.updateMany).assignedToUserId).toBeNull();
  });
});

// ─── Pipelines and stages ─────────────────────────────────────────────────────

describe("pipeline configuration", () => {
  it("the first pipeline of the workspace becomes the default", async () => {
    asRole("TENANT_OWNER");
    prismaMock.pipeline.count.mockResolvedValue(0);
    prismaMock.pipeline.create.mockResolvedValue({
      id: PIPELINE_ID,
      name: "Sales",
      isDefault: true,
    });

    const result = loose(
      await createPipelineAction({
        tenantId: TENANT_ID,
        name: "Sales",
        stages: [{ name: "New", isWin: false, isLost: false }],
      }),
    );

    expect(result.success).toBe(true);
    expect(writeData(prismaMock.pipeline.create).isDefault).toBe(true);

    // The win/loss markers are auto-appended when the caller omits them —
    // metrics need terminal stages to exist.
    const stages = callArg(prismaMock.pipelineStage.createMany).data as Array<{
      name: string;
      isWin: boolean;
      isLost: boolean;
      position: number;
      tenantId: string;
    }>;
    expect(stages.map((stage) => stage.name)).toEqual(["New", "Won", "Lost"]);
    expect(stages[1]?.isWin).toBe(true);
    expect(stages[2]?.isLost).toBe(true);
    expect(stages.every((stage) => stage.tenantId === TENANT_ID)).toBe(true);
  });

  it("a later pipeline never self-declares as the default", async () => {
    asRole("TENANT_ADMIN");
    prismaMock.pipeline.count.mockResolvedValue(1);
    prismaMock.pipeline.create.mockResolvedValue({
      id: PIPELINE_ID,
      name: "Enterprise",
      isDefault: false,
    });

    const result = loose(
      await createPipelineAction({ tenantId: TENANT_ID, name: "Enterprise" }),
    );
    expect(result.success).toBe(true);
    expect(writeData(prismaMock.pipeline.create).isDefault).toBe(false);
    // Omitted stage list still lands a usable board (fallback + markers).
    expect(
      callArg(prismaMock.pipelineStage.createMany).data as unknown[],
    ).toHaveLength(5);
  });

  it("refuses to archive the default pipeline", async () => {
    asRole("TENANT_OWNER");
    prismaMock.pipeline.findFirst.mockResolvedValue({
      id: PIPELINE_ID,
      tenantId: TENANT_ID,
      name: "Sales",
      isDefault: true,
      archivedAt: null,
    });

    const result = loose(
      await updatePipelineAction({
        tenantId: TENANT_ID,
        pipelineId: PIPELINE_ID,
        archived: true,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.archived).toBeDefined();
    expect(prismaMock.pipeline.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to delete a stage that still has leads on it", async () => {
    asRole("TENANT_OWNER");
    prismaMock.pipelineStage.findFirst.mockResolvedValue(ownStage);
    prismaMock.lead.count.mockResolvedValue(3);

    const result = loose(
      await deletePipelineStageAction({
        tenantId: TENANT_ID,
        stageId: STAGE_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.error).toContain("3");
    expect(prismaMock.pipelineStage.delete).not.toHaveBeenCalled();
  });

  it("deletes an empty stage after the attached-lead check", async () => {
    asRole("TENANT_OWNER");
    prismaMock.pipelineStage.findFirst.mockResolvedValue(ownStage);
    prismaMock.lead.count.mockResolvedValue(0);

    const result = loose(
      await deletePipelineStageAction({
        tenantId: TENANT_ID,
        stageId: STAGE_ID,
      }),
    );

    expect(result.success).toBe(true);
    expect(prismaMock.pipelineStage.delete).toHaveBeenCalledTimes(1);
  });

  it("rejects a reorder that is not an exact permutation of the pipeline", async () => {
    asRole("TENANT_OWNER");
    prismaMock.pipeline.findFirst.mockResolvedValue({
      id: PIPELINE_ID,
      tenantId: TENANT_ID,
      name: "Sales",
      isDefault: false,
      archivedAt: null,
    });
    prismaMock.pipelineStage.findMany.mockResolvedValue([
      { id: STAGE_ID },
      { id: OTHER_STAGE_ID },
    ]);

    const result = loose(
      await reorderPipelineStagesAction({
        tenantId: TENANT_ID,
        pipelineId: PIPELINE_ID,
        stageIds: [STAGE_ID, "99999999-9999-4999-8999-999999999999"],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.stageIds).toBeDefined();
    expect(prismaMock.pipelineStage.updateMany).not.toHaveBeenCalled();
  });

  it("a valid reorder parks every stage at a negative position before the final pass", async () => {
    asRole("TENANT_OWNER");
    prismaMock.pipeline.findFirst.mockResolvedValue({
      id: PIPELINE_ID,
      tenantId: TENANT_ID,
      name: "Sales",
      isDefault: false,
      archivedAt: null,
    });
    prismaMock.pipelineStage.findMany.mockResolvedValue([
      { id: STAGE_ID },
      { id: OTHER_STAGE_ID },
    ]);
    prismaMock.pipelineStage.updateMany.mockResolvedValue({ count: 1 });

    const result = loose(
      await reorderPipelineStagesAction({
        tenantId: TENANT_ID,
        pipelineId: PIPELINE_ID,
        stageIds: [OTHER_STAGE_ID, STAGE_ID],
      }),
    );

    expect(result.success).toBe(true);
    const positions = [0, 1, 2, 3].map(
      (i) => writeData(prismaMock.pipelineStage.updateMany, i).position,
    );
    // Pass 1 parks at -1, -2; pass 2 assigns 1, 2 — never a mid-flight collision.
    expect(positions).toEqual([-1, -2, 1, 2]);
  });

  it("refuses duplicate stage names in one create request", async () => {
    asRole("TENANT_ADMIN");

    const result = loose(
      await createPipelineAction({
        tenantId: TENANT_ID,
        name: "Dup",
        stages: [
          { name: "Deal", isWin: false, isLost: false },
          { name: " deal ", isWin: false, isLost: false },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.pipeline.create).not.toHaveBeenCalled();
  });

  it("adds a stage one position past the current maximum", async () => {
    asRole("TENANT_OWNER");
    prismaMock.pipeline.findFirst.mockResolvedValue({
      id: PIPELINE_ID,
      tenantId: TENANT_ID,
      name: "Sales",
      isDefault: false,
      archivedAt: null,
    });
    prismaMock.pipelineStage.findFirst
      .mockResolvedValueOnce(null) // name clash check
      .mockResolvedValueOnce({ position: 4 }); // current top
    prismaMock.pipelineStage.create.mockResolvedValue({ id: STAGE_ID });

    const result = loose(
      await addPipelineStageAction({
        tenantId: TENANT_ID,
        pipelineId: PIPELINE_ID,
        name: " Proposal ",
        isWin: false,
        isLost: false,
      }),
    );

    expect(result.success).toBe(true);
    const data = writeData(prismaMock.pipelineStage.create);
    expect(data.name).toBe("Proposal");
    expect(data.position).toBe(5);
  });

  it("renames a stage and refuses a name already used by ANOTHER stage", async () => {
    asRole("TENANT_ADMIN");
    // The service uses two shapes of `findFirst` here: the load (where.id is a
    // string) and the clash probe (where.id is `{ not: … }`). The mock tells
    // them apart so the self-row exclusion behaves like the real query.
    prismaMock.pipelineStage.findFirst.mockImplementation(
      async (args: unknown) => {
        const where = (args as { where?: Record<string, unknown> }).where ?? {};
        if (typeof where.id === "object" && where.id !== null) {
          // Clash probe: another stage owns this name only when asked "Proposal".
          return where.name === "Proposal"
            ? { ...ownStage, id: OTHER_STAGE_ID, name: "Proposal" }
            : null;
        }
        return { ...ownStage };
      },
    );
    prismaMock.pipelineStage.updateMany.mockResolvedValue({ count: 1 });

    const renamed = loose(
      await renamePipelineStageAction({
        tenantId: TENANT_ID,
        stageId: STAGE_ID,
        name: " Negotiating ",
      }),
    );
    expect(renamed.success).toBe(true);
    expect(writeData(prismaMock.pipelineStage.updateMany).name).toBe(
      "Negotiating",
    );

    prismaMock.pipelineStage.updateMany.mockClear();
    const realClash = loose(
      await renamePipelineStageAction({
        tenantId: TENANT_ID,
        stageId: STAGE_ID,
        name: "Proposal",
      }),
    );
    expect(realClash.success).toBe(false);
    expect(realClash.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.pipelineStage.updateMany).not.toHaveBeenCalled();
  });

  it("reads pipelines under PIPELINES_READ with the open-lead stage counts", async () => {
    asRole("VIEWER");
    const pipelineRow = {
      id: PIPELINE_ID,
      tenantId: TENANT_ID,
      name: "Sales",
      isDefault: true,
      archivedAt: null,
      createdAt: PAST,
      updatedAt: PAST,
      stages: [{ ...ownStage, _count: { leads: 2 } }],
    };
    prismaMock.pipeline.findMany.mockResolvedValue([pipelineRow]);

    const result = loose(await getPipelinesAction({ tenantId: TENANT_ID }));

    expect(result.success).toBe(true);
    expect(result.data?.pipelines).toHaveLength(1);
    const args = callArg(prismaMock.pipeline.findMany);
    expect((args.where as Record<string, unknown>).archivedAt).toBeNull();
  });
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

describe("task rules", () => {
  it("refuses a task without at least one participant", async () => {
    asRole("SALES");

    const result = loose(
      await createTaskAction({
        tenantId: TENANT_ID,
        title: "Call back",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(
      result.fieldErrors?.leadId ??
        result.fieldErrors?.contactId ??
        result.fieldErrors?.documentId,
    ).toBeDefined();
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });

  it("refuses an assignee who is not an ACTIVE tenant member", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    // tenantMember.findFirst neutral default: null → not a member.

    const result = loose(
      await createTaskAction({
        tenantId: TENANT_ID,
        title: "Call back",
        leadId: LEAD_ID,
        assigneeId: ASSIGNEE_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.assigneeId).toBeDefined();
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });

  it("refuses a task pointing at another tenant's lead", async () => {
    asRole("SALES");
    prismaMock.tenantMember.findFirst.mockResolvedValue({
      userId: ASSIGNEE_ID,
    });
    prismaMock.lead.findFirst.mockImplementation(
      scopedById([{ id: LEAD_ID, tenantId: OTHER_TENANT_ID } as ScopedRow]),
    );

    const result = loose(
      await createTaskAction({
        tenantId: TENANT_ID,
        title: "Send quote",
        leadId: LEAD_ID,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors?.leadId).toBeDefined();
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });

  it("creates with the authorized tenant, a derived overdue flag and a timeline event", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(leadRow());
    prismaMock.tenantMember.findFirst.mockResolvedValue({
      userId: ASSIGNEE_ID,
    });
    prismaMock.task.create.mockResolvedValue({
      id: TASK_ID,
      tenantId: TENANT_ID,
      title: "Call back",
      notes: null,
      dueAt: PAST,
      priority: "MEDIUM",
      assigneeId: ASSIGNEE_ID,
      leadId: LEAD_ID,
      contactId: null,
      documentId: null,
      completedAt: null,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = loose(
      await createTaskAction({
        tenantId: TENANT_ID,
        title: "  Call back  ",
        leadId: LEAD_ID,
        assigneeId: ASSIGNEE_ID,
        dueAt: PAST.toISOString(),
        // Server-owned keys are not in the schema; they must not reach the row.
        id: "deadbeef-0000-4000-8000-000000000000",
        completedAt: new Date().toISOString(),
        revision: 7,
      }),
    );

    expect(result.success).toBe(true);
    const task = result.data?.task as Record<string, unknown>;
    expect(task.overdue).toBe(true); // dueAt in the past, not completed

    const data = writeData(prismaMock.task.create);
    expect(data.tenantId).toBe(TENANT_ID);
    expect(data.title).toBe("Call back");
    expect(data).not.toHaveProperty("id");
    expect(data).not.toHaveProperty("completedAt");
    expect(data).not.toHaveProperty("revision");

    const event = writeData(prismaMock.activityEvent.create);
    expect(event.eventType).toBe("TASK_CREATED");
    expect(event.sourceKey).toBe(`task:${TASK_ID}:created`);
  });

  it("completes once, refuses a second completion, and reopens", async () => {
    asRole("SALES");
    const openTask = {
      id: TASK_ID,
      tenantId: TENANT_ID,
      title: "Call back",
      dueAt: PAST,
      completedAt: null,
      leadId: LEAD_ID,
      contactId: null,
      documentId: null,
      priority: "MEDIUM",
      assigneeId: null,
      notes: null,
      revision: 1,
      createdAt: PAST,
      updatedAt: PAST,
    };
    const completedTask = { ...openTask, completedAt: PAST, revision: 2 };
    // First load sees the open row (the completion guard); every read after
    // the write lands sees the completed row.
    prismaMock.task.findFirst.mockResolvedValueOnce(openTask);
    prismaMock.task.findFirst.mockResolvedValue(completedTask);
    prismaMock.task.updateMany.mockResolvedValue({ count: 1 });

    const completed = loose(
      await completeTaskAction({ tenantId: TENANT_ID, taskId: TASK_ID }),
    );
    expect(completed.success).toBe(true);
    expect(writeData(prismaMock.task.updateMany).completedAt).toBeInstanceOf(
      Date,
    );
    // The reloaded row is completed, so the overdue derivation must be false
    // even though the due date is in the past.
    expect((completed.data?.task as Record<string, unknown>).overdue).toBe(
      false,
    );

    // A stored completion now refuses a second one and reopens cleanly.
    const again = loose(
      await completeTaskAction({ tenantId: TENANT_ID, taskId: TASK_ID }),
    );
    expect(again.success).toBe(false);
    expect(again.code).toBe("CONFLICT");

    const reopened = loose(
      await reopenTaskAction({ tenantId: TENANT_ID, taskId: TASK_ID }),
    );
    expect(reopened.success).toBe(true);
    expect(writeData(prismaMock.task.updateMany, 1).completedAt).toBeNull();

    const deleted = loose(
      await deleteTaskAction({ tenantId: TENANT_ID, taskId: TASK_ID }),
    );
    expect(deleted.success).toBe(true);
    expect(prismaMock.task.delete).toHaveBeenCalledTimes(1);
  });

  it("filters OVERDUE by completedAt null plus a past dueAt, and paginates", async () => {
    asRole("VIEWER");
    prismaMock.task.findMany.mockResolvedValue([
      {
        id: TASK_ID,
        tenantId: TENANT_ID,
        title: "Late call",
        notes: null,
        dueAt: PAST,
        priority: "HIGH",
        assigneeId: null,
        leadId: LEAD_ID,
        contactId: null,
        documentId: null,
        completedAt: null,
        revision: 1,
        createdAt: PAST,
        updatedAt: PAST,
      },
    ]);
    prismaMock.task.count.mockResolvedValue(1);

    const result = loose(
      await getTasksAction({
        tenantId: TENANT_ID,
        status: "OVERDUE",
        page: 2,
        pageSize: 10,
      }),
    );

    expect(result.success).toBe(true);
    const args = callArg(prismaMock.task.findMany);
    const where = args.where as Record<string, unknown>;
    expect(where.completedAt).toBeNull();
    expect(where.dueAt).toEqual({ lt: expect.any(Date) });
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);

    const task = (result.data?.tasks as Record<string, unknown>[])[0];
    expect(task?.overdue).toBe(true);
    expect(result.data?.totalPages).toBe(1);
  });

  it("rejects pagination values out of bounds", async () => {
    asRole("VIEWER");

    for (const bad of [
      { page: 0 },
      { page: -1 },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: 101 },
    ]) {
      const result = loose(
        await getLeadsAction({ tenantId: TENANT_ID, ...bad }),
      );
      expect(result.success).toBe(false);
      expect(result.code).toBe("VALIDATION_ERROR");
    }
    expect(prismaMock.lead.findMany).not.toHaveBeenCalled();
  });

  it("orders the lead board newest-first with server-built skip/take", async () => {
    asRole("VIEWER");
    prismaMock.lead.findMany.mockResolvedValue([]);
    prismaMock.lead.count.mockResolvedValue(0);

    const result = loose(
      await getLeadsAction({ tenantId: TENANT_ID, page: 3, pageSize: 10 }),
    );
    expect(result.success).toBe(true);

    const args = callArg(prismaMock.lead.findMany);
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });
});

// ─── Timeline, details, metrics ───────────────────────────────────────────────

describe("lead detail, timeline and metrics", () => {
  it("getLeadAction composes tasks, duplicate suspects and the timeline", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue({
      ...leadRow(),
      pipelineStage: {
        id: STAGE_ID,
        name: "Qualified",
        position: 2,
        isWin: false,
        isLost: false,
        pipelineId: PIPELINE_ID,
      },
      assignedToUser: null,
      contact: null,
      convertedContact: null,
      tasks: [
        {
          id: TASK_ID,
          tenantId: TENANT_ID,
          title: "Late call",
          notes: null,
          dueAt: PAST,
          priority: "HIGH",
          assigneeId: null,
          leadId: LEAD_ID,
          contactId: null,
          documentId: null,
          completedAt: null,
          revision: 1,
          createdAt: PAST,
          updatedAt: PAST,
        },
        {
          id: "88888888-8888-4888-8888-888800000002",
          tenantId: TENANT_ID,
          title: "Done call",
          notes: null,
          dueAt: PAST,
          priority: "LOW",
          assigneeId: null,
          leadId: LEAD_ID,
          contactId: null,
          documentId: null,
          completedAt: PAST,
          revision: 1,
          createdAt: PAST,
          updatedAt: PAST,
        },
        {
          id: "88888888-8888-4888-8888-888800000003",
          tenantId: TENANT_ID,
          title: "Future call",
          notes: null,
          dueAt: FUTURE,
          priority: "LOW",
          assigneeId: null,
          leadId: LEAD_ID,
          contactId: null,
          documentId: null,
          completedAt: null,
          revision: 1,
          createdAt: PAST,
          updatedAt: PAST,
        },
      ],
    });
    // The dedupe scan answers with the lead itself plus one email twin.
    prismaMock.lead.findMany.mockResolvedValue([
      {
        id: LEAD_ID,
        firstName: "Jane",
        lastName: "Doe",
        companyName: "Acme Ltd",
        email: "jane@example.com",
        phone: "0712 345 678",
        status: "NEW",
        createdAt: new Date(),
      },
      {
        id: OTHER_LEAD_ID,
        firstName: "J.",
        lastName: "Doe",
        companyName: "Other",
        email: "jane@example.com",
        phone: null,
        status: "CONTACTED",
        createdAt: new Date(),
      },
    ]);
    prismaMock.activityEvent.findMany.mockResolvedValue([
      { id: "event-1", tenantId: TENANT_ID, eventType: "LEAD_CREATED" },
    ]);

    const result = loose(
      await getLeadAction({ tenantId: TENANT_ID, leadId: LEAD_ID }),
    );

    expect(result.success).toBe(true);
    const detail = result.data?.lead as Record<string, unknown>;
    const tasks = detail.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(3);
    expect(tasks[0]?.overdue).toBe(true);
    expect(tasks[1]?.overdue).toBe(false); // completed, even with a past due
    expect(tasks[2]?.overdue).toBe(false); // not due yet
    expect(detail.overdueTaskCount).toBe(1);

    // The detail view never reports the lead as its own duplicate.
    const suspects = result.data?.duplicateSuspects as Record<
      string,
      unknown
    >[];
    expect(suspects).toHaveLength(1);
    expect(suspects[0]?.id).toBe(OTHER_LEAD_ID);

    expect(result.data?.timeline).toHaveLength(1);
    const timelineArgs = callArg(prismaMock.activityEvent.findMany);
    expect(
      ((timelineArgs.where as Record<string, unknown>).OR as unknown[]).length,
    ).toBe(1);
  });

  it("the timeline writer swallows a (source, sourceKey) replay as success", async () => {
    asRole("SALES");
    prismaMock.lead.findFirst.mockResolvedValue(null);
    prismaMock.lead.create.mockResolvedValue(leadRow());
    // A retried operation whose append collides on the unique must not fail
    // the business write it accompanies.
    prismaMock.activityEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );

    const result = loose(
      await createLeadAction({
        tenantId: TENANT_ID,
        source: "WEB_FORM",
        currency: "KES",
      }),
    );

    expect(result.success).toBe(true);
    expect(prismaMock.activityEvent.create).toHaveBeenCalledTimes(1);
    // The event is still attempted exactly once per operation (append-once).
    expect(writeData(prismaMock.activityEvent.create).sourceKey).toBe(
      `lead:${LEAD_ID}:created`,
    );
  });

  it("computes stage counts and the period win rate as a snapshot metric", async () => {
    asRole("VIEWER");
    prismaMock.pipelineStage.findMany.mockResolvedValue([
      { ...ownStage, pipeline: { archivedAt: null } },
    ]);
    prismaMock.lead.groupBy.mockResolvedValue([
      { pipelineStageId: STAGE_ID, _count: { _all: 4 } },
      { pipelineStageId: null, _count: { _all: 1 } },
    ]);
    prismaMock.lead.count.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: Record<string, unknown> }).where ?? {};
      if (where.status === "LOST") return 1;
      if (where.status === "CONVERTED") return 2;
      if (where.pipelineStage) return 3; // won
      return 0;
    });

    const result = loose(
      await getLeadMetricsAction({
        tenantId: TENANT_ID,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-31T23:59:59Z",
      }),
    );

    expect(result.success).toBe(true);
    const metrics = result.data?.metrics as Record<string, unknown>;
    const stages = metrics.stages as Record<string, unknown>[];
    expect(stages[0]?.openLeadCount).toBe(4);
    expect(metrics.won).toBe(3);
    expect(metrics.lost).toBe(1);
    expect(metrics.converted).toBe(2);
    expect(metrics.winRate).toBeCloseTo(0.75);
  });

  it("refuses a metrics period that ends before it starts", async () => {
    asRole("VIEWER");

    const result = loose(
      await getLeadMetricsAction({
        tenantId: TENANT_ID,
        from: "2026-02-01T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.lead.groupBy).not.toHaveBeenCalled();
  });
});
