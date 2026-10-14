import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@/lib/admin/format";
import type { TenantAuditEntry } from "@/lib/admin/tenant-queries";

/**
 * One workspace's audit trail, as the provider sees it.
 *
 * Action names are machine keys, and the console translates only the ones it
 * knows. Anything else is printed verbatim rather than mapped onto a plausible
 * label — a trail that renames an unknown event is a trail that can hide one.
 *
 * `metadata` is shown only for the events whose payload is a short, non-sensitive
 * summary (field names, hostnames, plan codes, refusal codes, reasons). The
 * writers keep secrets and business content out of it, and the audit appender
 * strips credential-shaped keys, but a free-form object is still the one place a
 * future writer could put something it shouldn't, so rendering stays
 * allow-listed per action family instead of dumping JSON.
 */
const LABELLED_ACTIONS: Record<string, string> = {
  "platform.tenantActivated": "tenantActivated",
  "platform.tenantSuspended": "tenantSuspended",
  "platform.tenantReactivated": "tenantReactivated",
  "platform.tenantUpdated": "tenantUpdated",
  "platform.tenantPlanAssigned": "tenantPlanAssigned",
  "platform.tenantBrandingUpdated": "tenantBrandingUpdated",
  "platform.tenantNumberingUpdated": "tenantNumberingUpdated",
  "platform.tenantDomainUpdated": "tenantDomainUpdated",
  "platform.tenantOwnerAssigned": "tenantOwnerAssigned",
  "platform.tenantOwnerInvited": "tenantOwnerInvited",
  "tenant.writeDenied": "writeDenied",
  "sync.rejected": "syncRejected",
};

/** Events whose `metadata` is safe to summarise. */
const METADATA_ACTIONS = new Set([
  "platform.tenantUpdated",
  "platform.tenantBrandingUpdated",
  "platform.tenantPlanAssigned",
  "platform.tenantDomainUpdated",
  "platform.tenantNumberingUpdated",
  "platform.tenantOwnerAssigned",
  "tenant.writeDenied",
  "sync.rejected",
]);

function summarise(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;

  const parts: string[] = [];

  const fields = metadata.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    parts.push(fields.map(String).join(", "));
  }

  for (const key of ["reason", "hostname", "planCode", "code", "email"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) {
      parts.push(`${key}: ${value}`);
    }
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

export async function TenantAuditPanel({
  entries,
  unavailable,
}: {
  entries: TenantAuditEntry[];
  /**
   * True when this administrator holds workspace read but not
   * `platform.audit.read`. The trail still exists; this operator simply is not
   * authorized to see it, and the panel distinguishes that from "nothing
   * happened" instead of showing an empty list.
   */
  unavailable: boolean;
}) {
  const t = await getTranslations("admin.audit");

  if (unavailable) {
    return <p className="text-sm text-muted-foreground">{t("noPermission")}</p>;
  }

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <ol className="space-y-3">
      {entries.map((entry) => {
        const slug = LABELLED_ACTIONS[entry.action];
        const summary = METADATA_ACTIONS.has(entry.action)
          ? summarise(entry.metadata)
          : null;

        return (
          <li
            key={entry.id}
            className="border-b border-border/60 pb-2 text-sm last:border-0 last:pb-0"
          >
            <p className="font-medium text-foreground">
              {slug ? t(`actions.${slug}`) : entry.action}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(entry.createdAt) ?? "—"}
              {entry.actorLabel ? ` · ${entry.actorLabel}` : ""}
            </p>
            {summary ? (
              <p className="mt-0.5 break-words text-xs text-muted-foreground">
                {summary}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
