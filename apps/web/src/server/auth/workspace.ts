import { redirect } from "next/navigation";
import { getPrimaryMembership } from "@/lib/auth/helpers";
import { getSessionUser } from "@/lib/auth/session-user";
import type { Permission } from "@amisibiz/auth";
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
 *
 * Suspension is deliberately NOT a refusal to enter the workspace: the owner's
 * Phase 2 decision is that a suspended business keeps reading and downloading
 * what it already has, so the guard reports `readonly: true` and every page —
 * and `authorizeTenant` for anything that writes — acts on that. A PENDING
 * workspace has never been opened, so it stays closed (`blocked`, reason
 * `pending`).
 */
export type WorkspaceState =
  | {
      status: "ok";
      session: {
        user: { id: string; name?: string | null; email?: string | null };
      };
      membership: NonNullable<Awaited<ReturnType<typeof getPrimaryMembership>>>;
      context: TenantAuthzContext;
      /**
       * True when the workspace may be read but not written: a suspended
       * business, or a provider support grant. Pages use it to hide write
       * affordances; it is not the enforcement (the guard and the policies are).
       */
      readonly: boolean;
    }
  | { status: "no_workspace" }
  | { status: "blocked"; reason: "pending" | "no_membership" | "forbidden" };

export async function getWorkspaceState(
  locale: string,
  permission?: Permission,
): Promise<WorkspaceState> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/${locale}/login`);
  }

  const membership = await getPrimaryMembership(user.id);
  if (!membership) {
    return { status: "no_workspace" };
  }

  try {
    const context = permission
      ? await authorizeTenant(user.id, membership.tenantId, permission)
      : await resolveTenantContext(user.id, membership.tenantId);

    return {
      status: "ok",
      session: {
        user: {
          id: user.id,
          name: user.name ?? null,
          email: user.email ?? null,
        },
      },
      membership,
      context,
      readonly: context.readonly,
    };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.code === "TENANT_PENDING") {
        return { status: "blocked", reason: "pending" };
      }
      if (error.code === "FORBIDDEN") {
        return { status: "blocked", reason: "forbidden" };
      }
      return { status: "blocked", reason: "no_membership" };
    }
    throw error;
  }
}
