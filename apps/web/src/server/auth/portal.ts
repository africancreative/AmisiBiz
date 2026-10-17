import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session-user";
import { prisma, runInScope, sessionScope } from "@amisibiz/database";
import { PERMISSIONS } from "@amisibiz/auth";
import { authorizeTenant } from "./authorization";
import { resolvePortalContext, type PortalContext } from "@/server/services/documents/portal";

export type PortalState =
  | {
      status: "ok";
      user: { id: string; name: string | null; email: string | null };
      tenant: {
        id: string;
        name: string;
        slug: string;
        currency: string;
        locale: string | null;
      };
      contact: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        email: string | null;
      };
      context: PortalContext;
    }
  | { status: "no_portal"; reason: string };

/**
 * Server-side customer portal guard for `/portal/*`.
 *
 * Verifies that the signed-in user has an active customer portal link
 * and portal read permissions. Never exposes internal business records.
 */
export async function getPortalState(locale = "en"): Promise<PortalState> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/${locale}/login`);
    return {
      status: "no_portal",
      reason: "Unauthenticated",
    };
  }

  // 1. Locate the Contact record explicitly linked to this portal user
  const contact = await runInScope(sessionScope(user.id), () =>
    prisma.contact.findFirst({
      where: { portalUserId: user.id },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            currency: true,
            locale: true,
            status: true,
          },
        },
      },
    }),
  );

  if (!contact || !contact.tenant) {
    return {
      status: "no_portal",
      reason: "No business customer portal is linked to this account.",
    };
  }

  // 2. Authorize portal access via resolvePortalContext
  try {
    const portal = await resolvePortalContext(user.id, contact.tenantId);
    return {
      status: "ok",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      tenant: contact.tenant,
      contact: {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        companyName: contact.companyName,
        email: contact.email,
      },
      context: portal,
    };
  } catch (error) {
    return {
      status: "no_portal",
      reason:
        error instanceof Error
          ? error.message
          : "Access to the customer portal was denied.",
    };
  }
}
