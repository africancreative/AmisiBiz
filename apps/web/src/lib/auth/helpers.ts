import { getSessionUser, type AppSessionUser } from "@/lib/auth/session-user";
import { prisma, runInScope, sessionScope } from "@amisibiz/database";
import { redirect } from "next/navigation";
import type { PlatformRole, TenantRole } from "@prisma/client";

/** App session wrapper kept for call-site compatibility (`session.user.*`). */
export type AppSession = { user: AppSessionUser };

/**
 * Returns the validated current user or null.
 * Use in Server Components and Server Actions.
 */
export async function getSession(): Promise<AppSession | null> {
  const user = await getSessionUser();
  return user ? { user } : null;
}

/**
 * Returns the current session, redirecting to login if unauthenticated.
 * Use at the top of any protected Server Component.
 *
 * This is a UI-level convenience only. Server Actions and API routes MUST
 * additionally call the authorization service before touching data.
 */
export async function requireAuth(locale = "en"): Promise<AppSession> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/${locale}/login`);
  }
  return { user };
}

/**
 * Returns the tenant membership for a user within a specific tenant, or null.
 * This is the authoritative membership lookup used by the authorization service.
 */
export async function getTenantMembership(userId: string, tenantId: string) {
  return prisma.tenantMember.findUnique({
    where: {
      tenantId_userId: { tenantId, userId },
    },
    include: {
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          currency: true,
          timezone: true,
          locale: true,
        },
      },
    },
  });
}

/**
 * Returns the user's default (or earliest) tenant membership, used to resolve
 * the active tenant for dashboard and team screens.
 *
 * Runs inside its own `sessionScope(userId)` via `runInScope`. It cannot rely on
 * the scope `getSessionUser()` opened: that runs after `await`s, and
 * `enterWith()` only reaches the caller when it is called before the first
 * `await`, so the ambient scope is gone by the time this query would run.
 */
export async function getPrimaryMembership(userId: string) {
  return runInScope(sessionScope(userId), () =>
    prisma.tenantMember.findFirst({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { joinedAt: "asc" }],
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            currency: true,
            timezone: true,
            locale: true,
            planId: true,
          },
        },
      },
    }),
  );
}

/**
 * Rank of each tenant role, used ONLY for delegated-administration guards
 * (e.g. a member may never act on a peer/equal or superior). It is NOT a
 * permission source — always use the permission service for authorization.
 */
export const TENANT_ROLE_RANK: Record<TenantRole, number> = {
  TENANT_OWNER: 6,
  TENANT_ADMIN: 5,
  SALES: 4,
  FINANCE: 4,
  OPERATIONS: 4,
  VIEWER: 2,
  CUSTOMER_PORTAL_USER: 1,
};

/** Returns true if the given role meets or exceeds the minimum rank. */
export function hasAtLeastTenantRole(
  userRole: TenantRole,
  minimumRole: TenantRole,
): boolean {
  return TENANT_ROLE_RANK[userRole] >= TENANT_ROLE_RANK[minimumRole];
}

/** Returns true if the user holds platform super-administrator status. */
export function isPlatformAdmin(platformRole: PlatformRole | null): boolean {
  return platformRole === "SUPER_ADMIN";
}
