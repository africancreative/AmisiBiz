import type { CSSProperties } from "react";

/**
 * Branding tokens for AmisiBiz.
 *
 * Two independent layers live here:
 *
 *  - PROVIDER branding  — Amisi Genuine Enterprises. Fixed; blue and gold.
 *    Drives the product UI (navigation, buttons, platform admin).
 *  - TENANT branding    — configured per business for that business's own
 *    documents (letterheads, invoices, quotes). Never changes provider chrome.
 */

/* ---------------------------------- Provider --------------------------------- */

export const PROVIDER_BRAND = {
  name: "AmisiBiz",
  provider: "Amisi Genuine Enterprises",
  tagline: "Business, Simplified.",
  colors: {
    blue: "#1d4ed8",
    gold: "#f59e0b",
  },
  logo: "/brand/amisi-genuine-logo.png",
  documentFooter:
    "Powered by AmisiBiz — a product of Amisi Genuine Enterprises.",
} as const;

/* ----------------------------------- Tenant ---------------------------------- */

export type TenantBranding = {
  /** Brand/display name shown on the tenant's documents. */
  displayName: string;
  /** Primary document colour, as a hex value (e.g. "#0f766e"). */
  primaryColor: string;
  /** Accent colour used for highlights on documents. */
  accentColor: string;
  /** Foreground colour placed on top of the primary colour. */
  primaryForeground: string;
  /** Optional logo URL (Supabase Storage or similar). */
  logoUrl?: string | null;
};

export const DEFAULT_TENANT_BRANDING: TenantBranding = {
  displayName: "",
  primaryColor: "#1d4ed8",
  accentColor: "#f59e0b",
  primaryForeground: "#f8fafc",
  logoUrl: null,
};

/**
 * Converts a hex colour to an HSL channel triplet ("H S% L%") so it can feed
 * Tailwind's `hsl(var(--token) / <alpha-value>)` colour functions.
 */
export function hexToHslChannels(hex: string): string {
  const normalised = hex.replace("#", "");
  const full =
    normalised.length === 3
      ? normalised
          .split("")
          .map((c) => c + c)
          .join("")
      : normalised;

  const int = parseInt(full, 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/**
 * Produces the inline CSS custom properties that apply a tenant's branding to
 * a subtree. Applied by the workspace shell — never on the provider UI chrome.
 */
export function tenantCssVariables(
  branding: TenantBranding = DEFAULT_TENANT_BRANDING,
): CSSProperties {
  return {
    "--tenant-primary": hexToHslChannels(branding.primaryColor),
    "--tenant-primary-foreground": hexToHslChannels(branding.primaryForeground),
    "--tenant-accent": hexToHslChannels(branding.accentColor),
    "--tenant-accent-foreground": hexToHslChannels(branding.accentColor),
  } as CSSProperties;
}
