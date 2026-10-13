import * as React from "react";
import {
  type TenantBranding,
  DEFAULT_TENANT_BRANDING,
  tenantCssVariables,
} from "@/lib/branding/tokens";

/**
 * Applies a tenant's branding tokens to a subtree. Use ONLY around tenant-owned
 * artefacts (document previews, letterheads, invoices) — never around provider
 * product chrome.
 */
export function TenantTheme({
  branding = DEFAULT_TENANT_BRANDING,
  className,
  children,
}: {
  branding?: TenantBranding;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-tenant-theme
      className={className}
      style={tenantCssVariables(branding)}
    >
      {children}
    </div>
  );
}
