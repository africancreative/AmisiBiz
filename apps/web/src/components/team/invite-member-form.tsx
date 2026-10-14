"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { inviteMemberAction } from "@/server/actions/tenant";
import type { TenantRole } from "@prisma/client";

export function InviteMemberForm({
  tenantId,
  invitableRoles,
}: {
  tenantId: string;
  invitableRoles: TenantRole[];
}) {
  const t = useTranslations("team");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantRole>(
    invitableRoles[invitableRoles.length - 1] ?? "VIEWER",
  );
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus("idle");
    setError(null);

    const result = await inviteMemberAction({ email, role, tenantId });
    setPending(false);

    if (!result.success) {
      setError(result.error);
      setStatus("error");
      return;
    }

    setStatus("success");
    setEmail("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="invite-email" className="label">
            {t("invite")}
          </label>
          <input
            id="invite-email"
            type="email"
            required
            className="input"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="label">
            {t("role")}
          </label>
          <select
            id="invite-role"
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value as TenantRole)}
          >
            {invitableRoles.map((r) => (
              <option key={r} value={r}>
                {t(`roles.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {t("invite")}
        </button>
      </div>

      {status === "success" ? (
        <p className="text-sm text-green-700">{t("inviteSuccess")}</p>
      ) : null}
      {status === "error" && error ? (
        <p className="field-error">{error}</p>
      ) : null}
    </form>
  );
}
