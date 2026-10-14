"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { assignTenantPlanAction } from "@/server/actions/platform";
import { useProviderActionForm } from "@/components/platform/use-provider-action-form";

export type PlanOption = {
  id: string;
  code: string;
  name: string;
  description: string;
  status: string;
};

/**
 * Subscription plan assignment (Phase 2 requirement 6).
 *
 * The label is informational: no feature, limit or permission in the product
 * reads it, and an overdue arrangement can only ever be suspended by a human
 * operator holding `platform.tenants.suspend`. Inactive plans stay visible but are
 * not offered for a new assignment, and the plan currently on the workspace is
 * always shown even if it has since been retired — the console must not hide the
 * label a business is actually carrying.
 */
export function TenantPlanPanel({
  tenantId,
  currentPlanId,
  plans,
}: {
  tenantId: string;
  currentPlanId: string | null;
  plans: PlanOption[];
}) {
  const t = useTranslations("admin.plan");
  const { pending, error, succeeded, run, fieldError } =
    useProviderActionForm();

  const [selected, setSelected] = useState(currentPlanId ?? "");
  const current = plans.find((plan) => plan.id === currentPlanId) ?? null;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(() =>
      assignTenantPlanAction({
        tenantId,
        planId: selected.trim() === "" ? null : selected,
      }),
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">
        {t("assigned")}:{" "}
        <span className="font-medium text-foreground">
          {current ? current.name : t("none")}
        </span>
      </p>
      {current ? (
        <p className="text-xs text-muted-foreground">{current.description}</p>
      ) : null}

      <div>
        <label htmlFor={`plan-${tenantId}`} className="label">
          {t("label")}
        </label>
        <select
          id={`plan-${tenantId}`}
          className="input"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={pending}
        >
          <option value="">{t("noPlanOption")}</option>
          {plans.map((plan) => (
            <option
              key={plan.id}
              value={plan.id}
              disabled={plan.status !== "ACTIVE" && plan.id !== currentPlanId}
            >
              {plan.name}
              {plan.status !== "ACTIVE" ? ` — ${t("inactive")}` : ""}
            </option>
          ))}
        </select>
        {fieldError("planId") ? (
          <p className="field-error">{fieldError("planId")}</p>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">{t("informationalNote")}</p>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}
      {succeeded && !error ? (
        <p className="text-sm text-emerald-700">{t("saved")}</p>
      ) : null}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? t("saving") : t("save")}
      </button>
    </form>
  );
}
