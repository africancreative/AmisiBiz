import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@amisibiz/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { Badge } from "@amisibiz/ui/badge";
import { BuildingIcon } from "@amisibiz/ui/icons";
import { TenantStatusBadge } from "@/components/platform/tenant-status-badge";
import {
  getOperationalWarnings,
  getPlanDistribution,
  getRecentAdminActivity,
  getRecentTenantChanges,
  getTenantOverviewCounts,
} from "@/lib/admin/tenant-queries";

export const dynamic = "force-dynamic";

/**
 * Audit action → `admin.detail.audit.actions.*` key.
 *
 * The overview reuses the labels the workspace audit panel already defines, so a
 * lifecycle event reads the same wherever an operator meets it. An action not in
 * this map falls back to its raw name rather than being silently dropped.
 */
const ACTIVITY_LABEL_KEYS: Record<string, string> = {
  "tenant.created": "tenantCreated",
  "platform.tenantUpdated": "tenantUpdated",
  "platform.tenantActivated": "tenantActivated",
  "platform.tenantSuspended": "tenantSuspended",
  "platform.tenantReactivated": "tenantReactivated",
  "platform.tenantPlanAssigned": "tenantPlanAssigned",
  "platform.tenantDomainUpdated": "tenantDomainUpdated",
  "platform.tenantBrandingUpdated": "tenantBrandingUpdated",
  "platform.tenantNumberingUpdated": "tenantNumberingUpdated",
  "platform.tenantOwnerInvited": "tenantOwnerInvited",
  "platform.tenantOwnerAssigned": "tenantOwnerAssigned",
  "platform.tenantOwnerInvitationRevoked": "tenantOwnerInvitationRevoked",
};

export default async function AdminOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  const [counts, recent, plans, activity, warnings] = await Promise.all([
    getTenantOverviewCounts(),
    getRecentTenantChanges(5),
    getPlanDistribution(),
    getRecentAdminActivity(8),
    getOperationalWarnings(),
  ]);

  const awaitingOwner =
    warnings.find((warning) => warning.key === "awaitingOwner")?.count ?? 0;

  const stats = [
    { key: "total", value: counts.total },
    { key: "pending", value: counts.PENDING },
    { key: "active", value: counts.ACTIVE },
    { key: "suspended", value: counts.SUSPENDED },
    { key: "awaitingOwner", value: awaitingOwner },
  ] as const;

  const warningsWithCount = warnings.filter(
    (warning) => warning.count > 0,
  ) as Array<{ key: string; count: number }>;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("overviewTitle")}
        description={t("description")}
        actions={<Badge tone="gold">{t("badge")}</Badge>}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("overview.planDistributionTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("overview.planDistributionEmpty")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {plans.map((row) => (
                  <li
                    key={row.planId ?? "none"}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="truncate text-foreground">
                      {row.name ?? t("overview.noPlan")}
                    </span>
                    <span className="font-medium tabular-nums text-muted-foreground">
                      {row.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("overview.warningsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {warningsWithCount.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("overview.warningsNone")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {warningsWithCount.map((warning) => (
                  <li
                    key={warning.key}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="text-foreground">
                      {t(`overview.warning.${warning.key}`)}
                    </span>
                    <span className="font-medium tabular-nums text-muted-foreground">
                      {warning.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              {t("overview.unmeasuredNote")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("overview.recentActivityTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("overview.recentActivityEmpty")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {activity.map((entry) => {
                const labelKey = ACTIVITY_LABEL_KEYS[entry.action];
                const label = labelKey
                  ? t(`detail.audit.actions.${labelKey}`)
                  : entry.action;
                return (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
                  >
                    <span className="truncate text-foreground">
                      {label}
                      {" — "}
                      {entry.tenantId ? (
                        <Link
                          href={`/${locale}/admin/tenants/${entry.tenantId}`}
                          className="font-medium hover:text-primary"
                        >
                          {entry.tenantName ??
                            entry.tenantSlug ??
                            entry.tenantId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">
                          {t("overview.systemActor")}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.actorLabel
                        ? t("overview.activityBy", { actor: entry.actorLabel })
                        : t("overview.systemActor")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
