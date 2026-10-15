import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@amisibiz/ui/card";
import { Badge } from "@amisibiz/ui/badge";
import { TableContainer, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@amisibiz/ui/table";
import { EmptyState } from "@amisibiz/ui/state";
import { HomeIcon, BuildingIcon, ShieldIcon, UserIcon, CalendarIcon } from "@amisibiz/ui/icons";
import { AlertCircleIcon } from "@amisibiz/ui/icons";
import { useEffect, useState } from "react";
import { getRecentRegistrations, getTenantOverviewCounts, getRecentAdminActivity, getRecentSecurityEvents } from "@/lib/admin/overview-queries";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  const [counts, recentRegistrations, adminActivity, securityEvents] = await Promise.all([
    getTenantOverviewCounts(),
    getRecentRegistrations(5),
    getRecentAdminActivity(5),
    getRecentSecurityEvents(5),
  ]);

  // --- Summary Cards ---
  const summaryCards = [
    {
      key: "total",
      title: t("counts.total"),
      value: counts.total,
      description: t("counts.businesses"),
      icon: BuildingIcon,
    },
    {
      key: "active",
      title: t("counts.active"),
      value: counts.ACTIVE,
      description: t("counts.activeBusinesses"),
      icon: HomeIcon,
      status: "active",
    },
    {
      key: "suspended",
      title: t("counts.suspended"),
      value: counts.SUSPENDED,
      description: t("counts.suspendedBusinesses"),
      icon: ShieldIcon,
      status: "suspended",
    },
    {
      key: "pending",
      title: t("counts.pending"),
      value: counts.PENDING,
      description: t("counts.pendingActivation"),
      icon: CalendarIcon,
      status: "pending",
    },
    {
      key: "trial",
      title: t("counts.trial"),
      value: counts.trial,
      description: t("counts.trialBusinesses"),
      icon: UserIcon,
      status: "trial",
    },
  ];

  // --- Recent Registrations Table ---
  const recentRegistrationsHeader = [
    t("table.name"),
    t("table.slug"),
    t("table.registered"),
    t("table.status"),
  ];

  // --- Recent Administrator Activity Table ---
  const adminActivityHeader = [
    t("table.action"),
    t("table.resource"),
    t("table.changedAt"),
    t("table.changedBy"),
  ];

  // --- Recent Security Events Table ---
  const securityEventsHeader = [
    t("table.action"),
    t("table.resource"),
    t("table occurredAt"),
    t("table.actor"),
  ];

  // --- State ---
  const [error, setError] = useState<Error | null>(null);
  const [loading] = useState(() => {
    // Initial data is already loaded via Promise.all above
    return false;
  });

  // --- Error Handling ---
  useEffect(() => {
    if (error) {
      // Show toast via the global error handler; the layout's ErrorState
      // will catch render-time errors, but we also surface API errors here.
      // In a full implementation, this would trigger a toast component.
      console.error("Admin dashboard error:", error);
    }
  }, [error]);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">{t("overviewTitle")}</h1>
        <p className="text-muted-foreground">{t("overviewDescription")}</p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {summaryCards.map((card) => (
          <Card key={card.key} className="h-full">
            <CardHeader className="pb-2">
              <CardDescription>{card.title}</CardDescription>
              <CardTitle className="text-3xl">{card.value}</CardTitle>
            </CardHeader>
            {card.description && (
              <CardContent className="pt-2 text-sm text-muted-foreground">
                {card.description}
              </CardContent>
            )}
            {card.status && (
              <div className="pt-2 flex items-center gap-2 text-xs font-medium">
                <span className={`rounded bg-${card.status === "active" ? "green-100" : card.status === "suspended" ? "red-100" : card.status === "pending" ? "yellow-100" : "blue-100"}-/200 text-${card.status === "active" ? "green-600" : card.status === "suspended" ? "red-600" : card.status === "pending" ? "yellow-600" : "blue-600"}-300`}
                 >{t(`status.${card.status}`)}</span>
              </div>
            )}
            {card.icon && (
              <div className="pt-2 text-primary/60">
                {card.icon}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* Recent Registrations */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t("recentRegistrations")}</CardTitle>
          </CardHeader>
          <CardContent>
            {recentRegistrations.length === 0 ? (
              <EmptyState
                title={t("noRecentRegistrations")}
                description={t("recentRegistrationsSubtext")}
                icon={<AlertCircleIcon className="h-5 w-5 mx-2" />}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.name")}</TableHead>
                    <TableHead>{t("table.slug")}</TableHead>
                    <TableHead>{t("table.registered")}</TableHead>
                    <TableHead>{t("table.status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRegistrations.map((reg) => (
                    <TableRow key={reg.id}>
                      <TableCell className="font-medium text-foreground">
                        {reg.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{reg.slug}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {reg.createdAt.toISOString().split("T")[0]}
                      </TableCell>
                      <TableCell>
                        <span className={reg.status === "ACTIVE" ? "text-green-600" : reg.status === "SUSPENDED" ? "text-red-600" : "text-blue-600"}>
                          {t(`status.${reg.status}`)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Administrator Activity */}
        <Card>
          <CardHeader>
            <CardTitle>{t("recentAdminActivity")}</CardTitle>
          </CardHeader>
          <CardContent>
            {adminActivity.length === 0 ? (
              <EmptyState
                title={t("noRecentActivity")}
                description={t("recentActivitySubtext")}
                icon={<AlertCircleIcon className="h-5 w-5 mx-2" />}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.action")}</TableHead>
                    <TableHead>{t("table.resource")}</TableHead>
                    <TableHead>{t("table.changedAt")}</TableHead>
                    <TableHead>{t("table.changedBy")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {adminActivity.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        {entry.action.replace(".", " ")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entry.tenantName ? `Tenant: ${entry.tenantName}` : t("system")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entry.changedAt.toISOString().split("T")[0]}
                      </TableCell>
                      <TableCell>
                        {entry.changedBy ? entry.changedBy : t("systemAgent")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Security Events */}
        <Card>
          <CardHeader>
            <CardTitle>{t("recentSecurityEvents")}</CardTitle>
          </CardHeader>
          <CardContent>
            {securityEvents.length === 0 ? (
              <EmptyState
                title={t("noSecurityEvents")}
                description={t("securityEventsSubtext")}
                icon={<AlertCircleIcon className="h-5 w-5 mx-2" />}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.action")}</TableHead>
                    <TableHead>{t("table.resource")}</TableHead>
                    <TableHead>{t("table occurredAt")}</TableHead>
                    <TableHead>{t("table.actor")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {securityEvents.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        {event.action.replace(/_/g, " ")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {event.resource || t("general")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {event.createdAt.toISOString().split("T")[0]}
                      </TableCell>
                      <TableCell>
                        {event.actorLabel || t("systemAgent")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}