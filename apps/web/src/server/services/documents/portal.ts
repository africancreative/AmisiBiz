import { prisma } from "@amisibiz/database";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  authorizeTenant,
  type TenantAuthzContext,
} from "@/server/auth/authorization";
import { DocumentServiceError } from "./errors";

/**
 * Customer-portal document access.
 *
 * A portal user holds the CUSTOMER_PORTAL_USER tenant role. That role is the
 * only one granted the `portal.documents.*` permissions, and it is granted NO
 * staff document permission, so the two download routes can never be confused
 * for one another: a portal user is refused by the staff route and a staff user
 * is refused here.
 *
 * Being a portal user is not enough, though. Access to *documents* is decided by
 * the `Contact.portalUserId` link: a portal user sees documents only for the one
 * customer identity they are linked to in this tenant. This resolver returns
 * that contact id, and the route compares it against the document's `contactId`.
 * There is deliberately no \"list every document\" path for a portal user — the
 * link is the whole of the grant.
 */

export interface PortalContext {
  authz: TenantAuthzContext;
  /** The single customer identity this portal user may read in this tenant. */
  contactId: string;
}

export async function resolvePortalContext(
  userId: string,
  tenantId: string,
): Promise<PortalContext> {
  // Proves membership, the portal role, and the portal read permission all at
  // once; a forged tenant id or a suspended tenant is refused here.
  const authz = await authorizeTenant(
    userId,
    tenantId,
    PERMISSIONS.PORTAL_DOCUMENTS_READ,
  );

  const contact = await prisma.contact.findFirst({
    where: { tenantId, portalUserId: userId },
    select: { id: true },
  });
  if (!contact) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      "No customer portal is configured for this account.",
    );
  }

  return { authz, contactId: contact.id };
}
