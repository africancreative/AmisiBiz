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
import { HomeIcon, BuildingIcon } from "@amisibiz/ui/icons";

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

  const items: NavItem[] = [
    {
      href: `/${locale}/admin`,
      label: t("nav.overview"),
      icon: <HomeIcon />,
      exact: true,
    },
    {
      href: `/${locale}/admin/tenants`,
      label: t("nav.tenants"),
      icon: <BuildingIcon />,
    },
  ];

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
