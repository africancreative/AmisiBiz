"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { assignTenantOwnerAction } from "@/server/actions/platform";
import { useProviderActionForm } from "@/components/platform/use-provider-action-form";

/**
 * Initial tenant-owner assignment (Phase 2 requirement 2).
 *
 * This records the invitation; it never writes a membership row. The owner seat
 * is filled when the invited person accepts through the workspace invitation
 * flow, which is the only path that can create a `TENANT_OWNER` membership — a
 * provider cannot hand out a workspace role for someone who has not authenticated
 * as the invited address.
 *
 * Two limits are stated rather than glossed over:
 *  - there is no mail transport in this deployment, so nothing has been sent to
 *    the address and the console cannot show the acceptance link (only its hash
 *    is stored);
 *  - ownership of a live workspace moves through a role change inside that
 *    workspace, so once the seat is filled this panel stops offering writes.
 */
export function TenantOwnerPanel({
  tenantId,
  ownerEmail,
  pendingInvitationEmail,
  workspaceStatus,
}: {
  tenantId: string;
  ownerEmail: string | null;
  pendingInvitationEmail: string | null;
  workspaceStatus: string;
}) {
  const t = useTranslations("admin.owner");
  const { pending, error, succeeded, run, fieldError } =
    useProviderActionForm();
  const [email, setEmail] = useState("");

  const seatFilled = ownerEmail !== null;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    const ok = await run(() =>
      assignTenantOwnerAction({ tenantId, email: trimmed }),
    );
    if (ok) setEmail("");
  }

  return (
    <div className="space-y-4">
      {seatFilled ? (
        <div className="space-y-1">
          <p className="text-sm text-foreground">
            {t("currentOwner")}:{" "}
            <span className="font-medium">{ownerEmail}</span>
          </p>
          <p className="text-xs text-muted-foreground">{t("ownerImmutable")}</p>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{t("noOwner")}</p>
          {workspaceStatus === "PENDING" ? (
            <p className="text-xs text-muted-foreground">
              {t("pendingWorkspaceNote")}
            </p>
          ) : null}
        </div>
      )}

      {pendingInvitationEmail && !seatFilled ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {t("invitationPending", { email: pendingInvitationEmail })}
        </p>
      ) : null}

      {seatFilled ? null : (
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <div>
            <label htmlFor={`owner-email-${tenantId}`} className="label">
              {t("emailLabel")}
            </label>
            <input
              id={`owner-email-${tenantId}`}
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("emailPlaceholder")}
              maxLength={254}
              disabled={pending}
            />
            {fieldError("email") ? (
              <p className="field-error">{fieldError("email")}</p>
            ) : null}
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </p>
          ) : null}
          {succeeded && !error ? (
            <p className="text-sm text-emerald-700">{t("recorded")}</p>
          ) : null}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={pending || email.trim().length === 0}
          >
            {pending ? t("saving") : t("save")}
          </button>
        </form>
      )}

      <p className="text-xs text-muted-foreground">{t("noMailNote")}</p>
    </div>
  );
}
