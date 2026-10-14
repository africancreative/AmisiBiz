import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@/lib/admin/format";
import type { TenantDetail } from "@/lib/admin/tenant-queries";
import { SYNC_REFUSAL_CODES } from "@/server/services/tenant-indicators";

/**
 * Machine code → operator wording. An unrecognised code is shown verbatim rather
 * than translated into a guess: the code is what the server actually recorded, so
 * displaying it unchanged keeps the console honest while the message catalogues
 * catch up.
 */
const KNOWN_CODES: readonly string[] = Object.values(SYNC_REFUSAL_CODES);

/**
 * Operational indicators (Phase 2 requirement 10).
 *
 * Read-only by construction: nothing in this file can write an indicator, and the
 * columns it displays are writable only through `touch_tenant_activity()` and
 * `record_tenant_sync_attempt()`, which the database grants to the application
 * role and to nothing else. A `null` here is a real answer — "nothing has been
 * recorded for this workspace" — and the panel says so instead of borrowing
 * `updatedAt` to look busy.
 *
 * `lastSyncAt` is null for every workspace in this deployment because there is no
 * synchronization transport yet (Phase 06). Showing "no synchronization recorded"
 * is the accurate statement; showing a timestamp would be a fabrication.
 */
export async function TenantIndicatorsPanel({
  tenant,
}: {
  tenant: Pick<
    TenantDetail,
    "lastActivityAt" | "lastSyncAt" | "lastSyncErrorCode" | "updatedAt"
  >;
}) {
  const t = await getTranslations("admin.indicators");

  const rows: { label: string; value: string; hint?: string }[] = [
    {
      label: t("lastActivity"),
      value: tenant.lastActivityAt
        ? (formatDateTime(tenant.lastActivityAt) ?? "")
        : t("lastActivityNone"),
      hint: t("lastActivityHint"),
    },
    {
      label: t("lastSync"),
      value: tenant.lastSyncAt
        ? (formatDateTime(tenant.lastSyncAt) ?? "")
        : t("lastSyncNone"),
      hint: t("lastSyncHint"),
    },
    {
      label: t("lastSyncFailure"),
      value: tenant.lastSyncErrorCode
        ? KNOWN_CODES.includes(tenant.lastSyncErrorCode)
          ? t(`codes.${tenant.lastSyncErrorCode}`)
          : tenant.lastSyncErrorCode
        : t("lastSyncFailureNone"),
    },
    {
      label: t("recordUpdated"),
      value: formatDateTime(tenant.updatedAt) ?? "",
      hint: t("recordUpdatedHint"),
    },
  ];

  return (
    <div className="space-y-4">
      <dl className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="border-b border-border/60 pb-2 last:border-0 last:pb-0"
          >
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="text-sm font-medium text-foreground">{row.value}</dd>
            {row.hint ? (
              <p className="text-xs text-muted-foreground">{row.hint}</p>
            ) : null}
          </div>
        ))}
      </dl>

      {/* The suspension limit stated plainly, because the alternative is an
          operator believing a revocation landed the moment they clicked it. */}
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        {t("offlineNote")}
      </p>
    </div>
  );
}
