import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";
import { Badge } from "@amisibiz/ui/badge";
import { TableContainer, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@amisibiz/ui/table";
import { EmptyState } from "@amisibiz/ui/state";
import { Loader2Icon, AlertCircleIcon, CheckCircleIcon } from "@amisibiz/ui/icons";
import { useEffect, useState } from "react";
import { prisma } from "@amisibiz/database";
import { getTenantDetail } from "@/lib/admin/tenant-queries";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { activateTenant, suspendTenant, reactivateTenant } from "@/server/actions/tenant/lifecycle";
import { TenantStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function AdminBusinessDetailPage({
  params,
}: {
  params: Promise<{ locale: string; tenantId: string }>;
}) {
  const { locale, tenantId } = await params;
  const t = await getTranslations("admin");

  // Authorization check
  const session = await _requirePlatformAuth();
  await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_TENANTS_READ);

  const [tenant, statusHistory, adminEvents] = await Promise.all([
    getTenantDetail(tenantId),
    getTenantStatusHistory(tenantId, 20),
    getRecentAdminActivity(5),
  ]);

  if (!tenant) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">
          <ErrorState
            title={t("tenantNotFound")}
            description={t("tenantNotFoundDescription")}
            action={
              <Link
                href={`/${locale}/admin/tenants`}
                className="inline-flex h-10 items-center rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("nav.tenants")}
              </Link>
            }
          />
        </div>
      </main>
    );
  }

  // --- Status badges helper ---
  function statusBadge(status: TenantStatus) {
    const labels: Record<TenantStatus, { title: string; bg: string; fg: string }> = {
      ACTIVE: {
        title: t("status.active"),
        bg: "green",
        fg: "green-fg",
      },
      SUSPENDED: {
        title: t("status.suspended"),
        bg: "red",
        fg: "red-fg",
      },
      PENDING: {
        title: t("status.pending"),
        bg: "yellow",
        fg: "yellow-fg",
      },
    };
    const { title, bg, fg } = labels[status];
    return (
      <Badge tone={bg === "green" ? "green" : bg === "red" ? "red" : "yellow"}>
        {title}
      </Badge>
    );
  }

  // --- Lifecycle state machine validation ---
  function isValidTransition(from: TenantStatus | null, to: TenantStatus): boolean {
    const valid: Record<TenantStatus, TenantStatus[]> = {
      ACTIVE: ["ACTIVE", "SUSPENDED"],
      SUSPENDED: ["SUSPENDED", "ACTIVE"],
      PENDING: ["PENDING", "ACTIVE"],
    };
    return valid[from]?.includes(to) ?? false;
  }

  // --- State for action buttons ---
  const [actionStatus, setActionStatus] = useState<{
    type: "activate" | "suspend" | "reactivate" | null;
    loading: boolean;
    error: string | null;
  }>({ type: null, loading: false, error: null });

  // --- Activate Handler (PENDING -> ACTIVE) ---
  const handleActivate = async () => {
    if (tenant.status !== "PENDING") return;

    setActionStatus({ type: "activate", loading: true, error: null });

    const result = await activateTenant(tenant.id, "Initial onboarding");

    setActionStatus({
      type: "activate",
      loading: false,
      error: result.error || null,
    });

    if (result.success) {
      // Refresh tenant data to reflect the new status
      window.location.reload();
    }
  };

  // --- Suspend Handler (ACTIVE -> SUSPENDED) ---
  const handleSuspend = async (reason: string) => {
    if (tenant.status !== "ACTIVE") return;

    setActionStatus({ type: "suspend", loading: true, error: null });

    const result = await suspendTenant(tenant.id, reason);

    setActionStatus({
      type: "suspend",
      loading: false,
      error: result.error || null,
    });

    if (result.success) {
      window.location.reload();
    }
  };

  // --- Reactivate Handler (SUSPENDED -> ACTIVE) ---
  const handleReactivate = async () => {
    if (tenant.status !== "SUSPENDED") return;

    setActionStatus({ type: "reactivate", loading: true, error: null });

    const result = await reactivateTenant(tenant.id, "Reactivating suspended business");

    setActionStatus({
      type: "reactivate",
      loading: false,
      error: result.error || null,
    });

    if (result.success) {
      window.location.reload();
    }
  };

  return (
    <div className="space-y-6">
      {/* Tenant Header */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t("tenant.profile")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">{t("businessName")}</p>
                <p className="font-medium text-foreground">{tenant.name}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("tenant.identifier")}</p>
                <p className="font-medium text-foreground">{tenant.slug}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("tenant.plan")}</p>
                <p className="font-medium text-foreground">
                  {tenant.plan?.name ?? t("detail.noPlan")}
                </p>
              </div>
            </div>

            {/* Status */}
            <div className="mt-4">
              <p className="text-sm text-muted-foreground">{t("status")}</p>
              <div className="mt-2">
                {statusBadge(tenant.status)}
              </div>
            </div>

            {/* Activation date */}
            {tenant.activatedAt && (
              <div>
                <p className="text-sm text-muted-foreground">{t("activated")}</p>
                <p className="font-medium">{tenant.activatedAt.toISOString().split("T")[0]}</p>
              </div>
            )}

            {/* Suspension date */}
            {tenant.suspendedAt && (
              <div>
                <p className="text-sm text-muted-foreground">{t("suspended")}</p>
                <p className="font-medium text-red-600">
                  {tenant.suspendedAt.toISOString().split("T")[0]}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Contact & Domain */}
        <Card>
          <CardHeader>
            <CardTitle>{t("contactInformation")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">{t("primaryContact")}</p>
                <p className="font-medium text-foreground">
                  {tenant.members?.[0]?.user?.email ?? t("noContact")}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("businessEmail")}</p>
                <p className="font-medium text-foreground">
                  {tenant.contactEmail ?? t("noEmail")}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <p className="text-sm text-muted-foreground">{t("assignedSubdomain")}</p>
              <p className="font-medium text-foreground">
                {tenant.primaryHostname ?? t("noHostname")}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Lifecycle */}
        <Card>
          <CardHeader>
            <CardTitle>{t("lifecycleHistory")}</CardTitle>
          </CardHeader>
          <CardContent>
            {statusHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noLifecycleEvents")}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.event")}</TableHead>
                    <TableHead>{t("table.changedAt")}</TableHead>
                    <TableHead>{t("table.changedBy")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statusHistory.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        {entry.fromStatus
                          ? `${t(`status.${entry.fromStatus}`)} → ${t(`status.${entry.toStatus}`)}`
                          : t(`status.${entry.toStatus}`)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entry.createdAt.toISOString().split("T")[0]}
                      </TableCell>
                      <TableCell>
                        {entry.changedBy?.email ?? t("systemAgent")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Authorized Actions */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Activation/Reactivate Button */}
        {[tenant.status === "PENDING" || tenant.status === "SUSPENDED"].map(
          (status) => (
            <Card key={status}>
              <CardHeader>
                <CardTitle>{status === "PENDING" ? t("activateTenant") : t("reactivateTenant")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {status === "PENDING"
                    ? t("pendingActivationSubtext")
                    : t("reactivateSubtext")}
                </p>

                {/* Activation form for PENDING */}
                {status === "PENDING" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleActivate();
                    }}
                    className="gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        defaultValue="Initial onboarding"
                        className="input flex-1 text-xs"
                        disabled
                      />
                      <button type="submit" className="btn btn-primary px-2 py-1 text-xs">
                        {t("activate")}
                      </button>
                    </div>
                  </form>
                )}

                {/* Reactivate form for SUSPENDED */}
                {status === "SUSPENDED" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const reason = window.prompt(t("suspensionReasonPrompt")) || "Reactivating suspended business";
                      if (reason) handleReactivate();
                    }}
                    className="gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        defaultValue="Reactivating suspended business"
                        className="input flex-1 text-xs"
                        disabled
                      />
                      <button type="submit" className="btn btn-primary px-2 py-1 text-xs">
                        {t("reactivate")}
                      </button>
                    </div>
                  </form>
                )}

                {/* Status indicator */}
                <small className="text-xs text-muted-foreground mt-2">
                  {status === "PENDING"
                    ? t("activationRequiresReason")
                    : t("reactivationPreservesData")}
                </small>
              </CardContent>
            </Card>
          )
        )}

        {/* Suspension Button (only for ACTIVE) */}
        {tenant.status === "ACTIVE" && (
          <Card>
            <CardHeader>
              <CardTitle>{t("suspendTenant")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t("suspendSubtext")}
              </p>

              {/* Suspension form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const reason = window.prompt(t("suspensionReasonPrompt")) || "";
                  if (reason) handleSuspend(reason);
                }}
                className="gap-2"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g. Overdue payment, compliance issue"
                    className="input flex-1 text-xs"
                    required
                  />
                  <button type="submit" className="btn btn-danger px-2 py-1 text-xs">
                    {t("suspend")}
                  </button>
                </div>
              </form>

              <small className="text-xs text-muted-foreground mt-2">
                {t("suspensionRequiresReason")}
              </small>
            </CardContent>
          </Card>
        )}

        {/* Plan Change */}
        {tenant.plan && (
          <Card>
            <CardHeader>
              <CardTitle>{t("changePlan")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t("changePlanSubtext", { plan: tenant.plan.name })}
              </p>
              <button className="btn btn-secondary mt-2 w-full" disabled>
                {t("changePlanAction")}
              </button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Recent Administrator Activity */}
      <Card>
        <CardHeader>
          <CardTitle>{t("recentAdminActivity")}</CardTitle>
        </CardHeader>
        <CardContent>
          {adminEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noRecentActivity")}</p>
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
                {adminEvents.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      {entry.action.replace(".", " ")}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.tenantName || t("general")}
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
    </div>
  );
}

/** Platform auth guard for detail page */
async function _requirePlatformAuth() {
  const { import: requireAuth } = await import("@/lib/auth/helpers");
  return requireAuth();
}