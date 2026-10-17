import { redirect } from "next/navigation";
import { requireAuth, getPrimaryMembership } from "@/lib/auth/helpers";

export const dynamic = "force-dynamic";

/**
 * The landing route a signed-in user is sent to.
 *
 * This page decides which area an account belongs in and forwards there. It
 * renders nothing, on purpose: the dashboard the AGENT 4 workspace asks for is
 * the overview at `/app`, which re-authorizes through `getWorkspaceState`, hides
 * every action the caller's role does not permit, and lives inside the workspace
 * shell next to the navigation that gates itself the same way. A second page
 * here — printing the tenant's slug, status enum, currency and timezone straight
 * off the membership row — would be a weaker copy of that overview whose
 * permission rules someone had to remember separately, and it would be the one
 * surface where they were not applied.
 *
 * So the only question answered here is "where does this account live":
 *
 * - A platform administrator with no workspace of their own goes to `/admin`.
 *   An administrator who IS a member of a business keeps landing in that
 *   business, exactly as before; the platform console is reached from its own
 *   route, and it is guarded there.
 * - A `CUSTOMER_PORTAL_USER` goes to `/portal` and never into the workspace.
 *   That role holds no business permissions, so `/app` would refuse it anyway —
 *   forwarding here means the customer is not shown a denial on the way to the
 *   screen that is theirs.
 * - Everyone else goes to their workspace overview — including a user with no
 *   membership at all, whose `/app` guard explains the state in their own
 *   language instead of this page guessing at a cause.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await requireAuth(locale);
  const membership = await getPrimaryMembership(session.user.id);

  if (!membership && session.user.platformRole === "SUPER_ADMIN") {
    redirect(`/${locale}/admin`);
  }

  if (membership?.role === "CUSTOMER_PORTAL_USER") {
    redirect(`/${locale}/portal`);
  }

  redirect(`/${locale}/app`);
}
