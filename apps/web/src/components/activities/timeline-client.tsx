"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@amisibiz/ui/state";
import { getTimelineAction } from "@/server/actions/activity";
import { cn } from "@/lib/utils";
import { History, Loader2 } from "lucide-react";

/**
 * Unified activity timeline (read-only).
 *
 * The timeline is append-only and written solely server-side, so this panel
 * only ever calls `getTimelineAction`. "Load older" pages with the smallest
 * `occurredAt` already shown as the `before` cursor — the same way the server
 * query bounds it. Every surface (lead 360, customer 360) reuses this.
 */

type TimelineEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  source: string | null;
  payload?: unknown;
  actor?: { id: string; name: string | null; email: string | null } | null;
};

interface TimelinePanelProps {
  tenantId: string;
  leadId?: string | undefined;
  contactId?: string | undefined;
  documentId?: string | undefined;
  locale?: string | undefined;
  limit?: number | undefined;
  className?: string | undefined;
}

const PAGE_LIMIT = 50;

/** `LEAD_STAGE_MOVED` → "Lead stage moved"; unknown codes stay readable. */
function humanizeEventType(eventType: string): string {
  const lower = eventType.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function TimelinePanel({
  tenantId,
  leadId,
  contactId,
  documentId,
  locale = "en",
  limit = PAGE_LIMIT,
  className,
}: TimelinePanelProps) {
  const [events, setEvents] = React.useState<TimelineEvent[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);

  const fetchTimeline = React.useCallback(
    async (before?: Date) => {
      const result = await getTimelineAction({
        tenantId,
        ...(leadId ? { leadId } : {}),
        ...(contactId ? { contactId } : {}),
        ...(documentId ? { documentId } : {}),
        limit,
        ...(before ? { before } : {}),
      });
      return result;
    },
    [tenantId, leadId, contactId, documentId, limit],
  );

  const loadInitial = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchTimeline();
      if (!result.success) {
        setError(result.error || "Failed to load the timeline.");
        return;
      }
      if (result.data) {
        setEvents(result.data.events);
        setHasMore(result.data.events.length >= limit);
      }
    } catch {
      setError("Something went wrong while loading the timeline.");
    } finally {
      setIsLoading(false);
    }
  }, [fetchTimeline, limit]);

  React.useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const loadOlder = async () => {
    const oldest = events[events.length - 1];
    if (!oldest) return;
    setIsLoadingOlder(true);
    setError(null);
    try {
      const result = await fetchTimeline(new Date(oldest.occurredAt));
      if (!result.success) {
        setError(result.error || "Failed to load older events.");
        return;
      }
      if (!result.data) return;
      // Guard against a stale cursor re-appending the same page.
      const seen = new Set(events.map((event) => event.id));
      const older = result.data.events.filter((event) => !seen.has(event.id));
      setEvents((current) => [...current, ...older]);
      setHasMore(older.length >= limit);
    } catch {
      setError("Something went wrong while loading older events.");
    } finally {
      setIsLoadingOlder(false);
    }
  };

  if (isLoading) {
    return (
      <div className={className}>
        <LoadingState label="Loading timeline" />
      </div>
    );
  }

  if (error && events.length === 0) {
    return (
      <div className={className}>
        <ErrorState
          title="Timeline unavailable"
          description={error}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadInitial()}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title="No activity yet"
          description="Timeline events appear here as this record is created, worked, contacted, invoiced and merged."
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <ol className="space-y-4">
        {events.map((event) => (
          <li key={event.id} className="flex gap-3">
            <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <History className="h-4 w-4 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {humanizeEventType(event.eventType)}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(event.occurredAt).toLocaleString(locale)}
                {event.actor?.name
                  ? ` · ${event.actor.name}`
                  : event.actor?.email
                    ? ` · ${event.actor.email}`
                    : ""}
                {event.source ? ` · ${event.source}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {hasMore ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadOlder()}
          disabled={isLoadingOlder}
        >
          {isLoadingOlder ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : null}
          Load older
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">End of the timeline.</p>
      )}
    </div>
  );
}
