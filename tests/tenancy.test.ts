import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RESERVED_SUBDOMAINS,
  buildTenantHostname,
  extractSubdomain,
  getBaseDomain,
  isReservedSubdomain,
  isValidSlug,
  normalizeHost,
  resolveRequestHost,
} from "@/lib/tenancy/host";
import { generateUniqueTenantSlug } from "@/server/services/tenant-provisioning";

describe("slug validation", () => {
  it("accepts well-formed workspace slugs", () => {
    expect(isValidSlug("acme")).toBe(true);
    expect(isValidSlug("acme-co")).toBe(true);
    expect(isValidSlug("ab")).toBe(true);
    expect(isValidSlug("a1")).toBe(true);
  });

  it("rejects malformed slugs", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("-acme")).toBe(false);
    expect(isValidSlug("acme-")).toBe(false);
    expect(isValidSlug("acme_co")).toBe(false);
    expect(isValidSlug("acme co")).toBe(false);
    expect(isValidSlug("a".repeat(64))).toBe(false);
  });

  it("rejects reserved subdomains regardless of case", () => {
    for (const reserved of RESERVED_SUBDOMAINS) {
      expect(isReservedSubdomain(reserved)).toBe(true);
    }
    expect(isValidSlug("Admin")).toBe(false);
    expect(isValidSlug("WWW")).toBe(false);
  });
});

describe("hostname parsing", () => {
  it("normalises host casing, trailing dots and ports", () => {
    expect(normalizeHost("Acme.AmisiBiz.com.")).toBe("acme.amisibiz.com");
    expect(normalizeHost("acme.amisibiz.com:3000")).toBe("acme.amisibiz.com");
    expect(normalizeHost(null)).toBe("");
  });

  it("extracts a single-label tenant subdomain", () => {
    expect(extractSubdomain("acme.amisibiz.com", "amisibiz.com")).toBe("acme");
    expect(extractSubdomain("AmisiBiz.com", "amisibiz.com")).toBe(null);
  });

  it("does not resolve deeper or unrelated hosts", () => {
    expect(extractSubdomain("a.b.amisibiz.com", "amisibiz.com")).toBe(null);
    expect(extractSubdomain("acme.other.com", "amisibiz.com")).toBe(null);
    expect(extractSubdomain("evilamisibiz.com", "amisibiz.com")).toBe(null);
  });

  it("builds canonical workspace hostnames", () => {
    expect(buildTenantHostname("acme", "amisibiz.com")).toBe(
      "acme.amisibiz.com",
    );
    expect(buildTenantHostname("acme", null)).toBe(null);
  });
});

describe("request host resolution", () => {
  it("ignores forwarded-host headers by default", () => {
    expect(
      resolveRequestHost({
        host: "app.amisibiz.com",
        forwardedHost: "attacker.example.com",
        trustProxy: false,
      }),
    ).toBe("app.amisibiz.com");
  });

  it("honours forwarded-host only behind a trusted proxy", () => {
    expect(
      resolveRequestHost({
        host: "internal.local",
        forwardedHost: "acme.amisibiz.com, proxy.internal",
        trustProxy: true,
      }),
    ).toBe("acme.amisibiz.com");
  });
});

describe("base domain configuration", () => {
  const original = process.env.APP_BASE_DOMAIN;
  const originalPublic = process.env.NEXT_PUBLIC_APP_BASE_DOMAIN;

  afterEach(() => {
    if (original === undefined) delete process.env.APP_BASE_DOMAIN;
    else process.env.APP_BASE_DOMAIN = original;
    if (originalPublic === undefined)
      delete process.env.NEXT_PUBLIC_APP_BASE_DOMAIN;
    else process.env.NEXT_PUBLIC_APP_BASE_DOMAIN = originalPublic;
  });

  it("reads the configurable base domain (never hardcoded)", () => {
    process.env.APP_BASE_DOMAIN = "AmisiBiz.com";
    expect(getBaseDomain()).toBe("amisibiz.com");
  });

  it("is null when unconfigured", () => {
    delete process.env.APP_BASE_DOMAIN;
    delete process.env.NEXT_PUBLIC_APP_BASE_DOMAIN;
    expect(getBaseDomain()).toBe(null);
  });
});

describe("provisioning slug generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to a safe base when the preferred slug is reserved", async () => {
    const tx = {
      tenant: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never;
    const slug = await generateUniqueTenantSlug(tx, "Admin", "admin");
    expect(slug).toBe("workspace");
  });

  it("resolves collisions with a numeric suffix", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ id: "t1" })
      .mockResolvedValueOnce(null);
    const tx = { tenant: { findUnique } } as never;
    const slug = await generateUniqueTenantSlug(tx, "Acme Co");
    expect(slug).toBe("acme-co-1");
  });
});
