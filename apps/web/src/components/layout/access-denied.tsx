import { getTranslations } from "next-intl/server";
import { ErrorState } from "@amisibiz/ui/state";

/** Server-rendered "controlled access" state for denied / unavailable areas. */
export async function AccessDenied({
  title,
  description,
}: {
  title?: string;
  description?: string;
}) {
  const t = await getTranslations("states");
  return (
    <ErrorState
      title={title ?? t("forbiddenTitle")}
      description={description ?? t("forbiddenDescription")}
    />
  );
}
