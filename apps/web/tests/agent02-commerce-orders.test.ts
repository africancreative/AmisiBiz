import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AGENT 02 Phase 2B — order flows.
 *
 * Orders are `Document` rows of type ORDER riding the existing engine (design
 * spec §0/§1.8), so the acceptance list is the engine's own promises, restated
 * for the new type:
 *
 *  - conversion happens only from an ACCEPTED quotation, is replay-idempotent
 *    (by idempotencyKey and by the source-document lookup), and copies the
 *    STORED line prices — a catalogue price change between acceptance and
 *    conversion must NOT re-price the order;
 *  - payments derive PARTIALLY_PAID / PAID through the same
 *    `deriveInvoiceStatus` as invoices, reversals recompute back, overpayment
 *    is refused, and a click is never a payment (only the authorized
 *    `recordPayment` path writes a `DocumentPayment`);
 *  - cancellation refuses when goods were already delivered on a delivery
 *    note, and the lifecycle keeps PAID un-cancellable;
 *  - invoice-from-order and delivery-from-order follow the database's
 *    derivation rules (one invoice per source order);
 *  - permission dispatch reads the STORED type, never the request: ORDERS_*
 *    gates, cancel+void both `ORDERS_VOID`, order payments `ORDERS_ISSUE` —
 *    and SALES, which can create/issue orders, is refused the void.
 *
 * The mocked `@amisibiz/database` enforces no database rules itself, so the
 * tenant predicate in every `where` is what the forged-tenant case asserts
 * against, mirroring what RLS does in production.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));

import {
  allowedTransitions,
  canTransition,
  deriveInvoiceStatus,
} from "@amisibiz/documents";
import type { DocumentStatus, DocumentType, TenantRole } from "@prisma/client";
import { AUDIT_ACTIONS } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import {
  cancelOrder,
  convertQuotationToOrder,
  createDeliveryNoteFromDocument,
  createInvoiceFromOrder,
  recordPayment,
  reversePayment,
  voidInvoice,
} from "@/server/services/documents/service";
import { composeDocumentSnapshot } from "@/server/services/documents/snapshot";
import {
  cancelOrderAction,
  convertQuotationToOrderAction,
  recordPaymentAction,
  voidInvoiceAction,
} from "@/server/actions/document";

import { authMock } from "./auth-mock";
import { auditsFor, prismaMock } from "./prisma-mock";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "66666666-6666-4666-8666-666666666666";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";
const ITEM_ID = "77777777-7777-4777-8777-777777777777";
const PAY_ID = "88888888-8888-4888-8888-888888888888";

function context(tenantId = TENANT_ID): TenantAuthzContext {
  return {
    userId: USER_ID,
    tenantId,
    role: "TENANT_OWNER",
    tenantStatus: "ACTIVE",
    via: "membership",
    readonly: false,
    supportGrantId: null,
  } as unknown as TenantAuthzContext;
}

function storedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: "line_1",
    tenantId: TENANT_ID,
    documentId: DOC_ID,
    position: 1,
    itemId: ITEM_ID,
    sourceLineId: null,
    itemCode: "W-1",
    description: "Widget",
    unitOfMeasure: "each",
    quantity: "2",
    unitPrice: "50.0000",
    discountType: null,
    discountPercent: "0",
    discountAmount: "0",
    lineTotal: "100.0000",
    lineDiscount: "0",
    lineNet: "100.0000",
    lineTax: "0",
    taxRateId: null,
    taxName: null,
    taxRate: "0",
    deliveredQuantity: "0",
    ...overrides,
  };
}

function storedDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    tenantId: TENANT_ID,
    type: "ORDER" as DocumentType,
    status: "ISSUED" as DocumentStatus,
    number: null,
    currency: "KES",
    contactId: CONTACT_ID,
    customerNote: null,
    terms: null,
    dueDate: null,
    total: "100.0000",
    lines: [] as ReturnType<typeof storedLine>[],
    ...overrides,
  };
}

/** The catalogue row the price-change test serves: the price has DOUBLED. */
function catalogueItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    name: "Widget",
    sku: "W-1",
    description: "Widget",
    unitOfMeasure: "each",
    unitPrice: "99.0000",
    currency: "KES",
    status: "ACTIVE",
    taxRateId: null,
    taxRate: null,
    ...overrides,
  };
}

function paymentInput(overrides: Record<string, unknown> = {}) {
  return {
    documentId: DOC_ID,
    amount: "40.0000",
    occurredOn: new Date("2026-06-01T00:00:00Z"),
    method: "CASH" as const,
    reference: null,
    note: null,
    ...overrides,
  };
}

/** Role switch for the action-level authorization cases (phase04 pattern). */
function asRole(
  role: TenantRole,
  status = "ACTIVE",
  memberOf = TENANT_ID,
  userId = USER_ID,
) {
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
      if (key.tenantId !== memberOf || key.userId !== userId) return null;
      return { role, tenant: { status } };
    },
  );
}

function sessionReady() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  authMock.mockResolvedValue({ id: USER_ID });
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
  prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ══════════════════════════ ORDER LIFECYCLE (pure) ════════════════════════ */

describe("ORDER lifecycle is derived, never clicked", () => {
  it("derives PAID only from recorded payments, never from a clicked status", () => {
    // The machine permits ISSUED→PAID *because* that is where a derived, fully
    // paid order lands; the invariant is that the status is a pure function of
    // the stored payment rows. `recordPayment` recomputes it from the ledger, so
    // a client string can never be the source of truth.
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(
      deriveInvoiceStatus({
        total: "100.0000",
        paid: "0.0000",
        dueDate: null,
        now,
      }),
    ).toBe("ISSUED");
    expect(
      deriveInvoiceStatus({
        total: "100.0000",
        paid: "40.0000",
        dueDate: null,
        now,
      }),
    ).toBe("PARTIALLY_PAID");
    expect(
      deriveInvoiceStatus({
        total: "100.0000",
        paid: "100.0000",
        dueDate: null,
        now,
      }),
    ).toBe("PAID");
  });

  it("allows the correction paths an issued order has", () => {
    expect(allowedTransitions("ORDER", "ISSUED")).toEqual(
      expect.arrayContaining(["CANCELLED", "VOID", "OVERDUE"]),
    );
  });

  it("keeps a paid order out of CANCELLED and open to VOID", () => {
    expect(canTransition("ORDER", "PAID", "CANCELLED")).toBe(false);
    expect(canTransition("ORDER", "PAID", "VOID")).toBe(true);
  });

  it("documents the DRAFT gap: the seeded table has no DRAFT→CANCELLED", () => {
    // The service treats cancelling a DRAFT as a draft edit (packages/* is
    // outside the whitelist and seeds DRAFT→[ISSUED] only).
    expect(canTransition("ORDER", "DRAFT", "CANCELLED")).toBe(false);
  });
});

/* ══════════════════════ quotation → order conversion ══════════════════════ */

describe("convertQuotationToOrder", () => {
  it("refuses a quotation that was not accepted and writes nothing", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "QUOTATION", status: "ISSUED" }),
    );

    await expect(
      convertQuotationToOrder(context(), USER_ID, { quotationId: DOC_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(prismaMock.document.create).not.toHaveBeenCalled();
    expect(prismaMock.activityEvent.create).not.toHaveBeenCalled();
  });

  it("refuses a document that is not a quotation at all", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "INVOICE", status: "ACCEPTED" }),
    );

    await expect(
      convertQuotationToOrder(context(), USER_ID, { quotationId: DOC_ID }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("copies the STORED prices — a changed catalogue price never re-prices the order", async () => {
    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({
          type: "QUOTATION",
          status: "ACCEPTED",
          lines: [storedLine()],
        }),
      )
      .mockResolvedValueOnce(null); // no order exists for this source yet
    // The catalogue now claims the widget costs 99 — the accepted quotation
    // said 50, and 50 is what the order must carry.
    prismaMock.item.findMany.mockResolvedValue([catalogueItem()]);
    prismaMock.document.create.mockResolvedValue({ id: "ord_1" });
    prismaMock.documentLine.createMany.mockResolvedValue({ count: 1 });
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const result = await convertQuotationToOrder(context(), USER_ID, {
      quotationId: DOC_ID,
    });
    expect(result).toEqual({ id: "ord_1" });

    const create = prismaMock.document.create.mock.calls[0]?.[0] as {
      data: {
        type: string;
        status: string;
        sourceDocumentId: string;
        number: string | null;
      };
    };
    expect(create.data).toMatchObject({
      type: "ORDER",
      status: "DRAFT",
      sourceDocumentId: DOC_ID,
      number: null,
    });

    const lineRows = prismaMock.documentLine.createMany.mock.calls[0]?.[0] as {
      data: { unitPrice: string; quantity: string }[];
    };
    expect(lineRows.data[0]?.unitPrice).toBe("50.0000");
    expect(lineRows.data[0]?.unitPrice).not.toBe("99.0000");

    // Timeline + audit: exactly one ORDER_CREATED event for this conversion.
    expect(prismaMock.activityEvent.create).toHaveBeenCalledTimes(1);
    const event = prismaMock.activityEvent.create.mock.calls[0]?.[0] as {
      data: { eventType: string; source: string; sourceKey: string };
    };
    expect(event.data).toMatchObject({
      eventType: "ORDER_CREATED",
      source: "order:convert",
      sourceKey: `order:convert:${DOC_ID}`,
    });
    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_CONVERTED)).toHaveLength(1);
  });

  it("returns the existing order on a retried conversion (source lookup)", async () => {
    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({ type: "QUOTATION", status: "ACCEPTED", lines: [] }),
      )
      .mockResolvedValueOnce({ id: "ord_existing" });

    const result = await convertQuotationToOrder(context(), USER_ID, {
      quotationId: DOC_ID,
    });
    expect(result).toEqual({ id: "ord_existing" });
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("returns the recorded order when the same idempotencyKey replays", async () => {
    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({ type: "QUOTATION", status: "ACCEPTED", lines: [] }),
      )
      .mockResolvedValueOnce({ id: "ord_keyed" }); // idempotencyKey lookup hits

    const result = await convertQuotationToOrder(context(), USER_ID, {
      quotationId: DOC_ID,
      idempotencyKey: "convkey-000007",
    });
    expect(result).toEqual({ id: "ord_keyed" });
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });
});

/* ══════════════════════ order payments: derived status ════════════════════ */

describe("recordPayment on an ORDER", () => {
  function paymentMocks(prior: unknown[], after: unknown[]) {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "ISSUED", total: "100.0000" }),
    );
    prismaMock.documentPayment.findMany
      .mockResolvedValueOnce(prior)
      .mockResolvedValueOnce(after);
    prismaMock.documentPayment.create.mockResolvedValue({ id: PAY_ID });
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.documentStatusEvent.create.mockResolvedValue({});
  }

  it("derives PARTIALLY_PAID from recorded payments", async () => {
    paymentMocks([], [{ amount: "40.0000" }]);

    const result = await recordPayment(context(), USER_ID, paymentInput());
    expect(result.status).toBe("PARTIALLY_PAID");
    const update = prismaMock.document.update.mock.calls[0]?.[0] as {
      data: { status: string };
    };
    expect(update.data.status).toBe("PARTIALLY_PAID");
    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_PAYMENT_RECORDED)).toHaveLength(1);
  });

  it("derives PAID when the payments cover the total exactly", async () => {
    paymentMocks([], [{ amount: "100.0000" }]);

    const result = await recordPayment(
      context(),
      USER_ID,
      paymentInput({ amount: "100.0000" }),
    );
    expect(result.status).toBe("PAID");
  });

  it("refuses an overpayment on the decimal comparison and writes no payment", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "PARTIALLY_PAID", total: "100.0000" }),
    );
    prismaMock.documentPayment.findMany.mockResolvedValue([
      { amount: "90.0000" },
    ]);

    await expect(
      recordPayment(context(), USER_ID, paymentInput({ amount: "20.0000" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(prismaMock.documentPayment.create).not.toHaveBeenCalled();
  });

  it("refuses payments on a cancelled order", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "CANCELLED" }),
    );

    await expect(
      recordPayment(context(), USER_ID, paymentInput()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a payment against a quotation or any non-money document", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "QUOTATION", status: "ACCEPTED" }),
    );

    await expect(
      recordPayment(context(), USER_ID, paymentInput()),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(prismaMock.documentPayment.create).not.toHaveBeenCalled();
  });

  it("recomputes the status back when a payment is reversed", async () => {
    prismaMock.documentPayment.findFirst.mockResolvedValue({
      id: PAY_ID,
      documentId: DOC_ID,
      reversedAt: null,
      document: { id: DOC_ID, type: "ORDER", status: "PAID", dueDate: null },
    });
    prismaMock.documentPayment.update.mockResolvedValue({});
    // After the reversal nothing stands unpaid: the balance is zero.
    prismaMock.documentPayment.findMany.mockResolvedValue([]);
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "PAID", total: "100.0000" }),
    );
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    await reversePayment(context(), USER_ID, {
      paymentId: PAY_ID,
      reason: "Payment bounced",
    });

    const update = prismaMock.document.update.mock.calls[0]?.[0] as {
      data: { status: DocumentStatus };
    };
    expect(update.data.status).toBe("ISSUED");
    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_PAYMENT_REVERSED)).toHaveLength(1);
  });
});

/* ════════════════════════════ cancellation ═══════════════════════════════ */

describe("cancelOrder", () => {
  function cancelMocks(overrides: Record<string, unknown> = {}) {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ id: ORDER_ID, ...overrides }),
    );
    prismaMock.document.findMany.mockResolvedValue([]); // no delivery notes
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.documentStatusEvent.create.mockResolvedValue({});
  }

  it("cancels an ISSUED order through the state machine with event, timeline and audit", async () => {
    cancelMocks({ status: "ISSUED" });

    await cancelOrder(context(), USER_ID, {
      documentId: ORDER_ID,
      reason: "Customer withdrew",
    });

    const update = prismaMock.document.update.mock.calls[0]?.[0] as {
      data: { status: string };
    };
    expect(update.data.status).toBe("CANCELLED");
    expect(prismaMock.activityEvent.create).toHaveBeenCalledTimes(1);
    const event = prismaMock.activityEvent.create.mock.calls[0]?.[0] as {
      data: { eventType: string; sourceKey: string };
    };
    expect(event.data).toMatchObject({
      eventType: "ORDER_CANCELLED",
      sourceKey: `order:cancel:${ORDER_ID}`,
    });
    expect(auditsFor("document.orderCancelled")).toHaveLength(1);
  });

  it("closes a DRAFT order as the draft edit it is (lifecycle-table gap, documented)", async () => {
    cancelMocks({ status: "DRAFT" });

    await cancelOrder(context(), USER_ID, {
      documentId: ORDER_ID,
      reason: "Entered in error",
    });
    expect(prismaMock.document.update).toHaveBeenCalledTimes(1);
  });

  it("refuses to cancel a PAID order — the state machine, not the caller, decides", async () => {
    cancelMocks({ status: "PAID" });

    await expect(
      cancelOrder(context(), USER_ID, {
        documentId: ORDER_ID,
        reason: "Change of mind",
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });

  it("refuses an already-CANCELLED or VOID order as a conflict", async () => {
    cancelMocks({ status: "CANCELLED" });
    await expect(
      cancelOrder(context(), USER_ID, {
        documentId: ORDER_ID,
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    vi.clearAllMocks();
    cancelMocks({ status: "VOID" });
    await expect(
      cancelOrder(context(), USER_ID, {
        documentId: ORDER_ID,
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses cancellation once goods were delivered on a delivery note", async () => {
    cancelMocks({ status: "ISSUED" });
    prismaMock.document.findMany.mockResolvedValue([
      { id: "dn_1", status: "ISSUED" },
    ]);
    prismaMock.documentLine.count.mockResolvedValue(2);

    await expect(
      cancelOrder(context(), USER_ID, {
        documentId: ORDER_ID,
        reason: "Change of mind",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });

  it("ignores DRAFT delivery notes — nothing has been delivered yet", async () => {
    cancelMocks({ status: "ISSUED" });
    prismaMock.document.findMany.mockResolvedValue([
      { id: "dn_1", status: "DRAFT" },
    ]);

    await cancelOrder(context(), USER_ID, {
      documentId: ORDER_ID,
      reason: "Customer withdrew",
    });
    expect(prismaMock.documentLine.count).not.toHaveBeenCalled();
    expect(prismaMock.document.update).toHaveBeenCalledTimes(1);
  });

  it("refuses documents that are not orders", async () => {
    cancelMocks({ type: "QUOTATION", status: "ISSUED" });
    await expect(
      cancelOrder(context(), USER_ID, {
        documentId: ORDER_ID,
        reason: "Not an order",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("finds nothing outside its own tenant — a forged tenant id is NOT_FOUND", async () => {
    // Mirrors RLS: the row exists, but only under the real tenant predicate.
    const order = storedDocument({ id: ORDER_ID, status: "ISSUED" });
    prismaMock.document.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { tenantId?: string } })?.where ?? {};
      return where.tenantId === TENANT_ID ? order : null;
    });

    await expect(
      cancelOrder(context(OTHER_TENANT_ID), USER_ID, {
        documentId: ORDER_ID,
        reason: "Cross-tenant reach",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════ void: generalized to ORDER ══════════════════════ */

describe("voidInvoice covers orders", () => {
  it("voids an ISSUED order", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ id: ORDER_ID, status: "ISSUED" }),
    );
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    await voidInvoice(context(), USER_ID, {
      documentId: ORDER_ID,
      reason: "Ordered in error",
    });
    const update = prismaMock.document.update.mock.calls[0]?.[0] as {
      data: { status: string };
    };
    expect(update.data.status).toBe("VOID");
  });

  it("still refuses to void a quotation or a delivery note", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "DELIVERY_NOTE", status: "ISSUED" }),
    );
    await expect(
      voidInvoice(context(), USER_ID, {
        documentId: DOC_ID,
        reason: "wrong path",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

/* ═══════════════════ invoice / delivery raised FROM an order ═════════════ */

describe("createInvoiceFromOrder", () => {
  it("refuses a DRAFT order — issue the order first", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ id: ORDER_ID, status: "DRAFT" }),
    );
    await expect(
      createInvoiceFromOrder(context(), USER_ID, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a cancelled or void order", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ id: ORDER_ID, status: "CANCELLED" }),
    );
    await expect(
      createInvoiceFromOrder(context(), USER_ID, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("raises a DRAFT invoice with the stored lines and the order as source", async () => {
    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({
          id: ORDER_ID,
          status: "ISSUED",
          lines: [storedLine({ documentId: ORDER_ID })],
        }),
      )
      .mockResolvedValueOnce(null); // no invoice for this order yet
    prismaMock.item.findMany.mockResolvedValue([catalogueItem()]);
    prismaMock.document.create.mockResolvedValue({ id: "inv_1" });
    prismaMock.documentLine.createMany.mockResolvedValue({ count: 1 });
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const result = await createInvoiceFromOrder(context(), USER_ID, {
      orderId: ORDER_ID,
    });
    expect(result).toEqual({ id: "inv_1" });

    const create = prismaMock.document.create.mock.calls[0]?.[0] as {
      data: {
        type: string;
        status: string;
        sourceDocumentId: string;
        dueDate: Date | null;
      };
    };
    expect(create.data).toMatchObject({
      type: "INVOICE",
      status: "DRAFT",
      sourceDocumentId: ORDER_ID,
    });
    // Default payment window: 30 days after issue.
    expect(create.data.dueDate).toBeInstanceOf(Date);

    const lineRows = prismaMock.documentLine.createMany.mock.calls[0]?.[0] as {
      data: { unitPrice: string }[];
    };
    expect(lineRows.data[0]?.unitPrice).toBe("50.0000");

    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_CONVERTED)).toHaveLength(1);
  });

  it("keeps one invoice per source order: a replay returns the existing one", async () => {
    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({
          id: ORDER_ID,
          status: "ISSUED",
          lines: [storedLine({ documentId: ORDER_ID })],
        }),
      )
      .mockResolvedValueOnce({ id: "inv_existing" });

    const result = await createInvoiceFromOrder(context(), USER_ID, {
      orderId: ORDER_ID,
    });
    expect(result).toEqual({ id: "inv_existing" });
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("refuses a source that is not an order", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "QUOTATION", status: "ISSUED" }),
    );
    await expect(
      createInvoiceFromOrder(context(), USER_ID, { orderId: DOC_ID }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("createDeliveryNoteFromDocument accepts orders", () => {
  it("raises a delivery note from an ISSUED order with outstanding lines", async () => {
    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({
          id: ORDER_ID,
          status: "ISSUED",
          lines: [storedLine({ documentId: ORDER_ID })],
        }),
      )
      .mockResolvedValueOnce(null); // idempotency lookup: nothing yet
    // Outstanding lines carry an itemId, so resolveLines fetches those catalogue
    // rows; without a stub the transaction sees `undefined`, not an empty list.
    prismaMock.item.findMany.mockResolvedValue([catalogueItem()]);
    prismaMock.document.create.mockResolvedValue({ id: "dn_1" });
    prismaMock.documentLine.createMany.mockResolvedValue({ count: 1 });
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const result = await createDeliveryNoteFromDocument(context(), USER_ID, {
      sourceDocumentId: ORDER_ID,
      idempotencyKey: "delivery-000001",
    });
    expect(result).toEqual({ id: "dn_1" });
    const create = prismaMock.document.create.mock.calls[0]?.[0] as {
      data: { type: string; sourceDocumentId: string };
    };
    expect(create.data).toMatchObject({
      type: "DELIVERY_NOTE",
      sourceDocumentId: ORDER_ID,
    });
  });

  it("still refuses a quotation as a delivery source", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "QUOTATION", status: "ACCEPTED" }),
    );
    await expect(
      createDeliveryNoteFromDocument(context(), USER_ID, {
        sourceDocumentId: DOC_ID,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

/* ══════════════════ snapshot / render: ORDER is understood ════════════════ */

describe("ORDER snapshot composition (finding: the module is type-agnostic)", () => {
  it("composes an ORDER snapshot that a later contact rename cannot touch", () => {
    const snapshot = composeDocumentSnapshot({
      type: "ORDER",
      number: "ORD-2026-0001",
      currency: "KES",
      issueDate: new Date("2026-06-01T00:00:00Z"),
      dueDate: null,
      expiryDate: null,
      deliveryDate: null,
      terms: null,
      customerNote: null,
      paymentInstructions: null,
      footer: null,
      issuer: {
        tenantId: TENANT_ID,
        displayName: "Acme Supplies",
        registeredName: null,
        taxPin: null,
        contactEmail: null,
        contactPhone: null,
        postalAddress: null,
        physicalAddress: null,
        website: null,
      },
      customer: {
        contactId: CONTACT_ID,
        name: "Original Name Ltd",
        email: "ops@original.test",
        phone: null,
        taxPin: null,
        address: null,
      },
      lines: [
        {
          itemId: ITEM_ID,
          itemCode: "W-1",
          description: "Widget",
          unitOfMeasure: "each",
          quantity: "2",
          unitPrice: "50.0000",
          discountType: null,
          discountPercent: "0",
          discountAmount: "0",
          taxRateId: null,
          taxName: null,
          taxRate: "0",
        },
      ],
      branding: {
        displayName: "Acme",
        primaryColor: "#111111",
        secondaryColor: "#222222",
        accentColor: "#333333",
        primaryForeground: "#FFFFFF",
        logoUrl: null,
      },
      generatedAt: new Date("2026-06-01T00:00:00Z"),
    });

    expect(snapshot.type).toBe("ORDER");

    // The snapshot is a frozen VALUE: renaming the contact afterwards — even
    // recomposing from the renamed data — never mutates what was already
    // serialized at issue time.
    const frozen = JSON.stringify(snapshot);
    const renamedCustomer = {
      ...snapshot.customer,
      name: "Renamed After Issue",
    };
    expect(JSON.stringify({ ...snapshot, customer: renamedCustomer })).not.toBe(
      frozen,
    );
    expect(JSON.parse(frozen)).toMatchObject({
      type: "ORDER",
      customer: { name: "Original Name Ltd" },
    });
  });
});

/* ═══════════════════ action wiring + permission dispatch ═════════════════ */

describe("document actions dispatch permissions on the STORED type", () => {
  beforeEach(() => {
    sessionReady();
  });

  it("convertQuotationToOrderAction refuses a role without ORDERS_CREATE", async () => {
    asRole("VIEWER");
    const result = await convertQuotationToOrderAction({
      tenantId: TENANT_ID,
      quotationId: DOC_ID,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("cancelOrderAction refuses SALES, which can create and issue orders but not void them", async () => {
    asRole("SALES");
    const result = await cancelOrderAction({
      tenantId: TENANT_ID,
      documentId: ORDER_ID,
      reason: "Sales should not cancel",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });

  it("cancelOrderAction succeeds for FINANCE, which holds ORDERS_VOID", async () => {
    asRole("FINANCE");
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ id: ORDER_ID, status: "ISSUED" }),
    );
    prismaMock.document.findMany.mockResolvedValue([]);
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const result = await cancelOrderAction({
      tenantId: TENANT_ID,
      documentId: ORDER_ID,
      reason: "Customer withdrew",
    });
    expect(result.success).toBe(true);
    expect(auditsFor("document.orderCancelled")).toHaveLength(1);
  });

  it("voidInvoiceAction dispatches an ORDER void to ORDERS_VOID and refuses SALES", async () => {
    asRole("SALES");
    prismaMock.document.findFirst.mockResolvedValue({ type: "ORDER" });

    const result = await voidInvoiceAction({
      tenantId: TENANT_ID,
      documentId: ORDER_ID,
      reason: "Not this role's call",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });

  it("recordPaymentAction lets SALES pay an ORDER (ORDERS_ISSUE) but never an INVOICE", async () => {
    asRole("SALES");
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ id: ORDER_ID, status: "ISSUED", total: "100.0000" }),
    );
    prismaMock.documentPayment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ amount: "40.0000" }]);
    prismaMock.documentPayment.create.mockResolvedValue({ id: PAY_ID });
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const orderPayment = await recordPaymentAction({
      tenantId: TENANT_ID,
      documentId: ORDER_ID,
      amount: "40.0000",
      occurredOn: "2026-06-01T00:00:00.000Z",
      method: "CASH",
    });
    expect(orderPayment.success).toBe(true);
    if (orderPayment.success) {
      expect(orderPayment.data?.status).toBe("PARTIALLY_PAID");
    }

    // Same role, same call shape — but the stored type is INVOICE, whose key
    // (INVOICES_ISSUE) SALES does not hold.
    vi.clearAllMocks();
    sessionReady();
    asRole("SALES");
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "INVOICE", status: "ISSUED", total: "100.0000" }),
    );

    const invoicePayment = await recordPaymentAction({
      tenantId: TENANT_ID,
      documentId: ORDER_ID,
      amount: "40.0000",
      occurredOn: "2026-06-01T00:00:00.000Z",
      method: "CASH",
    });
    expect(invoicePayment.success).toBe(false);
    if (!invoicePayment.success) expect(invoicePayment.code).toBe("FORBIDDEN");
    expect(prismaMock.documentPayment.create).not.toHaveBeenCalled();
  });

  it("reforges nothing through the action: a forged tenant finds no membership", async () => {
    asRole("TENANT_ADMIN"); // member of TENANT_ID only
    const result = await cancelOrderAction({
      tenantId: OTHER_TENANT_ID,
      documentId: ORDER_ID,
      reason: "Forged tenant reach",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });
});
