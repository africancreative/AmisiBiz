import { getTranslations } from "next-intl/server";
import { Badge, type BadgeTone } from "@amisibiz/ui/badge";
import type { TenantStatus } from "@prisma/client";

const TONES: Record<TenantStatus, BadgeTone> = {
  PENDING: "warning",
  ACTIVE: "success",
  SUSPENDED: "danger",
};

export async function TenantStatusBadge({ status }: { status: TenantStatus }) {
  const t = await getTranslations("admin.status");
  return <Badge tone={TONES[status]}>{t(status)}</Badge>;
}
