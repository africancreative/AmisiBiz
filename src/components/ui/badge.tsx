import * as React from "react";
import { cn } from "@/lib/utils";

export type BadgeTone =
  "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "gold";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  primary: "bg-primary/10 text-primary border-primary/20",
  success: "bg-success/10 text-success-foreground border-success/20",
  warning: "bg-warning/15 text-warning-foreground border-warning/25",
  danger: "bg-destructive/10 text-destructive border-destructive/20",
  info: "bg-info/10 text-info-foreground border-info/20",
  gold: "bg-accent/15 text-accent-foreground border-accent/25",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
