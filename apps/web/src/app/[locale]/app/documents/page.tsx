import { getTranslations } from "next-intl/server";
import { getWorkspaceState } from "@/server/auth/workspace";
import { PERMISSIONS } from "@amisibiz/auth";
import { AccessDenied } from "@/components/layout/access-denied";
import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { Button } from "@amisibiz/ui/button";

export const dynamic = "force-dynamic";

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getWorkspaceState(locale, PERMISSIONS.DOCUMENTS_READ);
  if (state.status !== "ok") {
    return <AccessDenied />;
  }

  const t = await getTranslations("modules.documents");
  const tModules = await getTranslations("modules");

  return (
    <ModulePlaceholder
      title={t("title")}
      description={t("description")}
      columns={["Number", "Type", "Contact", "Status", "Total"]}
      emptyTitle={t("emptyTitle")}
      emptyDescription={t("emptyDescription")}
      action={
        <Button variant="primary" disabled>
          {tModules("newButton")}
        </Button>
      }
    />
  );
}
