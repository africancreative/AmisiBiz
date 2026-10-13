import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CreateTenantForm } from "@/components/platform/create-tenant-form";

export const dynamic = "force-dynamic";

export default async function NewTenantPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("create.title")}
        description={t("create.description")}
        actions={
          <Link
            href={`/${locale}/admin/tenants`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("detail.backToList")}
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{t("create.cardTitle")}</CardTitle>
          <CardDescription>{t("create.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateTenantForm locale={locale} />
        </CardContent>
      </Card>
    </div>
  );
}
