import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { AccessDenied } from "@/components/layout/access-denied";
import { PageHeader } from "@amisibiz/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { StatusIndicator } from "@amisibiz/ui/status-indicator";
import { EmptyState } from "@amisibiz/ui/state";
import {
  UsersIcon,
  PackageIcon,
  FileTextIcon,
  SettingsIcon,
} from "@amisibiz/ui/icons";

export const dynamic = "force-dynamic";

export default async function WorkspaceOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const { session, membership } = state;
  const t = await getTranslations("workspace");
  const tDash = await getTranslations("dashboard");
  const tTeam = await getTranslations("team");

  const { tenant, role } = membership;

  const quickLinks = [
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
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tDash("welcome", {
          name: session.user.name ?? session.user.email ?? "",
        })}
        description={`${tenant.name} · ${tTeam(`roles.${role}`)}`}
        actions={
          <StatusIndicator
            tone={tenant.status === "ACTIVE" ? "success" : "warning"}
          >
            {tenant.status}
          </StatusIndicator>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("nav.overview")}</CardTitle>
            <CardDescription>{tenant.name}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              {[
                ["Slug", tenant.slug],
                ["Currency", tenant.currency],
                ["Timezone", tenant.timezone],
                ["Locale", tenant.locale],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="mt-0.5 text-sm font-medium text-foreground">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tDash("quickActions")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {quickLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span aria-hidden="true">{link.icon}</span>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{tDash("recentActivity")}</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            className="border-0 bg-transparent"
            title={tDash("recentActivity")}
          />
        </CardContent>
      </Card>
    </div>
  );
}
