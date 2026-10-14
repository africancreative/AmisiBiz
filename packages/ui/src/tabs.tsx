"use client";

import * as React from "react";
import { cn } from "./utils";

/**
 * Accessible tabs.
 *
 * The previous version rendered static shells: `TabsTrigger` read an undeclared
 * `value` and `TabsContent` kept everything hidden, so a caller looked like it
 * had tabs while only the first panel was ever reachable. This implementation
 * owns the selected value in context, wires `role="tablist"`/`role="tab"`/
 * `role="tabpanel"`, `aria-selected`/`aria-controls`, keyboard Left/Right/Home/
 * End navigation, and honours both uncontrolled (`defaultValue`) and controlled
 * (`value` + `onValueChange`) usage.
 */

type TabsContextValue = {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(caller: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`${caller} must be rendered inside <Tabs>`);
  }
  return context;
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  (
    { children, className, defaultValue, value, onValueChange, ...props },
    ref,
  ) => {
    const baseId = React.useId();
    const [uncontrolled, setUncontrolled] = React.useState(
      () => value ?? defaultValue ?? "",
    );

    // Controlled when `value` is provided; otherwise internal state wins.
    const current = value !== undefined ? value : uncontrolled;

    const setValue = React.useCallback(
      (next: string) => {
        if (value === undefined) setUncontrolled(next);
        onValueChange?.(next);
      },
      [value, onValueChange],
    );

    const context = React.useMemo<TabsContextValue>(
      () => ({ value: current, setValue, baseId }),
      [current, setValue, baseId],
    );

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      const triggers = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>("[role='tab']"),
      ).filter((node) => !node.hasAttribute("disabled"));
      if (triggers.length === 0) return;

      const selectedIndex = triggers.findIndex(
        (node) => node.dataset.value === current,
      );
      const last = triggers.length - 1;
      let nextIndex: number | null = null;

      switch (event.key) {
        case "ArrowRight":
          nextIndex =
            selectedIndex < 0 ? 0 : (selectedIndex + 1) % triggers.length;
          break;
        case "ArrowLeft":
          nextIndex =
            selectedIndex < 0
              ? last
              : (selectedIndex - 1 + triggers.length) % triggers.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = last;
          break;
        default:
          return;
      }

      event.preventDefault();
      const target = triggers[nextIndex];
      if (!target) return;
      const nextValue = target.dataset.value;
      if (nextValue) setValue(nextValue);
      target.focus();
    };

    return (
      <TabsContext.Provider value={context}>
        <div
          ref={ref}
          className={cn("space-y-4", className)}
          onKeyDown={onKeyDown}
          {...props}
        >
          {children}
        </div>
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = "Tabs";

type TabsListProps = React.HTMLAttributes<HTMLDivElement>;

const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      role="tablist"
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);
TabsList.displayName = "TabsList";

export interface TabsTriggerProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "value"
> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, disabled, children, ...props }, ref) => {
    const { value: selected, setValue, baseId } = useTabs("TabsTrigger");
    const isActive = selected === value;

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={`${baseId}-trigger-${value}`}
        aria-selected={isActive}
        aria-controls={`${baseId}-panel-${value}`}
        data-state={isActive ? "active" : "inactive"}
        data-value={value}
        disabled={disabled}
        tabIndex={isActive ? 0 : -1}
        onClick={() => setValue(value)}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  forceMount?: boolean;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, forceMount, children, ...props }, ref) => {
    const { value: selected, baseId } = useTabs("TabsContent");
    const isActive = selected === value;

    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`${baseId}-panel-${value}`}
        aria-labelledby={`${baseId}-trigger-${value}`}
        hidden={!isActive && !forceMount}
        className={cn(
          "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          className,
        )}
        {...props}
      >
        {isActive || forceMount ? children : null}
      </div>
    );
  },
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
