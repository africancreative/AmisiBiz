"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  addTenantDomainAction,
  removeTenantDomainAction,
  setPrimaryDomainAction,
  updateTenantSlugAction,
} from "@/server/actions/platform";
import { useProviderActionForm } from "@/components/platform/use-provider-action-form";

/**
 * Workspace address management (Phase 2 requirement 8): the slug route and the
 * custom hostnames that resolve to this tenant.
 *
 * Both are provider-only. `tenant_provider_columns_guard_update` refuses a
 * workspace's own members moving the slug at all, and the hostname policies gate
 * writes on an ACTIVE status, so a suspended business cannot re-point or delete
 * its own domain while the provider still can.
 */
export function TenantDomainsPanel({
  tenantId,
  slug,
  baseDomain,
  domains,
}: {
  tenantId: string;
  slug: string;
  /**
   * The configured base domain, resolved server-side. Null means the deployment
   * has no base domain set, so the slug route cannot be shown as a URL — the
   * console says so instead of inventing one.
   */
  baseDomain: string | null;
  domains: Array<{ hostname: string; isPrimary: boolean }>;
}) {
  const t = useTranslations("admin.domains");
  const slugForm = useProviderActionForm();
  const addForm = useProviderActionForm();
  const rowForm = useProviderActionForm();

  const [nextSlug, setNextSlug] = useState(slug);
  const [hostname, setHostname] = useState("");
  const [setAsPrimary, setSetAsPrimary] = useState(false);

  const slugRoute = baseDomain ? `${slug}.${baseDomain}` : null;
  const nextSlugRoute =
    baseDomain && nextSlug.trim() ? `${nextSlug.trim()}.${baseDomain}` : null;

  async function saveSlug(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await slugForm.run(() =>
      updateTenantSlugAction({ tenantId, slug: nextSlug.trim() }),
    );
  }

  async function addDomain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = hostname.trim();
    if (!trimmed) return;

    const ok = await addForm.run(() =>
      addTenantDomainAction({ tenantId, hostname: trimmed, setAsPrimary }),
    );

    if (ok) {
      setHostname("");
      setSetAsPrimary(false);
    }
  }

  async function makePrimary(target: string) {
    await rowForm.run(() =>
      setPrimaryDomainAction({ tenantId, hostname: target }),
    );
  }

  async function remove(target: string) {
    if (!window.confirm(t("removeConfirm", { hostname: target }))) return;
    await rowForm.run(() =>
      removeTenantDomainAction({ tenantId, hostname: target }),
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={saveSlug} className="space-y-3" noValidate>
        <div>
          <label htmlFor={`slug-${tenantId}`} className="label">
            {t("slugLabel")}
          </label>
          <input
            id={`slug-${tenantId}`}
            className="input"
            value={nextSlug}
            onChange={(event) => setNextSlug(event.target.value)}
            maxLength={63}
            disabled={slugForm.pending}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {slugRoute
              ? t("slugCurrentRoute", { hostname: slugRoute })
              : t("slugNoBaseDomain")}
          </p>
          {nextSlug.trim() !== slug && nextSlug.trim().length > 0 ? (
            <p className="mt-1 text-xs text-amber-700">
              {nextSlugRoute
                ? t("slugNewRoute", { hostname: nextSlugRoute })
                : t("slugInvalid")}
            </p>
          ) : null}
          {slugForm.fieldError("slug") ? (
            <p className="field-error">{slugForm.fieldError("slug")}</p>
          ) : null}
        </div>

        {slugForm.error ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {slugForm.error}
          </p>
        ) : null}

        <button
          type="submit"
          className="btn btn-secondary px-3 py-1.5 text-sm"
          disabled={slugForm.pending || nextSlug.trim() === slug}
        >
          {slugForm.pending ? t("slugSaving") : t("slugSave")}
        </button>
      </form>

      <div>
        <p className="text-xs text-muted-foreground">{t("slugWarning")}</p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{t("hostnames")}</p>
        {domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noHostnames")}</p>
        ) : (
          <ul className="space-y-1">
            {domains.map((domain) => (
              <li
                key={domain.hostname}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-1.5 last:border-0"
              >
                <span className="text-sm text-foreground">
                  {domain.hostname}
                  {domain.isPrimary ? (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("primary")}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  {domain.isPrimary ? null : (
                    <button
                      type="button"
                      className="text-sm font-medium text-primary hover:underline"
                      disabled={rowForm.pending}
                      onClick={() => void makePrimary(domain.hostname)}
                    >
                      {t("makePrimary")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-sm font-medium text-destructive hover:underline"
                    disabled={rowForm.pending}
                    onClick={() => void remove(domain.hostname)}
                  >
                    {t("remove")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {rowForm.error ? <p className="field-error">{rowForm.error}</p> : null}
      </div>

      <form onSubmit={addDomain} className="space-y-3" noValidate>
        <div>
          <label htmlFor={`hostname-${tenantId}`} className="label">
            {t("addLabel")}
          </label>
          <input
            id={`hostname-${tenantId}`}
            className="input"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder={t("addPlaceholder")}
            maxLength={253}
            disabled={addForm.pending}
          />
          {addForm.fieldError("hostname") ? (
            <p className="field-error">{addForm.fieldError("hostname")}</p>
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={setAsPrimary}
            onChange={(event) => setSetAsPrimary(event.target.checked)}
            disabled={addForm.pending}
          />
          {t("setAsPrimary")}
        </label>

        {addForm.error ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {addForm.error}
          </p>
        ) : null}

        <button
          type="submit"
          className="btn btn-secondary px-3 py-1.5 text-sm"
          disabled={addForm.pending || hostname.trim().length === 0}
        >
          {addForm.pending ? t("addSaving") : t("add")}
        </button>
      </form>

      <p className="text-xs text-muted-foreground">{t("verificationNote")}</p>
    </div>
  );
}
