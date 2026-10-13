import { getTranslations } from "next-intl/server";
import {
  requireAuth,
  getPrimaryMembership,
  TENANT_ROLE_RANK,
} from "@/lib/auth/helpers";
import { prisma } from "@/lib/db/prisma";
import {
  authorizeTenant,
  AuthorizationError,
} from "@/server/auth/authorization";
import { PERMISSIONS, tenantRoleHasPermission } from "@/lib/auth/permissions";
import { InviteMemberForm } from "@/components/team/invite-member-form";
import { MemberRowActions } from "@/components/team/member-actions";
import { SignOutButton } from "@/components/auth/sign-out-button";
import type { TenantRole } from "@prisma/client";

export const dynamic = "force-dynamic";

const ROLE_ORDER: TenantRole[] = [
  "VIEWER",
  "SALES_STAFF",
  "DOCUMENT_MANAGER",
  "BUSINESS_ADMIN",
  "BUSINESS_OWNER",
];

export default async function TeamPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await requireAuth(locale);
  const primary = await getPrimaryMembership(session.user.id);

  const t = await getTranslations("team");
  const tNav = await getTranslations("nav");
  const tCommon = await getTranslations("common");

  if (!primary) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <div className="card p-6 text-sm text-slate-600">
          No organisation is associated with this account yet.
        </div>
      </main>
    );
  }

  const tenantId = primary.tenant.id;

  let actorRole: TenantRole;
  try {
    // Server-side authorization: membership + tenant status + read permission.
    const ctx = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.BUSINESS_MEMBERS_READ,
    );
    actorRole = ctx.role;
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return (
        <main className="mx-auto max-w-3xl px-4 py-12">
          <div className="card p-6 text-sm text-slate-600">
            You do not have access to this organisation&apos;s team.
          </div>
        </main>
      );
    }
    throw err;
  }

  const actorRank = TENANT_ROLE_RANK[actorRole];
  const canManage = tenantRoleHasPermission(
    actorRole,
    PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
  );
  // A member may only delegate roles strictly below their own rank.
  const invitableRoles = ROLE_ORDER.filter(
    (r) => TENANT_ROLE_RANK[r] < actorRank,
  );
  const assignableRoles = invitableRoles;

  const [members, invitations] = await Promise.all([
    prisma.tenantMember.findMany({
      where: { tenantId },
      orderBy: { joinedAt: "asc" },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.invitation.findMany({
      where: { tenantId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, expiresAt: true },
    }),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-slate-600">{primary.tenant.name}</p>
        </div>
        <SignOutButton label={tNav("signOut")} />
      </header>

      {canManage ? (
        <section className="card mb-8 p-6">
          <InviteMemberForm
            tenantId={tenantId}
            invitableRoles={invitableRoles}
          />
        </section>
      ) : null}

      <section className="card mb-8 overflow-hidden">
        <h2 className="border-b border-slate-200 px-6 py-4 text-sm font-semibold text-slate-700">
          {t("members")}
        </h2>
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-6 py-3">{t("members")}</th>
              <th className="px-6 py-3">{t("role")}</th>
              <th className="px-6 py-3 text-right">{t("actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((member) => {
              const isSelf = member.userId === session.user.id;
              return (
                <tr key={member.id}>
                  <td className="px-6 py-3">
                    <div className="font-medium text-slate-800">
                      {member.user.name ?? member.user.email}
                    </div>
                    <div className="text-xs text-slate-500">
                      {member.user.email}
                    </div>
                  </td>
                  <td className="px-6 py-3 text-slate-700">
                    {t(`roles.${member.role}`)}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex justify-end">
                      {!isSelf ? (
                        <MemberRowActions
                          memberId={member.id}
                          tenantId={tenantId}
                          currentRole={member.role}
                          assignableRoles={assignableRoles}
                          canManage={
                            canManage &&
                            TENANT_ROLE_RANK[member.role] < actorRank
                          }
                        />
                      ) : (
                        <span className="text-xs text-slate-400">
                          {t(`roles.${member.role}`)}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-200 px-6 py-4 text-sm font-semibold text-slate-700">
          {t("invitations")}
        </h2>
        {invitations.length === 0 ? (
          <p className="px-6 py-4 text-sm text-slate-500">
            {tCommon("noResults")}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex items-center justify-between px-6 py-3 text-sm"
              >
                <span className="font-medium text-slate-800">
                  {invitation.email}
                </span>
                <span className="text-slate-500">
                  {t(`roles.${invitation.role}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
