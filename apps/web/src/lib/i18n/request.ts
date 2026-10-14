import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  // Validate the locale from the URL against our supported locales
  let locale = await requestLocale;

  // Ensure that the incoming locale is valid
  if (!locale || !routing.locales.includes(locale as "en" | "fr" | "sw")) {
    locale = routing.defaultLocale;
  }

  return {
    locale,
    messages: (
      await (locale === "en"
        ? import("../../../messages/en/index.json")
        : locale === "fr"
          ? import("../../../messages/fr/index.json")
          : import("../../../messages/sw/index.json"))
    ).default,
  };
});
