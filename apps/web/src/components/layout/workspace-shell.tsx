import * as React from "react";
import { NavLinks, type NavItem } from "./nav-links";
import { MobileNav } from "./mobile-nav";
import { PROVIDER_BRAND } from "@/lib/branding/tokens";

/**
 * Shared chrome for authenticated business workspaces (`/app/*`).
 * Desktop: fixed sidebar. Mobile: top bar + slide-over drawer.
 */
export function WorkspaceShell({
  brand,
  items,
  headerRight,
  footer,
  children,
}: {
  brand: React.ReactNode;
  items: NavItem[];
  headerRight?: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-16 items-center gap-2 border-b border-border px-4">
          {brand}
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <NavLinks items={items} />
        </div>
        <div className="border-t border-border p-4 text-sm">{footer}</div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-card/90 px-4 backdrop-blur lg:justify-end">
          <MobileNav items={items} title={brand} footer={footer} />
          <div className="flex-1 lg:hidden">{brand}</div>
          {headerRight}
        </header>

        <main id="main" className="flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>

        <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted-foreground">
          {PROVIDER_BRAND.documentFooter}
        </footer>
      </div>
    </div>
  );
}
