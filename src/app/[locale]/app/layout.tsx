import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { AccessDenied } from "@/components/layout/access-denied";
import type { NavItem } from "@/components/layout/nav-links";
import { ErrorState } from "@/components/ui/state";
import { SignOutButton } from "@/components/auth/sign-out-button";
import {
  HomeIcon,
  UsersIcon,
  PackageIcon,
  FileTextIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { getInitials } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale);
  const t = await getTranslations("workspace");
  const tNav = await getTranslations("nav");

  const brandNode = (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-700 text-xs font-semibold text-white"
      >
        {getInitials(
          (state.status === "ok" ? state.membership.tenant.name : null) ??
            t("brandFallback"),
        )}
      </span>
      <span className="truncate text-sm font-semibold text-foreground">
        {state.status === "ok"
          ? state.membership.tenant.name
          : t("brandFallback")}
      </span>
    </span>
  );

  const items: NavItem[] = [
    {
      href: `/${locale}/app`,
      label: t("nav.overview"),
      icon: <HomeIcon />,
      exact: true,
    },
    {
      href: `/${locale}/app/contacts`,
      label: t("nav.contacts"),
      icon: <UsersIcon />,
    },
    {
      href: `/${locale}/app/items`,
      label: t("nav.items"),
      icon: <PackageIcon />,
    },
    {
      href: `/${locale}/app/documents`,
      label: t("nav.documents"),
      icon: <FileTextIcon />,
    },
    {
      href: `/${locale}/app/settings/branding`,
      label: t("nav.branding"),
      icon: <SettingsIcon />,
    },
    { href: `/${locale}/team`, label: t("nav.team"), icon: <UsersIcon /> },
    {
      href: `/${locale}/dashboard`,
      label: t("nav.dashboard"),
      icon: <HomeIcon />,
    },
  ];

  const footer =
    state.status === "ok" ? (
      <div className="space-y-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {state.session.user.name ?? state.session.user.email}
          </p>
          {state.session.user.email ? (
            <p className="truncate text-xs text-muted-foreground">
              {state.session.user.email}
            </p>
          ) : null}
        </div>
        <SignOutButton label={tNav("signOut")} />
      </div>
    ) : null;

  let content: React.ReactNode = children;
  let headerRight: React.ReactNode = null;

  if (state.status === "no_workspace") {
    content = (
      <ErrorState
        title={t("noWorkspaceTitle")}
        description={t("noWorkspaceDescription")}
      />
    );
  } else if (state.status === "blocked") {
    content = (
      <AccessDenied
        title={t("suspendedTitle")}
        description={t("suspendedDescription")}
      />
    );
  } else {
    headerRight = (
      <span className="hidden text-sm text-muted-foreground sm:block">
        {state.membership.tenant.name}
      </span>
    );
  }

  return (
    <WorkspaceShell
      brand={brandNode}
      items={items}
      footer={footer}
      headerRight={headerRight}
    >
      {content}
    </WorkspaceShell>
  );
}
