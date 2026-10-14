import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantRole } from "@prisma/client";

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
}));

import { prismaMock } from "./prisma-mock";
import { authMock } from "./auth-mock";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";

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
    id: USER_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: null,
    status: "ACTIVE",
  });
  // Tenant authorization re-reads the actor's platform standing from the `User`
  // row rather than trusting the token claim, so the guard's happy path needs
  // that row to exist. Ordinary ACTIVE business user unless a case says other-
  // wise.
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
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

  it("opens a suspended tenant read-only and refuses its writes", async () => {
    // Phase 2 decision: suspension pauses a workspace's writes and
    // synchronization, and deliberately keeps its own records readable and
    // downloadable. The guard therefore reports a read-only `ok` for the ordinary
    // workspace page — which is where the owner reads the invoices the platform
    // says they may still read — and a `blocked` refusal as soon as the page
    // asks for a write permission.
    prismaMock.tenantMember.findFirst.mockResolvedValue(
      primaryMembership("TENANT_OWNER"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValue({
      role: "TENANT_OWNER",
      tenant: { status: "SUSPENDED" },
    });

    const state = await getWorkspaceState("en");

    expect(state).toMatchObject({ status: "ok", readonly: true });
    if (state.status === "ok") {
      expect(state.context.tenantStatus).toBe("SUSPENDED");
      expect(state.context.readonly).toBe(true);
    }

    const write = await getWorkspaceState("en", PERMISSIONS.CONTACTS_CREATE);
    expect(write).toMatchObject({ status: "blocked", reason: "forbidden" });

    // A suspended tenant's reads still pass: reading issued documents is exactly
    // what the decision protects.
    const read = await getWorkspaceState("en", PERMISSIONS.DOCUMENTS_READ);
    expect(read).toMatchObject({ status: "ok", readonly: true });
  });

  it("blocks a PENDING tenant outright", async () => {
    // PENDING is not "suspended but readable": the workspace was never opened, so
    // there is nothing of the business's to show it.
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("TENANT_OWNER"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "TENANT_OWNER",
      tenant: { status: "PENDING" },
    });

    const state = await getWorkspaceState("en");

    expect(state).toMatchObject({ status: "blocked", reason: "pending" });
  });

  it("blocks cross-tenant access when the membership lookup finds nothing", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("TENANT_OWNER"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce(null);

    const state = await getWorkspaceState("en");

    expect(state).toMatchObject({ status: "blocked", reason: "no_membership" });
  });

  it("allows an active member and exposes an authorization context", async () => {
    prismaMock.tenantMember.findFirst.mockResolvedValueOnce(
      primaryMembership("TENANT_ADMIN"),
    );
    prismaMock.tenantMember.findUnique.mockResolvedValueOnce({
      role: "TENANT_ADMIN",
      tenant: { status: "ACTIVE" },
    });

    const state = await getWorkspaceState("en");

    expect(state.status).toBe("ok");
    if (state.status === "ok") {
      expect(state.context.role).toBe("TENANT_ADMIN");
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
