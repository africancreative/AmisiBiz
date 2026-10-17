import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

import { getPortalState } from "@/server/auth/portal";
import { authMock } from "./auth-mock";
import { prismaMock } from "./prisma-mock";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

describe("Customer Portal Authorization Guard (getPortalState)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({
      id: USER_ID,
      name: "Customer Bob",
      email: "bob@example.com",
      platformRole: null,
      status: "ACTIVE",
    });
    prismaMock.user.findUnique.mockResolvedValue({
      id: USER_ID,
      platformRole: null,
      status: "ACTIVE",
    });
    prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redirects to login when unauthenticated", async () => {
    authMock.mockResolvedValueOnce(null);
    await expect(getPortalState("en")).rejects.toThrow("REDIRECT:/en/login");
  });

  it("returns status: 'no_portal' when no contact link exists", async () => {
    prismaMock.contact.findFirst.mockResolvedValueOnce(null);
    const result = await getPortalState("en");
    expect(result.status).toBe("no_portal");
    if (result.status === "no_portal") {
      expect(result.reason).toContain("No business customer portal is linked");
    }
  });

  it("returns status: 'ok' when user has a valid linked contact and portal role", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      firstName: "Bob",
      lastName: "Builder",
      companyName: "Bob Enterprises",
      email: "bob@example.com",
      tenant: {
        id: TENANT_ID,
        name: "Amisi Genuine Tenant",
        slug: "amisi-tenant",
        currency: "KES",
        locale: "en",
        status: "ACTIVE",
      },
    });

    prismaMock.tenantMember.findUnique.mockResolvedValue({
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "CUSTOMER_PORTAL_USER",
      tenant: { status: "ACTIVE" },
    });

    const result = await getPortalState("en");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.contact.id).toBe(CONTACT_ID);
      expect(result.tenant.id).toBe(TENANT_ID);
      expect(result.tenant.name).toBe("Amisi Genuine Tenant");
      expect(result.user.id).toBe(USER_ID);
    }
  });

  it("returns status: 'no_portal' if user lacks the customer portal role on that tenant", async () => {
    prismaMock.contact.findFirst.mockResolvedValueOnce({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      firstName: "Bob",
      lastName: "Builder",
      companyName: "Bob Enterprises",
      email: "bob@example.com",
      tenant: {
        id: TENANT_ID,
        name: "Amisi Genuine Tenant",
        slug: "amisi-tenant",
        currency: "KES",
        locale: "en",
        status: "ACTIVE",
      },
    });

    // User is not a member of the tenant
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce(null);

    const result = await getPortalState("en");
    expect(result.status).toBe("no_portal");
  });
});
