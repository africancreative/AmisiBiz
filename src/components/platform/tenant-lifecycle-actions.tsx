"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  activateTenantAction,
  reactivateTenantAction,
  suspendTenantAction,
} from "@/server/actions/platform";
import type { ActionResult } from "@/lib/errors";
import type { TenantStatus } from "@prisma/client";

export function TenantLifecycleActions({
  tenantId,
  status,
}: {
  tenantId: string;
  status: TenantStatus;
}) {
  const t = useTranslations("admin.actions");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");

  async function run(action: () => Promise<ActionResult>): Promise<void> {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setDialogOpen(false);
    setReason("");
    router.refresh();
  }

  if (status === "PENDING") {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          className="btn px-3 py-1 text-xs"
          disabled={pending}
          onClick={() => {
            if (window.confirm(t("activateConfirm"))) {
              void run(() => activateTenantAction(tenantId));
            }
          }}
        >
          {pending ? t("working") : t("activate")}
        </button>
        {error ? <p className="field-error">{error}</p> : null}
      </div>
    );
  }

  if (status === "SUSPENDED") {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          className="btn btn-secondary px-3 py-1 text-xs"
          disabled={pending}
          onClick={() => {
            if (window.confirm(t("reactivateConfirm"))) {
              void run(() => reactivateTenantAction(tenantId));
            }
          }}
        >
          {pending ? t("working") : t("reactivate")}
        </button>
        {error ? <p className="field-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn px-3 py-1 text-xs text-red-600 hover:bg-red-50"
        disabled={pending}
        onClick={() => {
          setError(null);
          setDialogOpen(true);
        }}
      >
        {t("suspend")}
      </button>
      {error && !dialogOpen ? <p className="field-error">{error}</p> : null}

      {dialogOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("suspendConfirmTitle")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 text-left"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
            <h2 className="text-base font-semibold text-foreground">
              {t("suspendConfirmTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("suspendConfirm")}
            </p>
            <label
              className="mt-4 block text-sm font-medium text-foreground"
              htmlFor={`suspend-reason-${tenantId}`}
            >
              {t("suspensionReasonLabel")}
            </label>
            <textarea
              id={`suspend-reason-${tenantId}`}
              className="input mt-1 min-h-24 w-full"
              placeholder={t("suspensionReasonPlaceholder")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
            />
            {error ? <p className="field-error mt-2">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary px-3 py-1.5 text-sm"
                disabled={pending}
                onClick={() => {
                  setDialogOpen(false);
                  setError(null);
                  setReason("");
                }}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="btn px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                disabled={pending}
                onClick={() => {
                  if (reason.trim().length < 3) {
                    setError(t("reasonRequired"));
                    return;
                  }
                  void run(() =>
                    suspendTenantAction({ tenantId, reason: reason.trim() }),
                  );
                }}
              >
                {pending ? t("working") : t("suspend")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
