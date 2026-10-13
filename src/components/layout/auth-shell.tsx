import * as React from "react";
import { PROVIDER_BRAND } from "@/lib/branding/tokens";

/**
 * Shared, centred layout for all authentication screens (sign-in, register,
 * password recovery, email verification). Uses provider branding only.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={PROVIDER_BRAND.logo}
            alt={`${PROVIDER_BRAND.provider} logo`}
            width={48}
            height={48}
            className="mb-3 h-12 w-12 rounded-md object-contain"
          />
          <p className="text-sm font-semibold text-brand-700">
            {PROVIDER_BRAND.name}
          </p>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {children}
        </div>
        {footer ? (
          <div className="mt-6 text-center text-sm text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </div>
    </main>
  );
}
