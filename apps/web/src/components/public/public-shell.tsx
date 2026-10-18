import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Mobile-first shell for the public `/s/<token>` pages.
 *
 * Deliberately dumb: a single column, readable measure, and the business's own
 * brand fields (name/logo) when the public payload carried them. No session, no
 * workspace chrome, no tenant identifiers in the markup.
 */
export function PublicShell({
  children,
  brandName,
  brandLogoUrl,
  className,
}: {
  children: React.ReactNode;
  brandName?: string | undefined;
  brandLogoUrl?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn("min-h-dvh bg-background text-foreground", className)}>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:py-12">
        <header className="flex items-center gap-3">
          {brandLogoUrl ? (
            // Plain <img>: the blob host is not in next.config's image allow-list,
            // and a missing logo never becomes a placeholder.
            <img
              src={brandLogoUrl}
              alt={brandName ? `${brandName} logo` : "Business logo"}
              className="h-10 w-10 rounded object-contain"
            />
          ) : null}
          {brandName ? (
            <p className="text-sm font-semibold text-foreground">{brandName}</p>
          ) : null}
        </header>

        <main className="space-y-6">{children}</main>

        <footer className="border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            This page was shared with you by the business above. It does not
            require an account.
          </p>
        </footer>
      </div>
    </div>
  );
}
