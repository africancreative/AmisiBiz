import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 05 — the document engine.
 *
 * Phase 4/5 introduces quotations, invoices and delivery notes: server-side
 * numbering and issuance, immutable issued snapshots, recorded payments and
 * deliveries, PDF rendering, and customer-portal downloads. The acceptance
 * criteria name what must be proven: arithmetic precision, rounding, concurrent
 * numbering, quotation conversion, immutable snapshots, corrections, PDF output,
 * authorization and cross-tenant access.
 *
 * The suite is split the way the engine is:
 *
 *  - The PURE half (`@amisibiz/documents`) is tested with no mocks at all. The
 *    arithmetic, lifecycle, numbering and snapshot rules are shared with the
 *    future offline client, so they must be verifiable on their own.
 *  - The SERVER half is tested through the real Server Actions and route
 *    handlers with the shared Prisma and auth mocks, so the assertions describe
 *    the authorization boundary and the guards, not a reimplementation of them.
 */

import {
  DEFAULT_DOCUMENT_NUMBERING,
  DocumentNumberingError,
  addDecimalStrings,
  allowedTransitions,
  buildDocumentSnapshot,
  calculateDocument,
  calculateLine,
  canTransition,
  compareDecimalStrings,
  composeDocumentNumber,
  deriveDeliveryStatus,
  deriveInvoiceStatus,
  isConvertibleQuotation,
  isEditable,
  isIssued,
  outstandingBalance,
  previewDocumentNumber,
  readDocumentSnapshot,
  renderDocumentPdf,
  resolveDocumentNumberPeriod,
  sumDecimalStrings,
  type DocumentPdfBranding,
  type DocumentSnapshot,
} from "@amisibiz/documents";

import { authMock } from "./auth-mock";
import { auditsFor, prismaMock } from "./prisma-mock";
import { AUDIT_ACTIONS } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import type { DocumentStatus, DocumentType, TenantRole } from "@prisma/client";
import {
  convertQuotationToInvoice,
  recordPayment,
  recordQuotationDecision,
  updateDraft,
  voidInvoice,
} from "@/server/services/documents/service";
import type { DocumentLinePayload } from "@/server/services/documents/lines";
import { createDocumentDraftAction } from "@/server/actions/document";
import { GET as staffPdfRoute } from "@/app/api/documents/[documentId]/pdf/route";
import { GET as portalPdfRoute } from "@/app/api/portal/documents/[documentId]/pdf/route";
import type { NextRequest } from "next/server";

// Replace the database and the session with the shared mocks *before* any module
// under test is imported. `vi.mock` is hoisted, so the order here is not the
// order the modules see.
vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));

const USER_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";

/* ══════════════════════════ PURE ENGINE ══════════════════════════════════ */

describe("Phase 5 exact arithmetic", () => {
  it("multiplies and rounds money without floating point drift", () => {
    // 3 × 19.99 is 59.97; a float path is what produces 59.970000000000006.
    const line = calculateLine({ quantity: "3", unitPrice: "19.99" });
    expect(line.lineTotal).toBe("59.9700");
    expect(line.lineNet).toBe("59.9700");
    expect(line.lineTax).toBe("0.0000");
  });

  it("adds the canonical float trap exactly: 0.1 + 0.2 = 0.3", () => {
    expect(Number(0.1 + 0.2)).not.toBe(0.3); // the bug the engine must not have
    expect(addDecimalStrings("0.1", "0.2")).toBe("0.3");
    expect(sumDecimalStrings(["0.1", "0.2"])).toBe("0.3000");
  });

  it("applies a percentage discount and tax exactly", () => {
    const line = calculateLine({
      quantity: "1",
      unitPrice: "100",
      discountType: "PERCENT",
      discountPercent: "10",
      taxRate: "0.16",
      taxName: "VAT 16%",
    });
    expect(line.lineDiscount).toBe("10.0000");
    expect(line.lineNet).toBe("90.0000");
    expect(line.lineTax).toBe("14.4000");
  });

  it("clamps a fixed-amount discount to the line rather than exceeding it", () => {
    const line = calculateLine({
      quantity: "1",
      unitPrice: "10",
      discountType: "AMOUNT",
      discountAmount: "999",
    });
    expect(line.lineDiscount).toBe("10.0000");
    expect(line.lineNet).toBe("0.0000");
  });

  it("sums lines, discounts, tax and total consistently, grouped by tax rate", () => {
    const result = calculateDocument({
      lines: [
        { quantity: "2", unitPrice: "50", taxRate: "0.16", taxName: "VAT 16%" },
        {
          quantity: "1",
          unitPrice: "100",
          taxRate: "0.16",
          taxName: "VAT 16%",
        },
        { quantity: "1", unitPrice: "200", taxRate: "0", taxName: null },
      ],
    });
    expect(result.subtotal).toBe("400.0000");
    expect(result.taxableBase).toBe("400.0000");
    // (100 + 100) * 0.16 = 32.0000
    expect(result.taxTotal).toBe("32.0000");
    expect(result.total).toBe("432.0000");
    // The two VAT lines collapse into ONE breakdown row.
    expect(result.taxBreakdown).toHaveLength(2);
    expect(result.taxBreakdown[0]).toMatchObject({
      name: "VAT 16%",
      base: "200.0000",
      amount: "32.0000",
    });
  });

  it("compares decimal strings exactly, not via Number()", () => {
    expect(compareDecimalStrings("0.3", "0.3000")).toBe(0);
    expect(compareDecimalStrings("0.1000", "0.2")).toBe(-1);
    expect(compareDecimalStrings("10", "2")).toBe(1);
    expect(compareDecimalStrings("100.0000", "100.0000")).toBe(0);
  });

  it("floors an overpaid balance at zero", () => {
    expect(outstandingBalance("100.0000", "40.0000")).toBe("60.0000");
    expect(outstandingBalance("100.0000", "150.0000")).toBe("0.0000");
  });
});

describe("Phase 5 derived invoice status", () => {
  const now = new Date("2026-05-01T00:00:00Z");
  const future = new Date("2026-06-01T00:00:00Z");
  const past = new Date("2026-04-01T00:00:00Z");

  it("is PAID when payments cover the total exactly (string equality)", () => {
    // The trap: total "0.3000" vs paid "0.3" must compare equal.
    expect(
      deriveInvoiceStatus({ total: "0.3000", paid: "0.3", dueDate: past, now }),
    ).toBe("PAID");
  });

  it("is PARTIALLY_PAID when some but not all is paid", () => {
    expect(
      deriveInvoiceStatus({
        total: "100.0000",
        paid: "40.0000",
        dueDate: future,
        now,
      }),
    ).toBe("PARTIALLY_PAID");
  });

  it("is OVERDUE only when nothing is paid and the due date has passed", () => {
    expect(
      deriveInvoiceStatus({ total: "100", paid: "0", dueDate: past, now }),
    ).toBe("OVERDUE");
    expect(
      deriveInvoiceStatus({ total: "100", paid: "0", dueDate: future, now }),
    ).toBe("ISSUED");
  });

  it("treats a zero-total invoice as PAID the moment it is issued", () => {
    expect(
      deriveInvoiceStatus({ total: "0", paid: "0", dueDate: past, now }),
    ).toBe("PAID");
  });
});

describe("Phase 5 lifecycle rules", () => {
  it("forbids a document from returning to DRAFT once issued", () => {
    expect(canTransition("INVOICE", "ISSUED", "DRAFT")).toBe(false);
    expect(canTransition("QUOTATION", "ISSUED", "DRAFT")).toBe(false);
    expect(isEditable("ISSUED")).toBe(false);
    expect(isIssued("ISSUED")).toBe(true);
  });

  it("allows the documented transitions and refuses the rest", () => {
    expect(canTransition("QUOTATION", "DRAFT", "ISSUED")).toBe(true);
    expect(canTransition("QUOTATION", "ISSUED", "ACCEPTED")).toBe(true);
    expect(canTransition("INVOICE", "DRAFT", "PAID")).toBe(false);
    expect(canTransition("INVOICE", "ISSUED", "VOID")).toBe(true);
    expect(allowedTransitions("INVOICE", "VOID")).toHaveLength(0);
  });

  it("converts only an ACCEPTED quotation", () => {
    expect(isConvertibleQuotation("ACCEPTED")).toBe(true);
    expect(isConvertibleQuotation("ISSUED")).toBe(false);
  });

  it("derives a delivery status from delivered line counts", () => {
    expect(deriveDeliveryStatus({ orderedLines: 3, deliveredLines: 0 })).toBe(
      "ISSUED",
    );
    expect(deriveDeliveryStatus({ orderedLines: 3, deliveredLines: 1 })).toBe(
      "PARTIALLY_DELIVERED",
    );
    expect(deriveDeliveryStatus({ orderedLines: 3, deliveredLines: 3 })).toBe(
      "DELIVERED",
    );
  });
});

describe("Phase 5 numbering composition", () => {
  it("resolves calendar and fiscal periods from the ISSUE date", () => {
    expect(
      resolveDocumentNumberPeriod(
        "CALENDAR_YEAR",
        1,
        new Date("2026-05-01T00:00:00Z"),
      ),
    ).toBe("2026");
    expect(resolveDocumentNumberPeriod("NONE", 1, new Date())).toBe("");
    // A July fiscal start puts March 2026 in FY 2025/26.
    expect(
      resolveDocumentNumberPeriod(
        "FINANCIAL_YEAR",
        7,
        new Date("2026-03-01T00:00:00Z"),
      ),
    ).toBe("2025/26");
  });

  it("composes the same string the database function documents", () => {
    expect(
      composeDocumentNumber({
        prefix: "INV",
        padding: 4,
        separator: "-",
        period: "2026",
        value: 7,
      }),
    ).toBe("INV-2026-0007");
    // Empty parts are dropped, so a NONE period leaves no dangling separator.
    expect(
      composeDocumentNumber({
        prefix: "ACME",
        padding: 4,
        separator: "-",
        period: "",
        value: 1,
      }),
    ).toBe("ACME-0001");
  });

  it("previews the next invoice number without consuming it", () => {
    const config = DEFAULT_DOCUMENT_NUMBERING.INVOICE;
    expect(
      previewDocumentNumber({
        config,
        nextValue: 1,
        date: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toBe("INV-2026-0001");
    // A preview is pure: the same call never advances anything.
    expect(
      previewDocumentNumber({
        config,
        nextValue: 1,
        date: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toBe("INV-2026-0001");
  });

  it("refuses to compose an unsafe number", () => {
    expect(() =>
      composeDocumentNumber({
        prefix: "INV 2026",
        padding: 4,
        separator: "-",
        period: "",
        value: 1,
      }),
    ).toThrow(DocumentNumberingError);
  });
});

/* ══════════════════════════ SNAPSHOT + PDF ═══════════════════════════════ */

function sampleSnapshot(): DocumentSnapshot {
  return buildDocumentSnapshot({
    type: "INVOICE",
    number: "INV-2026-0007",
    currency: "KES",
    issueDate: new Date("2026-05-01T00:00:00Z"),
    dueDate: new Date("2026-05-31T00:00:00Z"),
    expiryDate: null,
    deliveryDate: null,
    terms: "Payable within 30 days.",
    customerNote: "Thank you.",
    paymentInstructions: "Pay to Acme Ltd, 123456.",
    footer: null,
    issuer: {
      tenantId: TENANT_ID,
      displayName: "Acme Ltd",
      registeredName: "Acme Limited",
      taxPin: "P051234567X",
      contactEmail: "billing@acme.example",
      contactPhone: "+254700000000",
      postalAddress: null,
      physicalAddress: "Nairobi",
      website: null,
    },
    customer: {
      contactId: CONTACT_ID,
      name: "Jane Customer",
      email: "jane@example.com",
      phone: null,
      taxPin: null,
      address: "Westlands",
    },
    lines: [
      {
        position: 0,
        itemId: null,
        itemCode: "W-1",
        description: "Consulting",
        unitOfMeasure: "hour",
        quantity: "10",
        unitPrice: "5000",
        discountType: null,
        discountPercent: "0",
        discountAmount: "0",
        taxRateId: null,
        taxName: "VAT 16%",
        taxRate: "0.16",
      },
    ],
    branding: {
      displayName: "Acme Ltd",
      primaryColor: "#123456",
      secondaryColor: "#654321",
      accentColor: "#abcdef",
      primaryForeground: "#ffffff",
      logoUrl: null,
    },
    generatedAt: new Date("2026-05-01T00:00:00Z"),
  });
}

describe("Phase 5 immutable snapshot", () => {
  it("derives totals from the copied lines so the snapshot cannot disagree", () => {
    const snapshot = sampleSnapshot();
    // 10 * 5000 = 50000, VAT 16% = 8000, total 58000.
    expect(snapshot.subtotal).toBe("50000.0000");
    expect(snapshot.taxTotal).toBe("8000.0000");
    expect(snapshot.total).toBe("58000.0000");
    expect(snapshot.lines[0]?.lineTotal).toBe("50000.0000");
  });

  it("freezes the issuer, customer and branding facts it was given", () => {
    const snapshot = sampleSnapshot();
    expect(snapshot.issuer.displayName).toBe("Acme Ltd");
    expect(snapshot.customer.name).toBe("Jane Customer");
    expect(snapshot.branding.primaryColor).toBe("#123456");
    expect(snapshot.paymentInstructions).toBe("Pay to Acme Ltd, 123456.");
  });

  it("narrows a stored snapshot and refuses a draft or unknown version", () => {
    const snapshot = sampleSnapshot();
    expect(readDocumentSnapshot(snapshot)).toBe(snapshot);
    expect(readDocumentSnapshot(null)).toBeNull();
    expect(
      readDocumentSnapshot({ version: 99, number: "X", lines: [] }),
    ).toBeNull();
    expect(readDocumentSnapshot({ number: "X", lines: [] })).toBeNull();
  });
});

describe("Phase 5 PDF output", () => {
  function branding(snapshot: DocumentSnapshot): DocumentPdfBranding {
    return {
      displayName: snapshot.branding.displayName,
      primaryColor: snapshot.branding.primaryColor,
      secondaryColor: snapshot.branding.secondaryColor,
      accentColor: snapshot.branding.accentColor,
      primaryForeground: snapshot.branding.primaryForeground,
      logo: null,
    };
  }

  it("emits a real PDF from the frozen snapshot", () => {
    const snapshot = sampleSnapshot();
    const bytes = renderDocumentPdf({
      documentType: snapshot.type,
      documentNumber: snapshot.number,
      model: snapshot,
      branding: branding(snapshot),
      locale: "en",
    });

    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("is deterministic: the same snapshot renders the same bytes", () => {
    const snapshot = sampleSnapshot();
    const request = {
      documentType: snapshot.type,
      documentNumber: snapshot.number,
      model: snapshot,
      branding: branding(snapshot),
      locale: "en",
    };
    const first = renderDocumentPdf(request);
    const second = renderDocumentPdf(request);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});

/* ══════════════════════════ SERVER ENGINE ════════════════════════════════ */

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

function linePayload(
  overrides: Partial<DocumentLinePayload> = {},
): DocumentLinePayload {
  return {
    itemId: null,
    description: "Consulting",
    itemCode: null,
    unitOfMeasure: "hour",
    quantity: "2",
    unitPrice: "50.0000",
    discountType: null,
    discountPercent: "0",
    discountAmount: "0",
    taxRateId: null,
    ...overrides,
  };
}

function storedDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    tenantId: TENANT_ID,
    type: "INVOICE" as DocumentType,
    status: "ISSUED" as DocumentStatus,
    currency: "KES",
    contactId: CONTACT_ID,
    customerNote: null,
    terms: null,
    dueDate: null,
    total: "100.0000",
    lines: [],
    ...overrides,
  };
}

describe("Phase 5 corrections and guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to edit a document that has been issued", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "ISSUED" }),
    );

    await expect(
      updateDraft(context(), USER_ID, {
        documentId: DOC_ID,
        contactId: null,
        currency: "KES",
        issueDate: new Date(),
        dueDate: null,
        expiryDate: null,
        deliveryDate: null,
        customerNote: null,
        terms: null,
        deliveryNote: null,
        sourceDocumentId: null,
        replacementOfId: null,
        lines: [linePayload()],
      }),
    ).rejects.toMatchObject({ code: "IMMUTABLE" });

    expect(prismaMock.document.update).not.toHaveBeenCalled();
    expect(prismaMock.documentLine.deleteMany).not.toHaveBeenCalled();
  });

  it("voids only invoices, and only from a voidable status", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "QUOTATION", status: "ISSUED" }),
    );
    await expect(
      voidInvoice(context(), USER_ID, {
        documentId: DOC_ID,
        reason: "mistake",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    vi.clearAllMocks();
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "INVOICE", status: "VOID" }),
    );
    await expect(
      voidInvoice(context(), USER_ID, {
        documentId: DOC_ID,
        reason: "mistake",
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("refuses a payment on a draft or a void invoice", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "DRAFT" }),
    );
    await expect(
      recordPayment(context(), USER_ID, {
        documentId: DOC_ID,
        amount: "10.0000",
        occurredOn: new Date(),
        method: "CASH",
        reference: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: "IMMUTABLE" });

    vi.clearAllMocks();
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "VOID" }),
    );
    await expect(
      recordPayment(context(), USER_ID, {
        documentId: DOC_ID,
        amount: "10.0000",
        occurredOn: new Date(),
        method: "CASH",
        reference: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("derives PARTIALLY_PAID from recorded payments, never from the caller", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ status: "ISSUED", total: "100.0000" }),
    );
    prismaMock.documentPayment.create.mockResolvedValue({ id: "pay_1" });
    prismaMock.documentPayment.findMany.mockResolvedValue([
      { amount: "40.0000" },
    ]);
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const result = await recordPayment(context(), USER_ID, {
      documentId: DOC_ID,
      amount: "40.0000",
      occurredOn: new Date(),
      method: "CASH",
      reference: null,
      note: null,
    });

    expect(result.status).toBe("PARTIALLY_PAID");
    const update = prismaMock.document.update.mock.calls[0]?.[0] as {
      data: { status: string };
    };
    expect(update.data.status).toBe("PARTIALLY_PAID");
  });

  it("refuses to record a quotation decision on a non-quotation", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "INVOICE", status: "ISSUED" }),
    );
    await expect(
      recordQuotationDecision(context(), USER_ID, {
        documentId: DOC_ID,
        decision: "ACCEPTED",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("Phase 5 quotation conversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to convert a quotation that was not accepted", async () => {
    prismaMock.document.findFirst.mockResolvedValue(
      storedDocument({ type: "QUOTATION", status: "ISSUED" }),
    );
    await expect(
      convertQuotationToInvoice(context(), USER_ID, { quotationId: DOC_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("copies the accepted quotation into a DRAFT invoice, preserving lines", async () => {
    const storedLine = {
      id: "line_1",
      tenantId: TENANT_ID,
      documentId: DOC_ID,
      position: 1,
      itemId: null,
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
    };

    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({
          type: "QUOTATION",
          status: "ACCEPTED",
          lines: [storedLine],
        }),
      )
      .mockResolvedValueOnce(null); // no invoice exists for this source yet
    prismaMock.document.create.mockResolvedValue({ id: "inv_1" });
    prismaMock.documentLine.createMany.mockResolvedValue({ count: 1 });
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const result = await convertQuotationToInvoice(context(), USER_ID, {
      quotationId: DOC_ID,
    });

    expect(result).toEqual({ id: "inv_1" });
    const create = prismaMock.document.create.mock.calls[0]?.[0] as {
      data: {
        type: string;
        status: string;
        sourceDocumentId: string;
        currency: string;
      };
    };
    expect(create.data).toMatchObject({
      type: "INVOICE",
      status: "DRAFT",
      sourceDocumentId: DOC_ID,
      currency: "KES",
    });
    // The converted invoice starts as a draft; it is issued explicitly.
    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_CONVERTED)).toHaveLength(1);
  });

  it("returns the existing invoice on a retried conversion instead of duplicating", async () => {
    prismaMock.document.findFirst
      .mockResolvedValueOnce(
        storedDocument({ type: "QUOTATION", status: "ACCEPTED", lines: [] }),
      )
      .mockResolvedValueOnce({ id: "inv_existing" });

    const result = await convertQuotationToInvoice(context(), USER_ID, {
      quotationId: DOC_ID,
    });
    expect(result).toEqual({ id: "inv_existing" });
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });
});

/* ══════════════════════════ AUTHORIZATION ════════════════════════════════ */

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

function request(url: string): NextRequest {
  return { url } as unknown as NextRequest;
}

describe("Phase 5 staff document download authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: null,
      status: "ACTIVE",
    });
    prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
    prismaMock.tenant.findUnique.mockResolvedValue({ locale: "en" });
    prismaMock.document.findFirst.mockResolvedValue({
      type: "INVOICE",
      number: "INV-2026-0007",
      snapshot: sampleSnapshot(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function get(tenantId = TENANT_ID, documentId = DOC_ID) {
    return staffPdfRoute(
      request(
        `http://localhost/api/documents/${documentId}/pdf?tenantId=${tenantId}`,
      ),
      { params: Promise.resolve({ documentId }) },
    );
  }

  it("refuses an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(401);
    expect(prismaMock.document.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a caller without documents.download (a portal user)", async () => {
    asRole("CUSTOMER_PORTAL_USER");
    const response = await get();
    expect(response.status).toBe(403);
    expect(prismaMock.document.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a non-member reaching another tenant", async () => {
    asRole("TENANT_ADMIN");
    const response = await get(OTHER_TENANT_ID);
    expect(response.status).toBe(403);
    expect(prismaMock.document.findFirst).not.toHaveBeenCalled();
  });

  it("404s a document id that is not in the caller's tenant", async () => {
    asRole("TENANT_ADMIN");
    prismaMock.document.findFirst.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(404);
  });

  it("409s a draft, which has no snapshot to print", async () => {
    asRole("TENANT_ADMIN");
    prismaMock.document.findFirst.mockResolvedValue({
      type: "INVOICE",
      number: null,
      snapshot: null,
    });
    const response = await get();
    expect(response.status).toBe(409);
  });

  it("streams a real PDF for an issued invoice and audits the download", async () => {
    asRole("TENANT_ADMIN");
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toContain("inline");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_DOWNLOADED)).toHaveLength(1);
  });
});

describe("Phase 5 customer-portal download authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: null,
      status: "ACTIVE",
    });
    prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
    prismaMock.tenant.findUnique.mockResolvedValue({ locale: "en" });
    prismaMock.contact.findFirst.mockResolvedValue({ id: CONTACT_ID });
    prismaMock.document.findFirst.mockResolvedValue({
      type: "INVOICE",
      number: "INV-2026-0007",
      snapshot: sampleSnapshot(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function get(tenantId = TENANT_ID, documentId = DOC_ID) {
    return portalPdfRoute(
      request(
        `http://localhost/api/portal/documents/${documentId}/pdf?tenantId=${tenantId}`,
      ),
      { params: Promise.resolve({ documentId }) },
    );
  }

  it("refuses an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(401);
  });

  it("refuses a staff user — the portal permission is a separate domain", async () => {
    asRole("TENANT_ADMIN");
    const response = await get();
    expect(response.status).toBe(403);
    expect(prismaMock.contact.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a portal user who is linked to no customer", async () => {
    asRole("CUSTOMER_PORTAL_USER");
    prismaMock.contact.findFirst.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(403);
  });

  it("404s a document belonging to a different customer", async () => {
    asRole("CUSTOMER_PORTAL_USER");
    prismaMock.document.findFirst.mockResolvedValue(null);
    const response = await get();

    expect(response.status).toBe(404);
    // The contact link is part of the query, not a post-filter.
    const where = prismaMock.document.findFirst.mock.calls[0]?.[0] as {
      where: { contactId: string; tenantId: string };
    };
    expect(where.where.contactId).toBe(CONTACT_ID);
    expect(where.where.tenantId).toBe(TENANT_ID);
  });

  it("streams the customer's own invoice PDF and audits the portal download", async () => {
    asRole("CUSTOMER_PORTAL_USER");
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_PORTAL_DOWNLOADED)).toHaveLength(1);
  });
});

describe("Phase 5 document write actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ id: USER_ID });
    prismaMock.user.findUnique.mockResolvedValue({
      platformRole: null,
      status: "ACTIVE",
    });
    prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const draftInput = {
    tenantId: TENANT_ID,
    type: "QUOTATION" as DocumentType,
    currency: "KES",
    issueDate: "2026-05-01T00:00:00.000Z",
    lines: [
      {
        description: "Consulting",
        quantity: "2",
        unitPrice: "50",
        unitOfMeasure: "hour" as const,
      },
    ],
  };

  it("refuses a role without the create permission, and writes nothing", async () => {
    asRole("VIEWER");
    const result = await createDocumentDraftAction(draftInput);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("FORBIDDEN");
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("creates a draft for an authorized role and audits it", async () => {
    asRole("TENANT_ADMIN");
    prismaMock.document.create.mockResolvedValue({ id: "draft_1" });
    prismaMock.documentLine.createMany.mockResolvedValue({ count: 1 });
    prismaMock.documentStatusEvent.create.mockResolvedValue({});

    const result = await createDocumentDraftAction(draftInput);

    expect(result).toEqual({ success: true, data: { id: "draft_1" } });
    expect(prismaMock.document.create).toHaveBeenCalledTimes(1);
    const create = prismaMock.document.create.mock.calls[0]?.[0] as {
      data: { tenantId: string; status: string; number: string | null };
    };
    // The tenant comes from the authorized context, and a draft has no number.
    expect(create.data.tenantId).toBe(TENANT_ID);
    expect(create.data.status).toBe("DRAFT");
    expect(create.data.number).toBeNull();
    expect(auditsFor(AUDIT_ACTIONS.DOCUMENT_CREATED)).toHaveLength(1);
  });

  it("rejects invalid input before any authorization or write", async () => {
    asRole("TENANT_ADMIN");
    const result = await createDocumentDraftAction({
      tenantId: "not-a-uuid",
      type: "INVOICE",
      currency: "KES",
      issueDate: "2026-05-01T00:00:00.000Z",
      lines: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.tenantMember.findUnique).not.toHaveBeenCalled();
  });
});
