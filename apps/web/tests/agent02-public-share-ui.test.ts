import { describe, it, expect } from "vitest";
import {
  parseShareResolve,
  parsePublicProduct,
  parsePublicOrderStatus,
  parseLeadCaptureResponse,
  isValidPublicToken,
} from "@/lib/public-share";

/**
 * AGENT 02 Phase 3 — the public `/s/<token>` pages read the SECURITY DEFINER
 * jsonb payloads verbatim. `jsonb_strip_nulls` deletes every null key, so the
 * guards must accept payloads with optional fields absent and reject anything
 * that does not look like its own shape (an error body, a page, a list).
 */

describe("share resolve payload guard", () => {
  it("accepts the function's minimal payload", () => {
    const parsed = parseShareResolve({
      tenantId: "11111111-1111-4111-8111-111111111111",
      id: "22222222-2222-4222-8222-222222222222",
      kind: "PRODUCT",
      itemId: "33333333-3333-4333-8333-333333333333",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("PRODUCT");
  });

  it("rejects unknown kinds and missing tenant", () => {
    expect(
      parseShareResolve({ tenantId: "t", id: "i", kind: "SECRET" }),
    ).toBeNull();
    expect(parseShareResolve({ id: "i", kind: "PRODUCT" })).toBeNull();
    expect(parseShareResolve(null)).toBeNull();
    expect(parseShareResolve("Not found")).toBeNull();
  });
});

describe("public product payload guard", () => {
  const base = {
    tenantId: "t1",
    shareLinkId: "s1",
    item: {
      id: "i1",
      name: "Goat milk soap",
      currency: "KES",
      status: "ACTIVE",
    },
    variants: [{ id: "v1", name: "500ml", unitPrice: 1200.5, currency: "KES" }],
  };

  it("coerces jsonb money numbers to decimal strings", () => {
    const parsed = parsePublicProduct(base);
    expect(parsed?.variants[0]?.unitPrice).toBe("1200.5");
  });

  it("tolerates stripped nulls (no description, no tenant block)", () => {
    const parsed = parsePublicProduct(base);
    expect(parsed).not.toBeNull();
    expect(parsed?.item.description).toBeUndefined();
    expect(parsed?.tenant).toBeUndefined();
  });

  it("defaults a missing variants list to empty, rejects wrong shapes", () => {
    const withoutVariants = parsePublicProduct({
      ...base,
      variants: undefined,
    });
    expect(withoutVariants?.variants).toEqual([]);
    expect(parsePublicProduct({ ...base, item: undefined })).toBeNull();
    expect(
      parsePublicProduct({ success: false, error: "Not found" }),
    ).toBeNull();
  });
});

describe("public order-status payload guard", () => {
  const base = {
    id: "d1",
    number: "ORD-0007",
    status: "ISSUED",
    currency: "KES",
    total: 45000,
    tenantId: "t1",
    shareLinkId: "s1",
    quantity: 10,
    deliveredQuantity: 4,
    deliveredRatio: 0.4,
    fullyDelivered: false,
  };

  it("accepts the derived delivery facts and coerces money to string", () => {
    const parsed = parsePublicOrderStatus(base);
    expect(parsed?.total).toBe("45000");
    expect(parsed?.deliveredRatio).toBe("0.4");
    expect(parsed?.fullyDelivered).toBe(false);
  });

  it("refuses payloads that hide nothing-but-internals or miss required keys", () => {
    expect(parsePublicOrderStatus({ ...base, total: undefined })).toBeNull();
    expect(
      parsePublicOrderStatus({ ...base, fullyDelivered: "yes" }),
    ).toBeNull();
  });
});

describe("lead capture response guard", () => {
  it("accepts {leadId, duplicateSuspect} and rejects error bodies", () => {
    expect(
      parseLeadCaptureResponse({ leadId: "l1", duplicateSuspect: true })
        ?.duplicateSuspect,
    ).toBe(true);
    expect(parseLeadCaptureResponse({ error: "Invalid request" })).toBeNull();
  });
});

describe("public token format gate", () => {
  it("mirrors the API routes' TOKEN_PATTERN", () => {
    expect(isValidPublicToken("abcXYZ_0-1")).toBe(true);
    expect(isValidPublicToken("has space")).toBe(false);
    expect(isValidPublicToken("")).toBe(false);
    expect(isValidPublicToken(undefined)).toBe(false);
    expect(isValidPublicToken("a".repeat(129))).toBe(false);
  });
});
