import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@/lib/admin/format";
import type { TenantStatusHistoryEntry } from "@/lib/admin/tenant-queries";

/**
 * Status history (Phase 2 requirement 9).
 *
 * The table is append-only in the database — `tenant_status_history_is_append_only`
 * refuses UPDATE and DELETE even for the schema owner — so this list is the whole
 * recorded life of the workspace, not a mutable summary. Every row the console
 * produced carries the reason the operator typed, which is what makes a suspension
 * defensible after the fact.
 */
export async function TenantStatusHistoryPanel({
  entries,
}: {
  entries: TenantStatusHistoryEntry[];
}) {
  const t = await getTranslations("admin.history");
  const tStatus = await getTranslations("admin.status");

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <ol className="space-y-3">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="border-b border-border/60 pb-3 last:border-0 last:pb-0"
        >
          <p className="text-sm font-medium text-foreground">
            {entry.fromStatus
              ? t("transition", {
                  from: tStatus(entry.fromStatus),
                  to: tStatus(entry.toStatus),
                })
              : t("created", { to: tStatus(entry.toStatus) })}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(entry.createdAt) ?? "—"}
            {entry.changedByLabel ? ` · ${entry.changedByLabel}` : ""}
          </p>
          {entry.reason ? (
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {entry.reason}
            </p>
          ) : (
            <p className="mt-1 text-xs italic text-muted-foreground">
              {t("noReason")}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
