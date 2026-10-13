import * as React from "react";
import Link from "next/link";
import { NavLinks, type NavItem } from "./nav-links";
import { MobileNav } from "./mobile-nav";
import { PROVIDER_BRAND } from "@/lib/branding/tokens";
import { Badge } from "@/components/ui/badge";

/**
 * Shared chrome for platform administration (`/admin/*`).
 * Visually distinct from tenant workspaces — this is provider territory.
 */
export function AdminShell({
  basePath,
  items,
  headerRight,
  footer,
  children,
}: {
  basePath: string;
  items: NavItem[];
  headerRight?: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const brand = (
    <Link
      href={basePath}
      className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={PROVIDER_BRAND.logo}
        alt=""
        width={28}
        height={28}
        className="h-7 w-7 rounded object-contain"
      />
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-foreground">
          {PROVIDER_BRAND.name}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-accent-foreground/70">
          Platform
        </span>
      </span>
    </Link>
  );

  return (
    <div className="min-h-screen bg-muted/40 lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-border bg-slate-900 text-slate-100 lg:flex">
        <div className="flex h-16 items-center border-b border-white/10 px-4">
          <div className="[&_a>span>span:first-child]:text-white">{brand}</div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 [&_a]:text-slate-300 [&_a:hover]:bg-white/10 [&_a:hover]:text-white [&_a[aria-current=page]]:bg-white/10 [&_a[aria-current=page]]:text-white">
          <NavLinks items={items} />
        </div>
        <div className="border-t border-white/10 p-4 text-sm text-slate-300">
          {footer}
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-card/90 px-4 backdrop-blur lg:justify-between">
          <div className="flex items-center gap-3">
            <MobileNav items={items} title={brand} footer={footer} />
            <span className="lg:hidden">
              <Badge tone="gold">Platform</Badge>
            </span>
          </div>
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
