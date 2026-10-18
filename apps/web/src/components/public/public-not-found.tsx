import * as React from "react";
import { PublicShell } from "./public-shell";

/**
 * The one face every dead public link shows: unknown, revoked, expired,
 * malformed, wrong-kind or a vanished target.
 *
 * The copy is deliberately neutral — it neither confirms that a token once
 * existed nor repeats anything the request carried, so a probe learns nothing.
 */
export function PublicNotFound() {
  return (
    <PublicShell>
      <section
        aria-labelledby="public-not-found-heading"
        className="rounded-lg border border-dashed border-border bg-card p-6 text-center"
      >
        <h1
          id="public-not-found-heading"
          className="text-lg font-semibold text-foreground"
        >
          This page isn&apos;t available
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The link you followed may have been withdrawn, may have expired, or
          may be incomplete.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          If you were expecting to see a quote, a form or an order update,
          please ask the business to send a current link.
        </p>
      </section>
    </PublicShell>
  );
}
