import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  MOCK_ADAPTERS,
  adapterLabel,
  declinedByProvider,
  etimsLabel,
  failed,
  isVerified,
  paymentIsSettled,
  sourceCanVerify,
  unverified,
  verifiedByProvider,
  type PaymentStatus,
} from "@amisibiz/integrations";

/**
 * Phase 04.5e — integration boundaries.
 *
 * These tests lock the *rules*, not behaviour against a provider: no provider is
 * contacted anywhere in this phase. They assert that
 *
 *  (a) a stand-in can never fabricate confirmation — the property the whole
 *      boundary exists for;
 *  (b) the POS port exposes no stock-mutating extension point; and
 *  (c) — by reading the package source — the boundary contains no network call
 *      and no credential read.
 */

const SRC_DIR = fileURLToPath(
  new URL("../../../packages/integrations/src", import.meta.url),
);

function packageSource(): string {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(SRC_DIR, name), "utf8"))
    .join("\n");
}

/** Method names declared on a prototype, minus the constructor. */
function methodsOf(instance: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(instance))
    .filter((name) => name !== "constructor")
    .sort();
}

describe("verification model", () => {
  it("only a provider source can confirm", () => {
    expect(sourceCanVerify("provider")).toBe(true);
    for (const source of ["mock", "client", "redirect", "device", "manual"]) {
      expect(sourceCanVerify(source as "provider")).toBe(false);
    }
  });

  it("an unverified outcome is never 'verified'", () => {
    const outcome = unverified("mock", "stand-in");
    expect(outcome.status).toBe("unverified");
    expect(isVerified(outcome)).toBe(false);
  });

  it("a provider-confirmed outcome is the only verified shape", () => {
    const outcome = verifiedByProvider("prov-ref-1", { ok: true });
    expect(isVerified(outcome)).toBe(true);
    expect(outcome.source).toBe("provider");
    expect(outcome.reference).toBe("prov-ref-1");
  });

  it("a mock can never label an eTIMS submission as recognized", () => {
    expect(etimsLabel(unverified("mock", "stand-in"))).toBe("not_submitted");
    expect(etimsLabel(unverified("client", "queued"))).toBe("not_submitted");
    expect(etimsLabel(declinedByProvider("bad PIN"))).toBe("rejected");
    expect(etimsLabel(failed("provider", "timeout"))).toBe("pending");
    expect(
      etimsLabel(
        verifiedByProvider("integrator-ref", {
          submissionReference: "integrator-ref",
          fiscalInvoiceNumber: "KRA-0001",
          signature: "sig",
        }),
      ),
    ).toBe("recognized");
  });

  it("only a provider-verified 'paid' state settles a payment", () => {
    const paid: PaymentStatus = {
      providerReference: "prov-ref",
      state: "paid",
      amount: "1000.00",
      currency: "KES",
    };
    const pending: PaymentStatus = { ...paid, state: "pending" };

    expect(paymentIsSettled(unverified("redirect", "returned to URL"))).toBe(
      false,
    );
    expect(paymentIsSettled(unverified("mock", "stand-in"))).toBe(false);
    expect(paymentIsSettled(verifiedByProvider("prov-ref", pending))).toBe(
      false,
    );
    expect(paymentIsSettled(verifiedByProvider("prov-ref", paid))).toBe(true);
  });
});

describe("mock adapters everywhere declare themselves", () => {
  it("all stand-ins report isLive: false and a MOCK label", () => {
    for (const adapter of Object.values(MOCK_ADAPTERS)) {
      expect(adapter.isLive).toBe(false);
      expect(adapterLabel(adapter)).toContain("MOCK");
    }
  });

  it("no mock method can return a verified outcome", async () => {
    const etims = await MOCK_ADAPTERS.etims.submitInvoice({
      documentId: "d1",
      documentNumber: "QT-0001",
      issuedAt: new Date().toISOString(),
      sellerPin: "P000000000X",
      buyerPin: null,
      currency: "KES",
      lines: [],
      total: "0.00",
      taxTotal: "0.00",
    });
    expect(isVerified(etims)).toBe(false);

    const session = await MOCK_ADAPTERS.payments.createSession({
      orderReference: "INV-0001",
      amount: "1000.00",
      currency: "KES",
      description: "test",
      returnUrl: "https://example.test/return",
      customerEmail: null,
    });
    expect(isVerified(session)).toBe(false);

    const status = await MOCK_ADAPTERS.payments.queryStatus("prov-ref");
    expect(isVerified(status)).toBe(false);
    expect(paymentIsSettled(status)).toBe(false);

    const catalogue = await MOCK_ADAPTERS.pos.listCatalogue();
    expect(isVerified(catalogue)).toBe(false);

    const sale = await MOCK_ADAPTERS.pos.exportSale({
      deviceSaleId: "device-sale-1",
      occurredAt: new Date().toISOString(),
      lines: [],
      total: "0.00",
      currency: "KES",
    });
    expect(isVerified(sale)).toBe(false);
  });

  it("exposes exactly the intended extension points (POS: no stock mutation)", () => {
    // A whitelist is the assertion that matters: adding a stock method would fail
    // this test rather than slip through as a new capability.
    expect(methodsOf(MOCK_ADAPTERS.etims)).toEqual([
      "querySubmission",
      "submitInvoice",
    ]);
    expect(methodsOf(MOCK_ADAPTERS.payments)).toEqual([
      "createSession",
      "queryStatus",
    ]);
    expect(methodsOf(MOCK_ADAPTERS.pos)).toEqual([
      "exportSale",
      "listCatalogue",
    ]);
  });

  it("names no stock-, inventory- or settlement-driving method", () => {
    for (const adapter of Object.values(MOCK_ADAPTERS)) {
      for (const method of methodsOf(adapter)) {
        expect(method).not.toMatch(
          /stock|inventory|deduct|reserve|commit|settle/i,
        );
      }
    }
  });
});

describe("the boundary contains no live call and no credential", () => {
  const source = packageSource();

  it("performs no network I/O", () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/XMLHttpRequest|axios|node-fetch/);
  });

  it("reads no environment variable or credential", () => {
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/api[_-]?key|secret|password|token/i);
  });
});
