import * as React from "react";
import { cn } from "./utils";

export function Spinner({
  className,
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center">
      <span
        aria-hidden="true"
        className={cn(
          "h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent text-muted-foreground",
          className,
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
