"use client";

import * as React from "react";
import { cn } from "./utils";

export type ToastTone = "info" | "success" | "warning" | "danger";

type Toast = {
  id: number;
  title: string;
  description: string | undefined;
  tone: ToastTone;
};

type ToastContextValue = {
  toast: (input: {
    title: string;
    description?: string;
    tone?: ToastTone;
  }) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

const toneStyles: Record<ToastTone, string> = {
  info: "border-info/30 bg-info/10 text-info-foreground",
  success: "border-success/30 bg-success/10 text-success-foreground",
  warning: "border-warning/30 bg-warning/15 text-warning-foreground",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const counter = React.useRef(0);

  const remove = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = React.useCallback<ToastContextValue["toast"]>(
    ({ title, description, tone = "info" }) => {
      const id = counter.current++;
      setToasts((current) => [...current, { id, title, description, tone }]);
      window.setTimeout(() => remove(id), 5000);
    },
    [remove],
  );

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto w-full max-w-sm rounded-lg border px-4 py-3 text-sm shadow-md",
              toneStyles[item.tone],
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{item.title}</p>
                {item.description ? (
                  <p className="mt-0.5 opacity-90">{item.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => remove(item.id)}
                aria-label="Dismiss notification"
                className="rounded p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
