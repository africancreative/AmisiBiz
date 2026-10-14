"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const Dialog = ({
  children,
  className,
  open,
  onOpenChange,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & React.HTMLAttributes<HTMLDialogElement>) => {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={() => onOpenChange(false)}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-slate-900/40",
        className,
      )}
      {...props}
    >
      {children}
    </dialog>
  );
};

const DialogTrigger = ({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center justify-center"
  >
    {children}
  </button>
);

const DialogContent = ({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-5", className)} {...props}>
    {children}
  </div>
);

const DialogHeader = ({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 pb-5", className)} {...props}>
    {children}
  </div>
);

const DialogFooter = ({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex justify-end gap-2 border-t border-border pt-5",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

const DialogTitle = ({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn("text-base font-semibold", className)} {...props}>
    {children}
  </h2>
);

const DialogDescription = ({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm text-muted-foreground", className)} {...props}>
    {children}
  </p>
);

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
