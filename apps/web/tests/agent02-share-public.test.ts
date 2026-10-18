import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import type { TenantRole } from "@prisma/client";

/**
 * AGENT 02 Phase 2C — share links + public capture surface (modules C/E).
 *
 * Unit proofs for: token entropy and rotation (server-generated base62 ≥26,
 * a new link after a revoke never reuses a token), P2002 token-collision
 * retry-once, ORDER_STATUS target rules (must be an ORDER document and never
 * a DRAFT), revocation semantics (`active=false`, row kept forever), forged
 * client fields stripped, and the public routes' contracts: generic 404s with
 * no existence leak, `no-store`, parameter binding to the SECURITY DEFINER
 * functions (never string interpolation), the 8 KB body ceiling, the required
 * idempotency key, and unknown-key stripping.
 *
 * The SQL functions themselves (`app_public_*`) are migration truth; their
 * behaviour against a live database (revoke → resolver refusal, idempotent
 * replay returning the ORIGINAL lead) is proven by the Phase 4 integration
 * harness. Here the routes are exercised against a mocked `$queryRaw`, and
 * the mock records exactly what the SQL layer would receive.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));

import { prismaMock } from "./prisma-mock";
import { authMock } from "./auth-mock";
import {
  callArg,
  delegateFor,
  ensureAgent02Delegates,
  fakeAuthz,
  type Delegate,
} from "./agent02-local-mock";
import {
  createShareLink,
  generateShareToken,
  revokeShareLink,
} from "@/server/services/share/service";
import {
  createShareLinkAction,
  revokeShareLinkAction,
  listShareLinksAction,
  updateShareLinkExpiryAction,
} from "@/server/actions/share-link";
import { GET as shareResolveGET } from "@/app/api/public/share/[token]/route";
import { GET as productViewGET } from "@/app/api/public/product/[token]/route";
import { GET as orderStatusGET } from "@/app/api/public/order/[token]/route";
import { POST as leadCapturePOST } from "@/app/api/public/leads/route";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "55555555-5555-4555-8555-555555550001";
const ORDER_ID = "99999999-9999-4999-8999-999999990001";
const LINK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const shareMock = (): Delegate => delegateFor("shareLink");
const activityMock = (): Delegate => delegateFor("activityEvent");

type Loose = {
  success: boolean;
  ok?: boolean;
  data?: Record<string, unknown>;
  code?: string;
  error?: string;
};
function loose(result: unknown): Loose {
  return result as Loose;
}

function asRole(role: TenantRole, memberOf: string = TENANT_ID): void {
  prismaMock.tenantMember.findUnique.mockImplementation(
    async (args: unknown) => {
      const key =
        (
          args as {
            where?: {
              tenantId_userId?: { tenantId?: string; userId?: string };
            };
          }
        )?.where?.tenantId_userId ?? {};
      if (key.tenantId !== memberOf || key.userId !== USER_ID) return null;
      return { role, tenant: { status: "ACTIVE" } };
    },
  );
}

function prismaError(code: string): unknown {
  return new Prisma.PrismaClientKnownRequestError(code, {
    code,
    clientVersion: "6.19.3",
  });
}

/** The rows a successful PRODUCT link needs: item present, no active twin. */
function primeProductTarget(): void {
  prismaMock.item.findFirst.mockResolvedValue({ id: ITEM_ID });
  shareMock().findFirst.mockResolvedValue(null);
}

function primeShareCreateEcho(): void {
  shareMock().create.mockImplementation(async (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data;
    return {
      id: LINK_ID,
      token: data.token,
      kind: data.kind,
      itemId: data.itemId ?? null,
      documentId: data.documentId ?? null,
    };
  });
}

beforeEach(() => {
  ensureAgent02Delegates();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  authMock.mockResolvedValue({
    id: USER_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: null,
    status: "ACTIVE",
  });
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
  prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
  asRole("TENANT_OWNER");

  prismaMock.$queryRaw.mockReset();
  prismaMock.$queryRaw.mockResolvedValue([]);
  shareMock().findFirst.mockResolvedValue(null);
  shareMock().create.mockResolvedValue({
    id: LINK_ID,
    token: "x",
    kind: "PRODUCT",
    itemId: ITEM_ID,
    documentId: null,
  });
  shareMock().updateMany.mockResolvedValue({ count: 1 });
  shareMock().findMany.mockResolvedValue([]);
  shareMock().count.mockResolvedValue(0);
  shareMock().delete.mockClear();
  activityMock().create.mockResolvedValue({ id: "evt-1" });
  prismaMock.document.findFirst.mockResolvedValue({
    id: ORDER_ID,
    type: "ORDER",
    status: "ISSUED",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Token entropy and rotation ──────────────────────────────────────────────

describe("share token generation", () => {
  it("generates base62 tokens of at least 26 characters, all distinct", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const token = generateShareToken();
      expect(token.length).toBeGreaterThanOrEqual(26);
      expect(token).toMatch(/^[0-9A-Za-z]+$/);
      seen.add(token);
    }
    expect(seen.size).toBe(25);
  });

  it("the create data carries a server-generated token; the client never sets one", async () => {
    primeProductTarget();
    primeShareCreateEcho();

    const result = loose(
      await createShareLinkAction({
        tenantId: TENANT_ID,
        kind: "PRODUCT",
        itemId: ITEM_ID,
        // Forged extras: stripped by the schema, must not reach the row.
        token: "client-chosen-token",
        viewCount: 500,
        active: false,
      }),
    );

    expect(result.success).toBe(true);
    const data = callArg(shareMock().create).data as Record<string, unknown>;
    expect(typeof data.token).toBe("string");
    expect((data.token as string).length).toBeGreaterThanOrEqual(26);
    expect(data.token).not.toBe("client-chosen-token");
    expect(data.viewCount).toBeUndefined();
    expect(data.active).toBe(true);
    expect(data.tenantId).toBe(TENANT_ID);

    const token = (result.data as { token: string }).token;
    expect(token).toBe(data.token);
  });

  it("a token collision (P2002) is retried exactly once with a fresh token", async () => {
    primeProductTarget();
    const seenTokens: string[] = [];
    shareMock().create.mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      seenTokens.push(String(data.token));
      if (seenTokens.length === 1) throw prismaError("P2002");
      return {
        id: LINK_ID,
        token: data.token,
        kind: data.kind,
        itemId: data.itemId,
        documentId: null,
      };
    });

    const result = loose(
      await createShareLink(fakeAuthz(TENANT_ID), {
        kind: "PRODUCT",
        itemId: ITEM_ID,
      }),
    );

    expect(result.ok).toBe(true);
    expect(seenTokens).toHaveLength(2);
    expect(seenTokens[0]).not.toBe(seenTokens[1]);
  });

  it("two successive collisions are an honest INTERNAL, not a loop", async () => {
    primeProductTarget();
    shareMock().create.mockRejectedValue(prismaError("P2002"));

    const result = await createShareLink(fakeAuthz(TENANT_ID), {
      kind: "PRODUCT",
      itemId: ITEM_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INTERNAL");
    expect(shareMock().create).toHaveBeenCalledTimes(2);
  });

  it("revoking then re-creating yields a NEW token; the old row is kept", async () => {
    primeProductTarget();
    primeShareCreateEcho();

    const first = await createShareLink(fakeAuthz(TENANT_ID), {
      kind: "PRODUCT",
      itemId: ITEM_ID,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    shareMock().findFirst.mockResolvedValue({ id: LINK_ID, active: true });
    const revoked = await revokeShareLink(fakeAuthz(TENANT_ID), LINK_ID);
    expect(revoked.ok).toBe(true);

    // Revoke flips `active` and keeps the row — no delete anywhere.
    const update = callArg(shareMock().updateMany);
    expect(update.data).toEqual({ active: false });
    expect(shareMock().delete).not.toHaveBeenCalled();
    expect(shareMock().deleteMany).not.toHaveBeenCalled();

    // A fresh active link is now possible, with a different token.
    shareMock().findFirst.mockResolvedValue(null);
    const second = await createShareLink(fakeAuthz(TENANT_ID), {
      kind: "PRODUCT",
      itemId: ITEM_ID,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.token).not.toBe(first.data.token);
  });
});

// ─── ORDER_STATUS target rules ───────────────────────────────────────────────

describe("ORDER_STATUS link targets", () => {
  function targetWithDoc(doc: Record<string, unknown> | null) {
    prismaMock.document.findFirst.mockResolvedValue(doc);
    shareMock().findFirst.mockResolvedValue(null);
  }

  it("refuses a DRAFT order — a draft is not public information", async () => {
    targetWithDoc({ id: ORDER_ID, type: "ORDER", status: "DRAFT" });
    const result = await createShareLink(fakeAuthz(TENANT_ID), {
      kind: "ORDER_STATUS",
      documentId: ORDER_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(result.fieldErrors?.documentId).toEqual([
        "Order is still a draft",
      ]);
    }
    expect(shareMock().create).not.toHaveBeenCalled();
  });

  it("refuses a non-ORDER document", async () => {
    targetWithDoc({ id: ORDER_ID, type: "INVOICE", status: "PAID" });
    const result = await createShareLink(fakeAuthz(TENANT_ID), {
      kind: "ORDER_STATUS",
      documentId: ORDER_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(result.fieldErrors?.documentId).toEqual([
        "Document is not an order",
      ]);
    }
  });

  it("refuses a document that does not exist in this tenant", async () => {
    targetWithDoc(null);
    const result = await createShareLink(fakeAuthz(TENANT_ID), {
      kind: "ORDER_STATUS",
      documentId: ORDER_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.fieldErrors?.documentId).toEqual(["Document not found"]);
  });

  it("accepts an ISSUED order and records SHARE_LINK_CREATED", async () => {
    targetWithDoc({ id: ORDER_ID, type: "ORDER", status: "ISSUED" });
    primeShareCreateEcho();

    const result = loose(
      await createShareLinkAction({
        tenantId: TENANT_ID,
        kind: "ORDER_STATUS",
        documentId: ORDER_ID,
        message: "Track your order",
      }),
    );
    expect(result.success).toBe(true);

    const events = activityMock().create.mock.calls.map(
      (call) => (call[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("SHARE_LINK_CREATED");
  });

  it("the revoke action records SHARE_LINK_REVOKED on the timeline", async () => {
    shareMock().findFirst.mockResolvedValue({ id: LINK_ID, active: true });
    const result = loose(
      await revokeShareLinkAction({
        tenantId: TENANT_ID,
        shareLinkId: LINK_ID,
      }),
    );
    expect(result.success).toBe(true);
    const events = activityMock().create.mock.calls.map(
      (call) => (call[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("SHARE_LINK_REVOKED");
  });

  it("an expiry in the past is a validation error, not a sneaky revoke", async () => {
    const result = loose(
      await updateShareLinkExpiryAction({
        tenantId: TENANT_ID,
        shareLinkId: LINK_ID,
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(shareMock().updateMany).not.toHaveBeenCalled();
  });

  it("a forged tenant is refused by the action layer before any link is minted", async () => {
    asRole("TENANT_OWNER", OTHER_TENANT_ID);
    const result = loose(
      await createShareLinkAction({
        tenantId: TENANT_ID,
        kind: "PRODUCT",
        itemId: ITEM_ID,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("FORBIDDEN");
    expect(shareMock().create).not.toHaveBeenCalled();
  });

  it("listing requires SHARE_LINKS_READ and is tenant-scoped", async () => {
    const result = loose(await listShareLinksAction({ tenantId: TENANT_ID }));
    expect(result.success).toBe(true);
    expect(callArg(shareMock().findMany).where).toMatchObject({
      tenantId: TENANT_ID,
    });
  });
});

// ─── Public routes: mocked function layer, contract assertions ───────────────
// Route-level SQL integration (the real `app_public_*` refusals) is deferred
// to the Phase 4 harness; these assert the HTTP contract and that the token /
// payload reach the statement ONLY as bound parameters.

function params(token: string) {
  return { params: Promise.resolve({ token }) };
}

function shareUrl(token: string): NextRequest {
  return new NextRequest(`https://public.test/api/public/share/${token}`);
}

describe("GET /api/public/share/[token]", () => {
  it("returns the function json verbatim with no-store", async () => {
    const resolved = {
      tenantId: TENANT_ID,
      id: LINK_ID,
      kind: "PRODUCT",
      itemId: ITEM_ID,
    };
    prismaMock.$queryRaw.mockResolvedValue([{ result: resolved }]);

    const response = await shareResolveGET(
      shareUrl("ValidToken1234567890abcdef"),
      params("ValidToken1234567890abcdef"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(resolved);
  });

  it("binds the token as a parameter — never interpolates it into SQL text", async () => {
    const token = "abc123INJECT";
    prismaMock.$queryRaw.mockResolvedValue([
      { result: { tenantId: TENANT_ID, id: LINK_ID, kind: "PRODUCT" } },
    ]);

    await shareResolveGET(shareUrl(token), params(token));

    const call = prismaMock.$queryRaw.mock.calls[0] as unknown as [
      { strings?: readonly string[] } | string,
      ...unknown[],
    ];
    const sqlText = Array.isArray(call[0])
      ? call[0].join("?")
      : String(
          (call[0] as { strings?: readonly string[] }).strings?.join("$1") ??
            call[0],
        );
    expect(sqlText).toContain("app_public_share_link_resolve(");
    // The token value must NOT appear inside the statement text...
    expect(sqlText).not.toContain(token);
    // ...and must appear as a bound parameter instead.
    expect(call.slice(1)).toContain(token);
  });

  it("a resolver exception (revoked/expired/unknown) is the same generic 404", async () => {
    prismaMock.$queryRaw.mockRejectedValue(
      new Error('null value in column "id" violates: P0002 no_data_found'),
    );

    const response = await shareResolveGET(
      shareUrl("revokedtoken1234567890"),
      params("revokedtoken1234567890"),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: false, error: "Not found" });
    // The SQL message never leaks.
    expect(JSON.stringify(body)).not.toContain("no_data_found");
  });

  it("a null result is the same 404 shape", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ result: null }]);
    const response = await shareResolveGET(
      shareUrl("tokenwithoutanymatch1"),
      params("tokenwithoutanymatch1"),
    );
    expect(response.status).toBe(404);
  });

  it("a malformed token is refused without ever asking the database", async () => {
    const nasty = "not;valid--sql'";
    const response = await shareResolveGET(shareUrl(nasty), params(nasty));
    expect(response.status).toBe(404);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("GET /api/public/product/[token] and /api/public/order/[token]", () => {
  it("product view returns the function payload verbatim", async () => {
    const payload = {
      tenantId: TENANT_ID,
      item: { id: ITEM_ID, name: "Widget", currency: "KES" },
      variants: [{ id: "v1", unitPrice: "10.0000", currency: "KES" }],
    };
    prismaMock.$queryRaw.mockResolvedValue([{ result: payload }]);

    const token = "producttoken1234567890ab";
    const response = await productViewGET(
      new NextRequest(`https://public.test/api/public/product/${token}`),
      params(token),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    const call = prismaMock.$queryRaw.mock.calls[0] as unknown as [
      unknown,
      ...unknown[],
    ];
    const sqlText = String(
      (call[0] as { strings?: readonly string[] }).strings?.join("$1") ??
        call[0],
    );
    expect(sqlText).toContain("app_public_product_view(");
    expect(sqlText).not.toContain(token);
  });

  it("order status returns the function payload verbatim with no-store", async () => {
    const payload = {
      id: ORDER_ID,
      number: "ORD-1",
      status: "ISSUED",
      deliveredRatio: 0.5,
    };
    prismaMock.$queryRaw.mockResolvedValue([{ result: payload }]);

    const token = "ordertoken1234567890abcdef";
    const response = await orderStatusGET(
      new NextRequest(`https://public.test/api/public/order/${token}`),
      params(token),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(payload);
  });

  it("both refuse every failure as the identical generic 404", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("P0002"));
    const token = "missingtoken1234567890abc";

    const product = await productViewGET(
      new NextRequest(`https://public.test/api/public/product/${token}`),
      params(token),
    );
    const order = await orderStatusGET(
      new NextRequest(`https://public.test/api/public/order/${token}`),
      params(token),
    );
    expect(product.status).toBe(404);
    expect(order.status).toBe(404);
    const productBody = await product.json();
    const orderBody = await order.json();
    expect(productBody).toEqual({ success: false, error: "Not found" });
    expect(orderBody).toEqual(productBody);
  });
});

// ─── POST /api/public/leads ──────────────────────────────────────────────────

function leadRequest(body: unknown): NextRequest {
  return new NextRequest("https://public.test/api/public/leads", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/public/leads", () => {
  it("happy path: 201 {leadId, duplicateSuspect}, payload bound as ::jsonb parameter", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { result: { leadId: "lead-1", duplicateSuspect: false } },
    ]);

    const response = await leadCapturePOST(
      leadRequest({
        shareToken: "leadformtoken1234567890abcd",
        idempotencyKey: "form-42",
        firstName: "  Jane ",
        email: "jane@example.com",
        phone: "+254700000000",
        message: "Request a quote for 10 units",
        utmSource: "campaign-page",
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      leadId: "lead-1",
      duplicateSuspect: false,
    });

    const call = prismaMock.$queryRaw.mock.calls[0] as unknown as [
      unknown,
      ...unknown[],
    ];
    const sqlText = String(
      (call[0] as { strings?: readonly string[] }).strings?.join("$1") ??
        call[0],
    );
    expect(sqlText).toContain("app_public_lead_capture(");
    expect(sqlText).toContain("::jsonb");

    // The JSON text is a BOUND parameter, not part of the statement.
    const bound = call[1] as string;
    expect(typeof bound).toBe("string");
    expect(sqlText).not.toContain("form-42");
    const payload = JSON.parse(bound) as Record<string, unknown>;
    expect(payload.idempotencyKey).toBe("form-42");
  });

  it("rejects a body over 8 KB with 413 before touching the database", async () => {
    const response = await leadCapturePOST(
      leadRequest({
        tenantId: TENANT_ID,
        idempotencyKey: "k",
        message: "x".repeat(9000),
      }),
    );
    expect(response.status).toBe(413);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("requires a non-empty idempotencyKey", async () => {
    const missing = await leadCapturePOST(
      leadRequest({ tenantId: TENANT_ID, firstName: "Jane" }),
    );
    expect(missing.status).toBe(400);

    const blank = await leadCapturePOST(
      leadRequest({ tenantId: TENANT_ID, idempotencyKey: "   " }),
    );
    expect(blank.status).toBe(400);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("requires a target: shareToken or tenantId, and a bad tenantId fails schema validation", async () => {
    const none = await leadCapturePOST(
      leadRequest({ idempotencyKey: "k", firstName: "Jane" }),
    );
    expect(none.status).toBe(400);

    const malformedTenant = await leadCapturePOST(
      leadRequest({ tenantId: "not-a-uuid", idempotencyKey: "k" }),
    );
    expect(malformedTenant.status).toBe(400);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("strips unknown keys — the bound payload carries only the whitelist", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { result: { leadId: "lead-2", duplicateSuspect: true } },
    ]);

    const response = await leadCapturePOST(
      leadRequest({
        shareToken: "leadformtoken1234567890abcd",
        idempotencyKey: "k1",
        // Injection / privilege attempts: none may survive.
        status: "CONVERTED",
        role: "TENANT_OWNER",
        tenantOverride: TENANT_ID,
        priority: "HIGH",
        email: "ok@example.com",
      }),
    );
    expect(response.status).toBe(201);

    const bound = JSON.parse(
      (prismaMock.$queryRaw.mock.calls[0] as unknown as [unknown, string])[1],
    ) as Record<string, unknown>;
    expect(Object.keys(bound).sort()).toEqual(
      ["email", "idempotencyKey", "shareToken"].sort(),
    );
  });

  it("maps the function's no-data raise to 404 and any other raise to 400 — never echoes internals", async () => {
    prismaMock.$queryRaw.mockRejectedValue(
      new Error(
        "... P0002 ... Lead capture requires a valid share token or tenant",
      ),
    );
    const notFound = await leadCapturePOST(
      leadRequest({ tenantId: TENANT_ID, idempotencyKey: "k" }),
    );
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({
      success: false,
      error: "Not found",
    });

    prismaMock.$queryRaw.mockRejectedValue(
      new Error("... check_violation ... private SQL detail"),
    );
    const refused = await leadCapturePOST(
      leadRequest({ tenantId: TENANT_ID, idempotencyKey: "k" }),
    );
    expect(refused.status).toBe(400);
    const body = JSON.stringify(await refused.json());
    expect(body).not.toContain("check_violation");
    expect(body).not.toContain("private");
  });

  it("malformed JSON is a 400, not a parse crash", async () => {
    const response = await leadCapturePOST(leadRequest("{not json"));
    expect(response.status).toBe(400);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});
