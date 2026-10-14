import * as React from "react";
import { cn } from "./utils";

export type AlertTone = "info" | "success" | "warning" | "danger";

const tones: Record<AlertTone, string> = {
  info: "border-info/30 bg-info/10 text-info-foreground",
  success: "border-success/30 bg-success/10 text-success-foreground",
  warning: "border-warning/30 bg-warning/15 text-warning-foreground",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
};

const roleByTone: Record<AlertTone, "status" | "alert"> = {
  info: "status",
  success: "status",
  warning: "status",
  danger: "alert",
};

export function Alert({
  tone = "info",
  title,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  tone?: AlertTone;
  title?: React.ReactNode;
}) {
  return (
    <div
      role={roleByTone[tone]}
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        tones[tone],
        className,
      )}
      {...props}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? (
        <div className={cn(title && "mt-1 opacity-90")}>{children}</div>
      ) : null}
    </div>
  );
}
