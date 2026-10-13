import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BuildingIcon } from "@/components/ui/icons";
import { TenantStatusBadge } from "@/components/platform/tenant-status-badge";
import {
  getRecentTenantChanges,
  getTenantOverviewCounts,
} from "@/lib/admin/tenant-queries";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  const [counts, recent] = await Promise.all([
    getTenantOverviewCounts(),
    getRecentTenantChanges(5),
  ]);

  const stats = [
    { key: "total", value: counts.total },
    { key: "pending", value: counts.PENDING },
    { key: "active", value: counts.ACTIVE },
    { key: "suspended", value: counts.SUSPENDED },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("overviewTitle")}
        description={t("description")}
        actions={<Badge tone="gold">{t("badge")}</Badge>}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.key}>
            <CardHeader>
              <CardDescription>{t(`counts.${stat.key}`)}</CardDescription>
              <CardTitle className="text-3xl">{stat.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Link
          href={`/${locale}/admin/tenants`}
          className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Card className="h-full transition-colors hover:border-primary/40">
            <CardHeader>
              <div className="flex items-center gap-2 text-primary">
                <BuildingIcon />
                <CardTitle>{t("tenantsTitle")}</CardTitle>
              </div>
              <CardDescription>{t("tenantsDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <span className="text-sm font-medium text-primary">
                {t("nav.tenants")} →
              </span>
            </CardContent>
          </Card>
        </Link>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("recentChanges")}</CardTitle>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noRecent")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {recent.map((tenant) => (
                  <li
                    key={tenant.id}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <Link
                      href={`/${locale}/admin/tenants/${tenant.id}`}
                      className="truncate text-sm font-medium text-foreground hover:text-primary"
                    >
                      {tenant.name}
                    </Link>
                    <TenantStatusBadge status={tenant.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
