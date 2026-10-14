import { getTranslations } from "next-intl/server";
import { Spinner } from "@amisibiz/ui/spinner";

/**
 * Route-level loading state for everything under a locale. Announced politely
 * to assistive technology; the visible text is decorative to avoid a double
 * announcement (the Spinner carries the accessible label).
 */
export default async function LocaleLoading() {
  const t = await getTranslations("common");
  return (
    <div className="flex min-h-[50vh] items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner label={t("loading")} />
      <span aria-hidden="true">{t("loading")}</span>
    </div>
  );
}
