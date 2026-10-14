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

/**
 * A transition the server says this workspace can take.
 *
 * The list is computed server-side from `TENANT_STATUS_TRANSITIONS`
 * (`availableTransitions()` in `server/services/tenant-lifecycle.ts`) and passed
 * in as plain data, so the console can only ever offer a button for a transition
 * the same table authorizes. Nothing here decides which transitions exist.
 */
export type LifecycleTransition = {
  key: "activate" | "suspend" | "reactivate";
  fromStatus: TenantStatus;
  toStatus: TenantStatus;
};

const ACTIONS = {
  activate: activateTenantAction,
  suspend: suspendTenantAction,
  reactivate: reactivateTenantAction,
} as const;

const BUTTON_CLASS: Record<LifecycleTransition["key"], string> = {
  activate: "btn px-3 py-1 text-xs",
  reactivate: "btn btn-secondary px-3 py-1 text-xs",
  // Suspension is the one destructive-in-effect action in this console, and it
  // is deliberately the only red affordance on the header.
  suspend: "btn px-3 py-1 text-xs text-red-600 hover:bg-red-50",
};

export function TenantLifecycleActions({
  tenantId,
  transitions,
}: {
  tenantId: string;
  transitions: readonly LifecycleTransition[];
}) {
  const t = useTranslations("admin.actions");
  const router = useRouter();

  const [openKey, setOpenKey] = useState<LifecycleTransition["key"] | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(key: LifecycleTransition["key"]) {
    setOpenKey(key);
    setReason("");
    setError(null);
  }

  function close() {
    setOpenKey(null);
    setReason("");
    setError(null);
  }

  async function confirm(key: LifecycleTransition["key"]) {
    const trimmed = reason.trim();

    // The server requires a reason for EVERY transition; refusing here too means
    // an empty submission never becomes a pointless round trip.
    if (trimmed.length < 3) {
      setError(t("reasonRequired"));
      return;
    }

    setPending(true);
    setError(null);

    const result: ActionResult = await ACTIONS[key]({
      tenantId,
      reason: trimmed,
    });

    setPending(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    close();
    router.refresh();
  }

  if (transitions.length === 0) {
    return null;
  }

  const active = openKey
    ? transitions.find((row) => row.key === openKey)
    : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {transitions.map((transition) => (
          <button
            key={transition.key}
            type="button"
            className={BUTTON_CLASS[transition.key]}
            disabled={pending}
            onClick={() => open(transition.key)}
          >
            {t(`${transition.key}`)}
          </button>
        ))}
      </div>
      {error && !openKey ? <p className="field-error">{error}</p> : null}

      {active ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t(`${active.key}ConfirmTitle`)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 text-left"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
            <h2 className="text-base font-semibold text-foreground">
              {t(`${active.key}ConfirmTitle`)}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(`${active.key}Confirm`)}
            </p>
            {/* Written out rather than implied: what suspension does and does not
                do to the business's own records, including the offline-device
                caveat the directive asks for. */}
            <p className="mt-2 text-xs text-muted-foreground">
              {t(`${active.key}Effect`)}
            </p>

            <label
              className="mt-4 block text-sm font-medium text-foreground"
              htmlFor={`transition-reason-${active.key}-${tenantId}`}
            >
              {t("reasonLabel")}
            </label>
            <textarea
              id={`transition-reason-${active.key}-${tenantId}`}
              className="input mt-1 min-h-24 w-full"
              placeholder={t(`${active.key}ReasonPlaceholder`)}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={pending}
            />
            {error ? <p className="field-error mt-2">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary px-3 py-1.5 text-sm"
                disabled={pending}
                onClick={close}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className={BUTTON_CLASS[active.key]}
                disabled={pending}
                onClick={() => void confirm(active.key)}
              >
                {pending ? t("working") : t(`${active.key}`)}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
