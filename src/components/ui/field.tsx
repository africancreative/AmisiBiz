"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type FieldProps = {
  label: string;
  htmlFor?: string;
  required?: boolean;
  description?: React.ReactNode;
  error?: string | undefined;
  className?: string;
  children: React.ReactElement;
};

/**
 * Accessible form-field wrapper.
 *
 * Renders a real `<label>`, optional hint text and an error message, and wires
 * `id`/`aria-describedby`/`aria-invalid` onto the single child control so screen
 * readers and keyboard users get correct associations.
 */
export function Field({
  label,
  htmlFor,
  required,
  description,
  error,
  className,
  children,
}: FieldProps) {
  const generatedId = React.useId();
  const id = htmlFor ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  const control = React.cloneElement(
    children as React.ReactElement<Record<string, unknown>>,
    {
      id,
      required,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": describedBy,
    },
  );

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {control}
      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-xs font-medium text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
