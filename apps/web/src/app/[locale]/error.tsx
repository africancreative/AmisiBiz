"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@amisibiz/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@amisibiz/ui/card";

/**
 * Route-level error boundary for everything under a locale.
 *
 * Deliberately does NOT render `error.message` — in production it can carry
 * internal detail. The Next.js digest (a hash) is what goes to the console
 * and to logs, so an incident can still be correlated.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");

  useEffect(() => {
    console.error("[app] Route error", error.name, error.digest ?? "");
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>{t("errorTitle")}</CardTitle>
          <CardDescription>{t("error")}</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button type="button" onClick={reset}>
            {t("retry")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
