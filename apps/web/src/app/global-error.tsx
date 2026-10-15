"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/error-tracking";

/**
 * Last-resort error boundary.
 *
 * `global-error.tsx` replaces the root layout when THAT fails, so it must render
 * its own `<html>`/`<body>` and cannot rely on the i18n provider, the theme, or
 * the global stylesheet (all of which live inside the tree that just threw). The
 * markup is therefore plain and inline-styled, and the copy is static English.
 *
 * Reporting goes through the same `reportError` boundary as the locale boundary,
 * so a root-layout failure is visible in the same log stream as any other.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { scope: "route:global" });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1rem",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "28rem",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "0.75rem",
            padding: "1.5rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.125rem" }}>
            Something went wrong
          </h1>
          <p
            style={{
              margin: "0 0 1rem",
              color: "#475569",
              fontSize: "0.875rem",
            }}
          >
            The application hit an unexpected error. Nothing you saved was lost.
            Try again, and if it keeps happening contact support with the
            reference below.
          </p>
          {error.digest ? (
            <p
              style={{
                margin: "0 0 1rem",
                fontFamily: "monospace",
                fontSize: "0.75rem",
                color: "#64748b",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              borderRadius: "0.5rem",
              border: "1px solid #0f172a",
              background: "#0f172a",
              color: "#ffffff",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
