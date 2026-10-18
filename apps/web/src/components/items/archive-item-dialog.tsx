"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Textarea } from "@amisibiz/ui/textarea";
import { Field } from "@amisibiz/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@amisibiz/ui/dialog";
import { Loader2 } from "lucide-react";
import { archiveItemAction } from "@/server/actions/item";
import { ARCHIVE_REASON_MAX } from "@/lib/validations/catalogue";

/**
 * Archive an item with an optional reason.
 *
 * ARCHIVED is the terminal catalogue state: the item stops being selectable for
 * new document lines but every historical line keeps its snapshot, which is why
 * archiving is offered instead of deletion for anything already invoiced. The
 * reason is a free-text note that rides along on the timeline event; it is
 * capped at the server's own limit and never invents a column that does not
 * exist (there is deliberately no `archivedAt` on `Item`).
 *
 * Requires `ITEMS_UPDATE` — the same permission `archiveItemAction` demands.
 */
interface ArchiveItemDialogProps {
  tenantId: string;
  itemId: string;
  itemName: string;
  onClose: () => void;
  onArchived: () => void;
}

export function ArchiveItemDialog({
  tenantId,
  itemId,
  itemName,
  onClose,
  onArchived,
}: ArchiveItemDialogProps) {
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length > ARCHIVE_REASON_MAX) {
      setError(`The reason is limited to ${ARCHIVE_REASON_MAX} characters.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await archiveItemAction({
        tenantId,
        itemId,
        reason: reason.trim(),
      });
      if (result.success) {
        onArchived();
        return;
      }
      // Only archived from ACTIVE: the server names the state it refused on.
      setError(result.error || "Failed to archive the item.");
    } catch {
      setError("Something went wrong while archiving the item.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive item</DialogTitle>
          <DialogDescription>
            Archiving “{itemName}” takes it out of the active catalogue and off
            the share pages. Documents that already used it keep their lines
            unchanged, and you can restore it later.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}

          <Field
            label="Reason"
            description="Optional note kept on the item's activity timeline."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={ARCHIVE_REASON_MAX}
              rows={3}
              placeholder="e.g. Discontinued by the supplier"
              disabled={isSubmitting}
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {isSubmitting ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
