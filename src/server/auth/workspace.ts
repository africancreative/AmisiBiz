import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { getPrimaryMembership } from "@/lib/auth/helpers";
import type { Permission } from "@/lib/auth/permissions";
import {
  resolveTenantContext,
  authorizeTenant,
  AuthorizationError,
  type TenantAuthzContext,
} from "./authorization";

/**
 * Server-side workspace guard for tenant pages (`/app/*`).
 *
 * Resolves the signed-in user, their active tenant membership and — when a
 * permission is supplied — authorizes that permission against the database.
 * Never trusts a browser-provided role or membership.
 */
export type WorkspaceState =
  | {
      status: "ok";
      session: {
        user: { id: string; name?: string | null; email?: string | null };
      };
      membership: NonNullable<Awaited<ReturnType<typeof getPrimaryMembership>>>;
      context: TenantAuthzContext;
    }
  | { status: "no_workspace" }
  | { status: "blocked"; reason: "suspended" | "no_membership" | "forbidden" };

export async function getWorkspaceState(
  locale: string,
  permission?: Permission,
): Promise<WorkspaceState> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const membership = await getPrimaryMembership(session.user.id);
  if (!membership) {
    return { status: "no_workspace" };
  }

  try {
    const context = permission
      ? await authorizeTenant(session.user.id, membership.tenantId, permission)
      : await resolveTenantContext(session.user.id, membership.tenantId);

    return {
      status: "ok",
      session: {
        user: {
          id: session.user.id,
          name: session.user.name ?? null,
          email: session.user.email ?? null,
        },
      },
      membership,
      context,
    };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.code === "TENANT_SUSPENDED") {
        return { status: "blocked", reason: "suspended" };
      }
      if (error.code === "FORBIDDEN") {
        return { status: "blocked", reason: "forbidden" };
      }
      return { status: "blocked", reason: "no_membership" };
    }
    throw error;
  }
}
