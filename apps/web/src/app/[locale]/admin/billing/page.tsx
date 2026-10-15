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
import { getSessionUser } from "@/lib/auth/session-user";
import { authorizePlatform } from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { changePlan, setTrial, pauseSubscription, resumeSubscription, cancelSubscription } from "@/server/actions/billing/subscription-lifecycle";
import { TenantStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function AdminBillingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  // Authorization check
  const session = await _requirePlatformAuth();
  await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_TENANTS_READ);

  // Fetch all tenants with their subscription data
  const tenants = await prisma.tenant.findMany({
    include: {
      subscription: {
        include: {
          plan: true,
        },
      },
      members: {
        where: { role: "TENANT_OWNER" },
        select: { user: { select: { email: true } } },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // State for action forms
  const [actionStatus, setActionStatus] = useState<{
    type: "change-plan" | "set-trial" | "pause" | "resume" | "cancel" | null;
    loading: boolean;
    error: string | null;
    data?: {
      tenantId: string;
      newPlanId?: string;
      trialDays?: number;
      reason?: string;
    };
  }>({ type: null, loading: false, error: null });

  // --- Change Plan Form ---
  const handleChangePlan = async () => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "change-plan", loading: true, error: null, data: undefined });

    const result = await changePlan(
      actionStatus.data.tenantId,
      actionStatus.data.newPlanId ?? "",
      actionStatus.data.reason ?? "Plan change by administrator"
    );

    setActionStatus({
      type: "change-plan",
      loading: false,
      error: result.error || null,
      data: undefined,
    });

    if (result.success) {
      window.location.reload();
    }
  };

  // --- Set Trial Form ---
  const handleSetTrial = async () => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "set-trial", loading: true, error: null, data: undefined });

    const result = await setTrial(
      actionStatus.data.tenantId,
      actionStatus.data.trialDays ?? 30,
      actionStatus.data.reason ?? "Trial period initiation"
    );

    setActionStatus({
      type: "set-trial",
      loading: false,
      error: result.error || null,
      data: undefined,
    });

    if (result.success) {
      // Show trial end date in toast
      window.location.reload();
    }
  };

  // --- Pause Subscription Form ---
  const handlePauseSubscription = async (reason: string) => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "pause", loading: true, error: null, data: undefined });

    const result = await pauseSubscription(
      actionStatus.data.tenantId,
      reason
    );

    setActionStatus({
      type: "pause",
      loading: false,
      error: result.error || null,
      data: undefined,
    });

    if (result.success) {
      window.location.reload();
    }
  };

  // --- Resume Subscription Form ---
  const handleResumeSubscription = async () => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "resume", loading: true, error: null, data: undefined });

    const result = await resumeSubscription(actionStatus.data.tenantId);

    setActionStatus({
      type: "resume",
      loading: false,
      error: result.error || null,
      data: undefined,
    });

    if (result.success) {
      window.location.reload();
    }
  };

  // --- Cancel Subscription Form ---
  const handleCancelSubscription = async (cancelAtPeriodEnd: boolean, reason: string) => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "cancel", loading: true, error: null, data: undefined });

    const result = await cancelSubscription(
      actionStatus.data.tenantId,
      cancelAtPeriodEnd,
      reason
    );

    setActionStatus({
      type: "cancel",
      loading: false,
      error: result.error || null,
      data: undefined,
    });

    if (result.success) {
      window.location.reload();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t("billingTitle")}</h1>
        <p className="text-muted-foreground">{t("billingDescription")}</p>
      </div>

      {/* Subscribed Tenants Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t("subscribedTenants")}</CardTitle>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <EmptyState
              title={t("noSubscribedTenants")}
              description={t("noSubscribedTenantsDescription")}
              icon={<AlertCircleIcon className="h-5 w-5 mx-2" />}
            />
          ) : (
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.name")}</TableHead>
                    <TableHead>{t("table.identifier")}</TableHead>
                    <TableHead>{t("table.plan")}</TableHead>
                    <TableHead>{t("table.status")}</TableHead>
                    <TableHead>{t("table.trial")}</TableHead>
                    <TableHead>{t("table.period")}</TableHead>
                    <TableHead className="text-right">{t("table.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenants.map((tenant) => {
                    const sub = tenant.subscription;
                    const plan = sub?.plan ? { id: sub.plan.id, code: sub.plan.code, name: sub.plan.name } : null;
                    const status = sub?.status as SubscriptionStatus | null;
                    const isTrial = status === "TRIAL";
                    const trialEnd = sub?.trial_end?.toISOString().split("T")[0];
                    const periodStart = sub?.current_period_start?.toISOString().split("T")[0];
                    const periodEnd = sub?.current_period_end?.toISOString().split("T")[0];

                    // Determine action availability based on status
                    const canChangePlan = status === "ACTIVE" || status === "TRIAL";
                    const canPause = status === "ACTIVE";
                    const canResume = status === "PAUSED";
                    const canCancel = status === "ACTIVE" || status === "PAUSED";
                    const canSetTrial = status === "ACTIVE" && !isTrial;

                    return (
                      <TableRow key={tenant.id}>
                        <TableCell className="font-medium text-foreground">
                          {tenant.name}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {t("counts.membersShort", { count: tenant.memberCount })}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {tenant.slug}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {plan?.name ?? t("detail.noPlan")}
                        </TableCell>
                        <TableCell>
                          <Badge
                            tone={
                              status === "ACTIVE" ? "success"
                              : status === "PAUSED" ? "destructive"
                              : status === "TRIAL" ? "warning"
                              : status === "CANCELLED" ? "secondary"
                              : "default"
                            }
                          >
                            {t(`status.${status}`)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {isTrial ? trialEnd || t("indicator.never") : t("noTrial")}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {periodStart && periodEnd ? `${periodStart} – ${periodEnd}` : t("indicator.never")}
                        </TableCell>
                        <TableCell className="text-right">
                          {/* Plan change button */}
                          {canChangePlan && (
                            <Link
                              href={`/${locale}/admin/tenants/${tenant.id}`}
                              className="text-sm font-medium text-primary hover:underline"
                            >
                              {t("changePlan")}
                            </Link>
                          )}

                          {/* Set trial button */}
                          {canSetTrial && (
                            <Link
                              href={`/${locale}/admin/tenants/${tenant.id}`}
                              className="text-sm font-medium text-primary hover:underline ml-2"
                            >
                              {t("setTrial")}
                            </Link>
                          )}

                          {/* Pause button */}
                          {canPause && (
                            <Link
                              href={`/${locale}/admin/tenants/${tenant.id}`}
                              className="text-sm font-medium text-destructive hover:underline ml-2"
                            >
                              {t("pauseSubscription")}
                            </Link>
                          )}

                          {/* Resume button */}
                          {canResume && (
                            <Link
                              href={`/${locale}/admin/tenants/${tenant.id}`}
                              className="text-sm font-medium text-success hover:underline ml-2"
                            >
                              {t("resumeSubscription")}
                            </Link>
                          )}

                          {/* Cancel button */}
                          {canCancel && (
                            <Link
                              href={`/${locale}/admin/tenants/${tenant.id}`}
                              className="text-sm font-medium text-secondary hover:underline ml-2"
                            >
                              {t("cancelSubscription")}
                            </Link>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      {/* Action Modals / Forms */}
      <div className="mt-6">
        {/* In a full implementation, these would be modal dialogs with forms.
         For now, we show the action buttons that trigger server actions on submit.
         The pattern here keeps the UI simple while maintaining server-side
         authorization and audit trails.}}

        {/* Change Plan Example */}
        {actionStatus.type === "change-plan" && actionStatus.loading && (
          <Card>
            <CardHeader>{t("changingPlan")}</CardHeader>
            <CardContent>{t("pleaseWait")}</CardContent>
          </Card>
        )}

        {/* Set Trial Example */}
        {actionStatus.type === "set-trial" && actionStatus.loading && (
          <Card>
            <CardHeader>{t("settingTrial")}</CardHeader>
            <CardContent>
              {actionStatus.error ? (
                <p className="text-red-600">{actionStatus.error}</p>
              ) : (
                <p>{t("trialSet", { trialEnd: actionStatus.data?.trialEnd ?? "N/A" })}</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Other action statuses would follow the same pattern... */}
      </div>
    </div>
  );
}

/** Platform auth guard for billing page */
async function _requirePlatformAuth() {
  const { import: requireAuth } = await import("@/lib/auth/helpers");
  return requireAuth();
}