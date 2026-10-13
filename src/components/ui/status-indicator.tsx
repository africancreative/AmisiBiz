import * as React from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

const dotTones: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
};

/**
 * Small labelled status pill with a colour-coded dot. Includes a visually
 * hidden text label so colour is never the only signal (WCAG 1.4.1).
 */
export function StatusIndicator({
  tone = "neutral",
  children,
  className,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm text-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 shrink-0 rounded-full", dotTones[tone])}
      />
      <span>{children}</span>
    </span>
  );
}
