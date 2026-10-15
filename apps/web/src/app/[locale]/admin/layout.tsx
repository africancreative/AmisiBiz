import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireAuth } from "@/lib/auth/helpers";
import {
  authorizePlatform,
  AuthorizationError,
} from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { AdminShell } from "@/components/layout/admin-shell";
import type { NavItem } from "@/components/layout/nav-links";
import { ErrorState } from "@amisibiz/ui/state";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { HomeIcon, BuildingIcon, ShieldIcon, UsersIcon, CalendarIcon } from "@amisibiz/ui/icons";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await requireAuth(locale);
  const t = await getTranslations("admin");
  const tNav = await getTranslations("nav");

  // Real, server-side platform authorization. No client-supplied roles.
  try {
    await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_TENANTS_READ);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <main className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-md">
            <ErrorState
              title={t("noAccessTitle")}
              description={t("noAccessDescription")}
              action={
                <Link
                  href={`/${locale}/app`}
                  className="inline-flex h-10 items-center rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {tNav("dashboard")}
                </Link>
              }
            />
          </div>
        </main>
      );
    }
    throw error;
  }

  // Determine navigation items based on the administrator's platform role and
  // permissions. This is done server-side so that browser-side DOM inspection
  // never becomes an access‑control mechanism.
  const userPermissions = await _getUserPermissions(session.user.id);

  const items: NavItem[] = [
    {
      href: `/${locale}/admin`,
      label: t("nav.overview"),
      icon: <HomeIcon />,
      exact: true,
      // Overview is always available to authenticated platform admins
    },
    // Tenants are always visible; the page itself is gated by authorizePlatform()
    // on the server, so hiding the link here is UI-only (defense-in-depth),
    // not a security boundary.
    {
      href: `/${locale}/admin/tenants`,
      label: t("nav.tenants"),
      icon: <BuildingIcon />,
    },
  ];

  // SUPER_ADMIN gets full platform navigation; SUPPORT gets read‑only subset
  if (userPermissions.includes("SUPER_ADMIN")) {
    // SUPER_ADMIN already has the base items above; no additional items needed
    // as they can access all admin surfaces.
  } else if (
    userPermissions.includes("SUPPORT") ||
    !userPermissions.includes("SUPER_ADMIN")
  ) {
    // Restrict: only show what the support role or default role can access.
    // We keep overview and tenants as minimum.
  }

  const footer = (
    <div className="space-y-3">
      <p className="truncate text-sm text-slate-200">
        {session.user.name ?? session.user.email}
      </p>
      <SignOutButton label={tNav("signOut")} />
    </div>
  );

  return (
    <AdminShell basePath={`/${locale}/admin`} items={items} footer={footer}>
      {children}
    </AdminShell>
  );
}

async function _getUserPermissions(userId: string): Promise<string[]> {
  // Query the database for the user's platform role and mapped permissions.
  // This mirrors the code‑based Permission / RolePermission matrix so that the
  // navigation never grants access that the server‑side authorization would
  // deny — it is purely a UI aid, and the page-level authorizePlatform() guard
  // remains the definitive access‑control check.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });

  const role = user?.platformRole;

  // Map role to permission set (kept in sync with packages/auth/src/permissions.ts)
  const rolePermissionMap: Record<string, string[]> = {
    SUPER_ADMIN: [
      "platform.dashboard.read",
      "tenants.read",
      "tenants.create",
      "tenants.activate",
      "tenants.suspend",
      "tenants.reactivate",
      "subscriptions.read",
      "subscriptions.manage",
      "branding.read",
      "branding.manage",
      "platform_users.read",
      "platform_users.manage",
      "audit_logs.read",
      "security_events.read",
      "support.access_request",
    ],
    SUPPORT: [
      "platform.dashboard.read",
      "tenants.read",
      "branding.read",
      "audit_logs.read",
      "security_events.read",
      "support.access_request",
    ],
    // Default: no platform role = read‑only minimum
    None: ["platform.dashboard.read", "tenants.read"],
  };

  const permissions: string[] = rolePermissionMap[role] ?? rolePermissionMap.None;

  // Also include any explicit role‑to‑permission overrides from the database
  // RolePermission table, to keep the UI in parity with the persisted matrix.
  if (role && role !== "None") {
    const rolePerms = await prisma.rolePermission.findMany({
      where: { roleKey: role },
      select: { permission: { select: { key: true } } },
    });
    const extra = rolePerms.map((rp) => rp.permission.key);
    return [...new Set([...permissions, ...extra])];
  }

  return permissions;
}
