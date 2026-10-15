import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { Badge, type BadgeTone } from "@amisibiz/ui/badge";
import { EmptyState } from "@amisibiz/ui/state";
import {
  UsersIcon,
  PackageIcon,
  FileTextIcon,
  PlusIcon,
  SettingsIcon,
} from "@amisibiz/ui/icons";
import { formatMoney } from "@amisibiz/documents";
import type {
  DashboardDocument,
  DashboardOverview,
} from "@/server/actions/dashboard";

/**
 * Read-only business dashboard.
 *
 * A Server Component on purpose: every figure arrives already computed and
 * tenant-scoped from `getDashboardOverviewAction`, so there is no client-side
 * fetch that could be pointed at another tenant. The component only lays the
 * data out.
 */
export interface DashboardOverviewProps {
  locale: string;
  roleLabel: string;
  readonly: boolean;
  canCreateDocument: boolean;
  tenant: {
    name: string;
    slug: string;
    status: string;
    currency: string;
    timezone: string;
    locale: string;
  };
  data: DashboardOverview;
}

/** Status → badge tone, so colour is consistent everywhere a status appears. */
function statusTone(status: string): BadgeTone {
  switch (status) {
    case "PAID":
    case "ACCEPTED":
    case "DELIVERED":
      return "success";
    case "OVERDUE":
    case "VOID":
    case "REJECTED":
    case "CANCELLED":
      return "danger";
    case "ISSUED":
      return "info";
    case "PARTIALLY_PAID":
    case "PARTIALLY_DELIVERED":
      return "warning";
    default:
      return "neutral";
  }
}

function contactLabel(doc: DashboardDocument): string | null {
  const parts = [doc.contact?.firstName, doc.contact?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return doc.contact?.companyName || parts || null;
}

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-5">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          {icon}
        </span>
      </CardContent>
    </Card>
  );
}

export async function DashboardOverview({
  locale,
  roleLabel,
  readonly,
  canCreateDocument,
  tenant,
  data,
}: DashboardOverviewProps) {
  const t = await getTranslations("dashboard");
  const tEnums = await getTranslations("documentEnums");

  const money = (amount: string, currency: string) =>
    formatMoney(amount, currency || data.currency || tenant.currency);

  const formatDate = (value: Date | string | null | undefined) =>
    value ? new Date(value).toLocaleDateString(locale) : "—";

  const quickLinks = [
    {
      href: `/${locale}/app/contacts`,
      label: t("quick.contacts"),
      hint: t("quick.contactsHint"),
      icon: <UsersIcon />,
    },
    {
      href: `/${locale}/app/items`,
      label: t("quick.items"),
      hint: t("quick.itemsHint"),
      icon: <PackageIcon />,
    },
    {
      href: `/${locale}/app/documents`,
      label: t("quick.documents"),
      hint: canCreateDocument
        ? t("quick.documentsHint")
        : t("quick.documentsSoon"),
      icon: <FileTextIcon />,
    },
    {
      href: `/${locale}/app/settings/branding`,
      label: t("quick.branding"),
      hint: t("quick.brandingHint"),
      icon: <SettingsIcon />,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("stats.contacts")}
          value={data.contacts.total}
          hint={t("stats.contactsHint", { active: data.contacts.active })}
          icon={<UsersIcon />}
        />
        <StatCard
          label={t("stats.items")}
          value={data.items.total}
          hint={t("stats.itemsHint", { active: data.items.active })}
          icon={<PackageIcon />}
        />
        <StatCard
          label={t("stats.quotations")}
          value={data.documents.quotations.total}
          hint={t("stats.quotationsHint", {
            open: data.documents.quotations.open,
          })}
          icon={<FileTextIcon />}
        />
        <StatCard
          label={t("stats.invoices")}
          value={data.documents.invoices.total}
          hint={t("stats.invoicesHint", {
            outstanding: data.documents.invoices.outstanding,
          })}
          icon={<FileTextIcon />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("recentDocuments")}</CardTitle>
            <CardDescription>{t("recentDocumentsDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentDocuments.length === 0 ? (
              <EmptyState
                className="border-0 bg-transparent"
                icon={<FileTextIcon />}
                title={t("recentDocumentsEmpty")}
                description={t("recentDocumentsEmptyDescription")}
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.recentDocuments.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {doc.number ?? t("draft")}
                        <span className="ml-2 text-muted-foreground">
                          {tEnums(`type.${doc.type}`)}
                        </span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {contactLabel(doc) ?? t("noCustomer")} ·{" "}
                        {formatDate(doc.issueDate ?? doc.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium tabular-nums text-foreground">
                        {money(String(doc.total), doc.currency)}
                      </span>
                      <Badge tone={statusTone(doc.status)}>
                        {tEnums(`status.${doc.status}`)}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("outstandingInvoices")}</CardTitle>
            <CardDescription>
              {t("outstandingInvoicesDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-border bg-muted/40 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("outstandingTotal")}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                {money(data.outstanding.total, data.outstanding.currency)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("outstandingCount", { count: data.outstanding.count })}
                {data.overdue.count > 0
                  ? ` · ${t("overdueCount", { count: data.overdue.count })}`
                  : ""}
              </p>
            </div>
            {data.outstandingInvoices.length === 0 ? (
              <EmptyState
                className="border-0 bg-transparent p-4"
                title={t("outstandingInvoicesEmpty")}
                description={t("outstandingInvoicesEmptyDescription")}
              />
            ) : (
              <ul className="space-y-2">
                {data.outstandingInvoices.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-foreground">
                        {doc.number ?? t("draft")}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {contactLabel(doc) ?? t("noCustomer")}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-foreground">
                      {money(String(doc.total), doc.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("account")}</CardTitle>
            <CardDescription>{t("accountDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("accountFields.name")}
                </dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {tenant.name}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("accountFields.status")}
                </dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {tenant.status}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("accountFields.slug")}
                </dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {tenant.slug}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("accountFields.role")}
                </dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {roleLabel}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("accountFields.currency")}
                </dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {data.branding?.currency || tenant.currency}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("accountFields.timezone")}
                </dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {tenant.timezone}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("accountFields.branding")}
                </dt>
                <dd className="mt-1 flex items-center gap-3 text-sm text-foreground">
                  {data.branding?.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- logo is a tenant-supplied same-origin asset
                    <img
                      src={data.branding.logoUrl}
                      alt=""
                      className="h-8 w-8 rounded border border-border object-contain"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex h-8 w-8 items-center justify-center rounded border border-border bg-muted text-xs text-muted-foreground"
                    >
                      —
                    </span>
                  )}
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 rounded-full border border-border"
                      style={{
                        backgroundColor:
                          data.branding?.primaryColor ?? undefined,
                      }}
                    />
                    {data.branding?.displayName ||
                      t("accountFields.noBranding")}
                  </span>
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("quickActions")}</CardTitle>
            <CardDescription>{t("quickActionsDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {quickLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="flex items-start gap-3 rounded-md px-3 py-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-0.5 text-muted-foreground"
                    >
                      {link.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        {link.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {link.hint}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {!readonly ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <PlusIcon />
                {t("createHint")}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
