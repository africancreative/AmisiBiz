import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@amisibiz/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@amisibiz/ui/card";
import { TenantStatusBadge } from "@/components/platform/tenant-status-badge";
import { TenantLifecycleActions } from "@/components/platform/tenant-lifecycle-actions";
import { TenantProfilePanel } from "@/components/platform/tenant-profile-panel";
import { TenantPlanPanel } from "@/components/platform/tenant-plan-panel";
import { TenantDomainsPanel } from "@/components/platform/tenant-domains-panel";
import { TenantNumberingPanel } from "@/components/platform/tenant-numbering-panel";
import { TenantBrandingPanel } from "@/components/platform/tenant-branding-panel";
import { TenantOwnerPanel } from "@/components/platform/tenant-owner-panel";
import { TenantIndicatorsPanel } from "@/components/platform/tenant-indicators-panel";
import { TenantStatusHistoryPanel } from "@/components/platform/tenant-status-history-panel";
import { TenantAuditPanel } from "@/components/platform/tenant-audit-panel";
import {
  getTenantAuditEvents,
  getTenantDetail,
  getTenantStatusHistory,
  listPlanOptions,
} from "@/lib/admin/tenant-queries";
import { sampleDocumentNumbers } from "@/lib/admin/document-samples";
import { formatDateTimeOr } from "@/lib/admin/format";
import { availableTransitions } from "@/server/services/tenant-lifecycle";
import { getBaseDomain } from "@/lib/tenancy/host";
import { AuthorizationError } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

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

  const plans = await listPlanOptions();

  // The audit trail is a separate authority from workspace administration: an
  // operator who can administer workspaces but not read audits sees a stated
  // refusal, never an empty list that looks like "nothing happened".
  let auditEntries: Awaited<ReturnType<typeof getTenantAuditEvents>> = [];
  let auditUnavailable = false;
  try {
    auditEntries = await getTenantAuditEvents(id);
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === "FORBIDDEN") {
      auditUnavailable = true;
    } else {
      throw error;
    }
  }

  const history = await getTenantStatusHistory(id);
  const sampleNumbers = sampleDocumentNumbers(tenant.numbering);

  const lifecycleRows: { label: string; value: string }[] = [
    {
      label: t("detail.createdAt"),
      value: formatDateTimeOr(tenant.createdAt, t("detail.never")),
    },
    {
      label: t("detail.activatedAt"),
      value: formatDateTimeOr(tenant.activatedAt, t("detail.never")),
    },
    {
      label: t("detail.suspendedAt"),
      value: formatDateTimeOr(tenant.suspendedAt, t("detail.never")),
    },
    { label: t("detail.members"), value: String(tenant.memberCount) },
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
              transitions={availableTransitions(tenant.status)}
            />
          </div>
        }
      />

      <p className="text-xs text-muted-foreground">
        {t("detail.transitionNote")}
      </p>

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
              {formatDateTimeOr(tenant.suspendedAt, t("detail.never"))}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("detail.suspensionEffect")}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("detail.lifecycle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {lifecycleRows.map((row) => (
                <div
                  key={row.label}
                  className="flex justify-between gap-4 border-b border-border/60 py-1 last:border-0"
                >
                  <dt className="text-sm text-muted-foreground">{row.label}</dt>
                  <dd className="text-sm font-medium text-foreground">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            <TenantIndicatorsPanel tenant={tenant} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("detail.ownerTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TenantOwnerPanel
              tenantId={tenant.id}
              ownerEmail={tenant.ownerEmail}
              pendingInvitationEmail={tenant.pendingOwnerInvitationEmail}
              workspaceStatus={tenant.status}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("detail.profileTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TenantProfilePanel
            tenantId={tenant.id}
            initial={{
              name: tenant.name,
              country: tenant.country ?? "",
              currency: tenant.currency,
              timezone: tenant.timezone,
              locale: tenant.locale,
            }}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("detail.planTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TenantPlanPanel
              tenantId={tenant.id}
              currentPlanId={tenant.planId}
              plans={plans}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("detail.domainsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TenantDomainsPanel
              tenantId={tenant.id}
              slug={tenant.slug}
              baseDomain={getBaseDomain()}
              domains={tenant.domains}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("detail.settingsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* The provider numbering panel edits the three original series; an
              ORDER series falls back to the documented database default until
              the console grows the fourth row. */}
          <TenantNumberingPanel
            tenantId={tenant.id}
            series={tenant.numbering
              .filter((row) => row.type !== "ORDER")
              .map((row) => ({
                ...row,
                type: row.type as "QUOTATION" | "INVOICE" | "DELIVERY_NOTE",
              }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("detail.brandingTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TenantBrandingPanel
            tenantId={tenant.id}
            initial={tenant.branding}
            workspaceName={tenant.name}
            sampleNumbers={sampleNumbers}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("detail.historyTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TenantStatusHistoryPanel entries={history} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("detail.auditTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TenantAuditPanel
              entries={auditEntries}
              unavailable={auditUnavailable}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
