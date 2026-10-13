import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { tenantRoleHasPermission } from "@/lib/auth/permissions";
import { AccessDenied } from "@/components/layout/access-denied";
import { ContactDetailClient } from "../contact-detail-client";

export const dynamic = "force-dynamic";

interface ContactDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
}

export default async function ContactDetailPage({
  params,
}: ContactDetailPageProps) {
  const { locale, id } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.CONTACTS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const t = await getTranslations("modules.contacts");
  const role = state.context.role;

  return (
    <ContactDetailClient
      locale={locale}
      tenantId={state.membership.tenantId}
      contactId={id}
      canUpdate={tenantRoleHasPermission(role, PERMISSIONS.CONTACTS_UPDATE)}
      canDelete={tenantRoleHasPermission(role, PERMISSIONS.CONTACTS_DELETE)}
      canManageItems={tenantRoleHasPermission(role, PERMISSIONS.ITEMS_CREATE)}
      title={t("title")}
    />
  );
}