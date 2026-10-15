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
import { invitePlatformAdmin, changePlatformRole, revokePlatformAccess } from "@/server/actions/platform-users/management";
import { useNavigate } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminPlatformUsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  // Authorization check
  const session = await _requirePlatformAuth();
  await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_USERS_MANAGE);

  // Fetch all users with platform role
  const users = await prisma.user.findMany({
    where: { platformRole: { not: null } },
    include: {
      _count: {
        select: { tenantMemberships: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // State for action forms
  const [actionStatus, setActionStatus] = useState<{
    type "invite" | "change-role" | "revoke";
    loading: boolean;
    error: string | null;
    data?: {
      email: string;
      role: PlatformRole;
      targetUserId: string;
      reason?: string;
    };
  }>({ type: "invite" as const, loading: false, error: null, data: {} });

  const navigate = useNavigate();

  // --- Invite Platform Admin Form ---
  const handleInvite = async () => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "invite", loading: true, error: null, data: {} });

    const result = await invitePlatformAdmin(
      actionStatus.data.email,
      actionStatus.data.role,
      actionStatus.data.reason || "Platform administrator invitation"
    );

    setActionStatus({
      type: "invite",
      loading: false,
      error: result.error || null,
      data: {},
    });

    if (result.success) {
      // Show invitation succeeded - in a full implementation, would send email
      navigate(`/${locale}/admin/platform-users`);
    }
  };

  // --- Change Role Form ---
  const handleChangeRole = async () => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "change-role", loading: true, error: null, data: {} });

    const result = await changePlatformRole(
      actionStatus.data.targetUserId,
      actionStatus.data.role,
      session.user.id,
      actionStatus.data.reason || "Platform role change by administrator"
    );

    setActionStatus({
      type: "change-role",
      loading: false,
      error: result.error || null,
      data: {},
    });

    if (result.success) {
      navigate(`/${locale}/admin/platform-users`);
    }
  };

  // --- Revoke Access Form ---
  const handleRevoke = async () => {
    if (!actionStatus.data) return;
    setActionStatus({ type: "revoke", loading: true, error: null, data: {} });

    const result = await revokePlatformAccess(
      actionStatus.data.targetUserId,
      session.user.id,
      actionStatus.data.reason || "Platform access revoked by administrator"
    );

    setActionStatus({
      type: "revoke",
      loading: false,
      error: result.error || null,
      data: {},
    });

    if (result.success) {
      navigate(`/${locale}/admin/platform-users`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t("platformUsersTitle")}</h1>
        <p className="text-muted-foreground">{t("platformUsersDescription")}</p>
      </div>

      {/* Current Platform Administrators Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t("currentAdministrators")}</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <EmptyState
              title={t("noPlatformAdmins")}
              description={t("noPlatformAdminsDescription")}
              icon={<AlertCircleIcon className="h-5 w-5 mx-2" />}
            />
          ) : (
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("table.nameEmail")}</TableHead>
                    <TableHead>{t("table.role")}</TableHead>
                    <TableHead>{t("table.tenants")}</TableHead>
                    <TableHead className="text-right">{t("table.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => {
                    const role = user.platformRole ?? "None";
                    const roleBadge = role === "SUPER_ADMIN"
                      ? <Badge tone="success">{t(`role.${role}`)}>
                      : role === "SUPPORT"
                        ? <Badge tone="warning">{t(`role.${role}`)}>
                        : <Badge tone="default">{t(`role.${role}`)}>;

                    const tenantCount = user._count.tenantMemberships;

                    return (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="font-medium text-foreground">
                            {user.name || user.email}
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {user.email}
                          </p>
                        </TableCell>
                        <TableCell>{roleBadge}</TableCell>
                        <TableCell className="text-muted-foreground">{tenantCount}</TableCell>
                        <TableCell className="text-right">
                          {/* Role change link (for SUPER_ADMIN only) */}
                          {user.platformRole === "SUPER_ADMIN" && (
                            <Link
                              href={`/${locale}/admin/platform-users/change-role/${user.id}`}
                              className="text-sm font-medium text-primary hover:underline mr-2"
                            >
                              {t("changeRole")}
                            </Link>
                          )}

                          {/* Revoke link */}
                          {user.platformRole !== "SUPER_ADMIN" || user.id !== session.user.id && superAdminCount > 1 && (
                            <Link
                              href={`/${locale}/admin/platform-users/revoke/${user.id}`}
                              className="text-sm font-medium text-danger hover:underline"
                            >
                              {t("revokeAccess")}
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

      {/* Action Forms */}
      <div className="mt-6">
        {/* Invite Platform Admin */}
        {actionStatus.type === "invite" && actionStatus.loading && (
          <Card>
            <CardHeader>{t("invitingAdmin")}</CardHeader>
            <CardContent>{t("pleaseWait")}</CardContent>
          </Card>
        )}

        {/* Change Role */}
        {actionStatus.type === "change-role" && actionStatus.loading && (
          <Card>
            <CardHeader>{t("changingRole")}</CardHeader>
            <CardContent>{t("pleaseWait")}</CardContent>
          </Card>
        )}

        {/* Revoke Access */}
        {actionStatus.type === "revoke" && actionStatus.loading && (
          <Card>
            <CardHeader>{t("revokingAccess")}</CardHeader>
            <CardContent>{t("pleaseWait")}</CardContent>
          </Card>
        )}

        {/* Action buttons */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            onClick={(e) => {
              e.preventDefault();
              setActionStatus({ type: "invite", loading: true, error: null, data: {} });
            }}
            className="btn btn-primary w-full"
          >
            {t("inviteAdmin")}
          </button>

          {/* In a full implementation, the change role and revoke forms would
              have their own input fields and submit handlers. For brevity, they are
              represented as triggers linked from the table above. */}
        </div>
      </div>
    </div>
  );
}

/** Platform auth guard for platform-users page */
async function _requirePlatformAuth() {
  const { import: requireAuth } = await import("@/lib/auth/helpers");
  return requireAuth();
}