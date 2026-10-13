import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TenantStatusBadge } from "@/components/platform/tenant-status-badge";
import { TenantLifecycleActions } from "@/components/platform/tenant-lifecycle-actions";
import { getTenantDetail } from "@/lib/admin/tenant-queries";

export const dynamic = "force-dynamic";

function formatDate(value: Date | null, fallback: string): string {
  return value ? value.toISOString().slice(0, 16).replace("T", " ") : fallback;
}

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const t = await getTranslations("admin");
  const tenant = await getTenantDetail(id);

  if (!tenant) {
    notFound();
  }

  const rows: { label: string; value: string }[] = [
    { label: t("detail.slugLabel"), value: tenant.slug },
    {
      label: t("detail.hostname"),
      value:
        tenant.hostnames.length > 0
          ? tenant.hostnames.join(", ")
          : t("noHostname"),
    },
    {
      label: t("detail.createdAt"),
      value: formatDate(tenant.createdAt, t("detail.never")),
    },
    {
      label: t("detail.activatedAt"),
      value: formatDate(tenant.activatedAt, t("detail.never")),
    },
    {
      label: t("detail.suspendedAt"),
      value: formatDate(tenant.suspendedAt, t("detail.never")),
    },
    { label: t("detail.plan"), value: tenant.planId ?? t("detail.never") },
    { label: t("detail.members"), value: String(tenant.memberCount) },
    { label: t("detail.country"), value: tenant.country ?? t("detail.never") },
    { label: t("detail.currency"), value: tenant.currency },
    { label: t("detail.timezone"), value: tenant.timezone },
    { label: t("detail.locale"), value: tenant.locale },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tenant.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <TenantStatusBadge status={tenant.status} />
            <span className="text-sm text-muted-foreground">{tenant.slug}</span>
          </span>
        }
        actions={
          <div className="flex items-center gap-3">
            <Link
              href={`/${locale}/admin/tenants`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t("detail.backToList")}
            </Link>
            <TenantLifecycleActions
              tenantId={tenant.id}
              status={tenant.status}
            />
          </div>
        }
      />

      {tenant.status === "SUSPENDED" ? (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">
              {t("detail.suspensionReason")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="text-foreground">
              {tenant.suspensionReason ?? t("detail.never")}
            </p>
            <p className="text-muted-foreground">
              {t("detail.suspendedAt")}:{" "}
              {formatDate(tenant.suspendedAt, t("detail.never"))}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("detail.lifecycle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex justify-between gap-4 border-b border-border/60 py-1.5"
              >
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
                <dd className="text-sm font-medium text-foreground">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("detail.settingsTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {tenant.settings ? (
              <>
                <p>
                  {t("detail.documentPrefix")}:{" "}
                  <span className="font-medium">
                    {tenant.settings.documentPrefix}
                  </span>
                </p>
                <p>
                  {t("detail.quotationPrefix")}:{" "}
                  <span className="font-medium">
                    {tenant.settings.quotationPrefix}
                  </span>
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">{t("detail.never")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("detail.brandingTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {tenant.branding ? (
              <div className="flex items-center gap-3">
                <span
                  className="inline-block h-6 w-6 rounded border border-border"
                  style={{ backgroundColor: tenant.branding.primaryColor }}
                  aria-hidden="true"
                />
                <span
                  className="inline-block h-6 w-6 rounded border border-border"
                  style={{ backgroundColor: tenant.branding.accentColor }}
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">
                  {tenant.branding.displayName ?? tenant.name}
                </span>
              </div>
            ) : (
              <p className="text-muted-foreground">{t("detail.never")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
