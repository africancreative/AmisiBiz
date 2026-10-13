"use client";

import * as React from "react";
import { NavLinks, type NavItem } from "./nav-links";
import { PanelLeftIcon } from "@/components/ui/icons";

/**
 * Mobile navigation drawer. Uses the native `<dialog>` element for focus
 * containment and Esc-to-close; the trigger exposes `aria-expanded`.
 */
export function MobileNav({
  items,
  title,
  footer,
}: {
  items: NavItem[];
  title: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Open navigation menu"
        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
      >
        <PanelLeftIcon />
      </button>

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        className="m-0 h-dvh max-h-none w-72 max-w-[85vw] bg-card p-0 text-card-foreground shadow-xl backdrop:bg-slate-900/40 lg:hidden"
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-border p-4">
            <p className="text-sm font-semibold">{title}</p>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <NavLinks items={items} onNavigate={() => setOpen(false)} />
          </div>
          {footer ? (
            <div className="border-t border-border p-4">{footer}</div>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
