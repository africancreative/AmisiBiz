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
import { reportError } from "@/lib/error-tracking";

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
    // One reporting path for every boundary: structured, redacted, and carrying
    // only the digest in production. `reportError` never throws and never
    // surfaces the raw error, so the boundary stays the last line of defence.
    reportError(error, { scope: "route:locale" });
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
