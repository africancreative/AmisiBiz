import * as React from "react";
import {
  StatusIndicator,
  type StatusTone,
} from "@amisibiz/ui/status-indicator";
import { formatMoney } from "@amisibiz/documents";
import type { PublicOrderStatus } from "@/lib/public-share";
import { PublicShell } from "./public-shell";

/**
 * Public ORDER_STATUS page (`GET /api/public/order/<token>` payload).
 *
 * Exactly four facts, all of them the payload's own: the order number, its
 * status, the total with the currency the order carries, and delivery progress
 * DERIVED from the line counters the function already reduced to
 * `quantity / deliveredQuantity / deliveredRatio / fullyDelivered`. Nothing
 * else is shown or implied: no tracking, no availability, no payment gateway
 * confirmation, no customer details, and no lines (the function never sends
 * them). A DRAFT order can never reach this page — the function refuses it, so
 * anything rendered here has been issued by the business.
 */

const STATUS_LABELS: Record<string, string> = {
  ISSUED: "Issued",
  PARTIALLY_PAID: "Partly paid",
  PAID: "Paid",
  OVERDUE: "Overdue",
  CANCELLED: "Cancelled",
  VOID: "Voided",
};

const STATUS_TONES: Record<string, StatusTone> = {
  ISSUED: "info",
  PARTIALLY_PAID: "warning",
  PAID: "success",
  OVERDUE: "danger",
  CANCELLED: "neutral",
  VOID: "neutral",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

/**
 * A quantity as text, with the stored 4-dp padding trimmed. String-only: a
 * quantity is never run through floating point here.
 */
function decimalLabel(value: string): string {
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  const [whole = "0", fraction = ""] = text.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

/**
 * A 0–1 ratio into a whole percentage for the bar and the label. Display-only
 * rounding of a ratio the server derived; no money is computed here.
 */
function ratioPercent(ratio: string): number | null {
  const numeric = Number(ratio);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, Math.round(numeric * 100)));
}

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString();
}

export function PublicOrderStatusView({ order }: { order: PublicOrderStatus }) {
  const percent = ratioPercent(order.deliveredRatio);
  const quantityLabel = decimalLabel(order.quantity);
  const deliveredLabel = decimalLabel(order.deliveredQuantity);
  const issuedOn = formatDate(order.issueDate);
  const dueOn = formatDate(order.dueDate);

  const progressText = order.fullyDelivered
    ? "All units have been delivered."
    : percent === null
      ? `Delivered ${deliveredLabel} of ${quantityLabel} units.`
      : `Delivered ${deliveredLabel} of ${quantityLabel} units (${percent}%).`;

  return (
    <PublicShell>
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Order update</p>
        <h1 className="text-2xl font-semibold">
          Order <span className="font-mono">{order.number}</span>
        </h1>
      </div>

      <section
        aria-labelledby="order-status-heading"
        className="rounded-lg border border-border bg-card p-4 space-y-4"
      >
        <div
          id="order-status-heading"
          className="flex items-center justify-between gap-3"
        >
          <h2 className="text-sm font-semibold">Status</h2>
          <StatusIndicator tone={STATUS_TONES[order.status] ?? "neutral"}>
            {statusLabel(order.status)}
          </StatusIndicator>
        </div>

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Total</dt>
            <dd className="font-mono text-base font-semibold">
              {/* Currency is the order's own; the amount is the stored decimal. */}
              {formatMoney(order.total, order.currency)}
            </dd>
          </div>
          {issuedOn ? (
            <div>
              <dt className="text-muted-foreground">Issued</dt>
              <dd>{issuedOn}</dd>
            </div>
          ) : null}
          {dueOn ? (
            <div>
              <dt className="text-muted-foreground">Payment due</dt>
              <dd>{dueOn}</dd>
            </div>
          ) : null}
        </dl>

        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">Delivery progress</h3>

          {percent === null ? (
            <p className="text-sm text-muted-foreground">
              This order has no recorded quantities yet, so delivery progress is
              not shown.
            </p>
          ) : (
            <>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={progressText}
                aria-labelledby="delivery-progress-label"
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={
                    order.fullyDelivered
                      ? "h-full bg-success"
                      : "h-full bg-primary"
                  }
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p id="delivery-progress-label" className="text-sm">
                {progressText}
              </p>
            </>
          )}
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Statuses and payments on this page are recorded by the business itself.
        This page does not take payment.
      </p>
    </PublicShell>
  );
}
