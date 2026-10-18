"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Field } from "@amisibiz/ui/field";
import { Input } from "@amisibiz/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@amisibiz/ui/dialog";
import { Loader2 } from "lucide-react";
import type { ActionResult } from "@/lib/errors";

/**
 * A dialog for the document actions that CREATE a new document from an existing
 * one (order → invoice, order/invoice → delivery note, accepted quotation →
 * order).
 *
 * Two disciplines it exists to enforce:
 *
 *  1. **One idempotency key per dialog opening.** The key is generated on mount,
 *     so pressing "confirm" twice — or retrying after a lost response — replays
 *     the same write: the engine looks the key up and returns the document it
 *     already made instead of allocating a second number. Closing the dialog and
 *     opening it again is a new intent and gets a new key.
 *  2. **Nothing is claimed until the action says so.** Success is read from
 *     `result.success`, the new document's id from `result.data.id`, and a
 *     failure is shown verbatim (the document actions' messages are written to be
 *     safe to display). The dialog never says "created" on its own authority.
 *
 * The caller mounts this component only while it is open, which is what makes the
 * generated key match the operator's intent rather than the page's lifetime.
 */

export type DerivativeDateField = "issueDate" | "dueDate" | "deliveryDate";

/** The figures the create-style document actions accept, all optional. */
export interface DerivativeDialogInput {
  issueDate?: string;
  dueDate?: string;
  deliveryDate?: string;
  idempotencyKey: string;
}

interface DerivativeDocumentDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  /** Only the date fields the action's own input accepts are rendered. */
  fields?: readonly DerivativeDateField[];
  /** A fact the operator needs before committing, e.g. a one-per rule. */
  notice?: string;
  run: (
    input: DerivativeDialogInput,
  ) => Promise<ActionResult<{ id?: string; number?: string }>>;
  /** Called with the created document's id, exactly as the server returned it. */
  onCreated: (id: string) => void;
  onClose: () => void;
}

const FIELD_LABELS: Record<DerivativeDateField, string> = {
  issueDate: "Issue date",
  dueDate: "Due date",
  deliveryDate: "Delivery date",
};

function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}

function toIsoDate(input: string): string {
  // A date input names a calendar day; anchoring it at midnight UTC keeps the day
  // the operator typed the day the server reads back.
  return new Date(`${input}T00:00:00.000Z`).toISOString();
}

export function DerivativeDocumentDialog({
  title,
  description,
  confirmLabel,
  fields = ["issueDate"],
  notice,
  run,
  onCreated,
  onClose,
}: DerivativeDocumentDialogProps) {
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field, todayInputValue()])),
  );
  const [fieldErrors, setFieldErrors] = React.useState<
    Partial<Record<DerivativeDateField, string>>
  >({});
  const [error, setError] = React.useState<string | null>(null);
  const [isBusy, setIsBusy] = React.useState(false);

  const setValue = (field: DerivativeDateField, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setFieldErrors((previous) => ({ ...previous, [field]: undefined }));
    setError(null);
  };

  const submit = async () => {
    const nextErrors: Partial<Record<DerivativeDateField, string>> = {};
    for (const field of fields) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(values[field] ?? "")) {
        nextErrors[field] = "Choose a calendar date.";
      }
    }
    setFieldErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      setError("Check the dates below.");
      return;
    }

    setIsBusy(true);
    setError(null);
    try {
      const input: DerivativeDialogInput = { idempotencyKey };
      for (const field of fields) {
        input[field] = toIsoDate(values[field] ?? "");
      }
      const result = await run(input);
      if (!result.success) {
        setError(result.error ?? "The document could not be created.");
        return;
      }
      const createdId = result.data?.id;
      if (!createdId) {
        // A success without an id is not something this screen can open; saying
        // so is better than navigating to a blank detail page.
        setError(
          "The action reported success but returned no document to open. Refresh the documents list before trying again.",
        );
        return;
      }
      onCreated(createdId);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <Field
                key={field}
                label={FIELD_LABELS[field]}
                error={fieldErrors[field]}
              >
                <Input
                  type="date"
                  value={values[field] ?? ""}
                  disabled={isBusy}
                  onChange={(e) => setValue(field, e.target.value)}
                />
              </Field>
            ))}
          </div>

          {error && (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isBusy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={isBusy}>
            {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
