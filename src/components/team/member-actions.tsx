"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  updateMemberRoleAction,
  removeMemberAction,
} from "@/server/actions/tenant";
import type { TenantRole } from "@prisma/client";

export function MemberRowActions({
  memberId,
  tenantId,
  currentRole,
  assignableRoles,
  canManage,
}: {
  memberId: string;
  tenantId: string;
  currentRole: TenantRole;
  assignableRoles: TenantRole[];
  canManage: boolean;
}) {
  const t = useTranslations("team");
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<TenantRole>(currentRole);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) {
    return (
      <span className="text-xs text-slate-500">
        {t(`roles.${currentRole}`)}
      </span>
    );
  }

  async function onUpdate() {
    setPending(true);
    setError(null);
    const result = await updateMemberRoleAction({
      memberId,
      role: selectedRole,
      tenantId,
    });
    setPending(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function onRemove() {
    if (!window.confirm(t("removeConfirm"))) return;
    setPending(true);
    setError(null);
    const result = await removeMemberAction(memberId, tenantId);
    setPending(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <select
          className="input py-1 text-xs"
          value={selectedRole}
          onChange={(e) => setSelectedRole(e.target.value as TenantRole)}
          disabled={pending}
        >
          <option value={currentRole}>{t(`roles.${currentRole}`)}</option>
          {assignableRoles
            .filter((role) => role !== currentRole)
            .map((role) => (
              <option key={role} value={role}>
                {t(`roles.${role}`)}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="btn btn-secondary px-2 py-1 text-xs"
          onClick={onUpdate}
          disabled={pending || selectedRole === currentRole}
        >
          {t("update")}
        </button>
        <button
          type="button"
          className="btn px-2 py-1 text-xs text-red-600 hover:bg-red-50"
          onClick={onRemove}
          disabled={pending}
        >
          {t("remove")}
        </button>
      </div>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}
