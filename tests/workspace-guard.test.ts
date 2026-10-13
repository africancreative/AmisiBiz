import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantRole } from "@prisma/client";

vi.mock("@/lib/db/prisma", () => import("./prisma-mock"));
vi.mock("@/lib/auth/config", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { prismaMock } from "./prisma-mock";
import { authMock } from "./auth-mock";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@/lib/auth/permissions";

const TENANT_ID = "cktenant0000000000000001";
const USER_ID = "ckuser00000000000000001";

function primaryMembership(role: TenantRole) {
  return {
    tenantId: TENANT_ID,
    role,
    tenant: { id: TENANT_ID, name: "Acme Ltd", slug: "acme" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({
    user: {
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      platformRole: "USER",
      status: "ACTIVE",
    },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  });
  prismaMock.auditLog.create.mockResolvedValue({ id: "log_1" });
});

describe("getWorkspaceState — server-side workspace guard", () => {
  it("redirects unauthenticated users to the login page", async () => {
    authMock.mockResolvedValueOnce(null);
    await expect(getWorkspaceState("en")).rejects.toThrow("REDIRECT:/en/login");
  });

  it("returns no_workspace when the user has no membership", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(null);

    const state = await getWorkspaceState("en");

    expect(state.status).toBe("no_workspace");
  });

  it("blocks access to a suspended tenant even for an owner", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("BUSINESS_OWNER"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "BUSINESS_OWNER",
      tenant: { status: "SUSPENDED" },
    });

    const state = await getWorkspaceState("en");

    expect(state).toMatchObject({ status: "blocked", reason: "suspended" });
  });

  it("blocks cross-tenant access when the membership lookup finds nothing", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("BUSINESS_OWNER"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce(null);

    const state = await getWorkspaceState("en");

    expect(state).toMatchObject({ status: "blocked", reason: "no_membership" });
  });

  it("allows an active member and exposes an authorization context", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("BUSINESS_ADMIN"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "BUSINESS_ADMIN",
      tenant: { status: "ACTIVE" },
    });

    const state = await getWorkspaceState("en");

    expect(state.status).toBe("ok");
    if (state.status === "ok") {
      expect(state.context.role).toBe("BUSINESS_ADMIN");
      expect(state.context.tenantId).toBe(TENANT_ID);
    }
  });

  it("denies by default when the role lacks the required permission", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("VIEWER"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "VIEWER",
      tenant: { status: "ACTIVE" },
    });

    const state = await getWorkspaceState("en", PERMISSIONS.CONTACTS_DELETE);

    expect(state).toMatchObject({ status: "blocked", reason: "forbidden" });
  });

  it("allows when the role holds the required permission", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("VIEWER"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "VIEWER",
      tenant: { status: "ACTIVE" },
    });

    const state = await getWorkspaceState("en", PERMISSIONS.CONTACTS_READ);

    expect(state.status).toBe("ok");
  });
});
