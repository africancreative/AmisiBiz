import type { CSSProperties } from "react";
import { contrastRatio } from "@amisibiz/domain";

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
  /** Supporting colour for secondary document elements (headers, rules). */
  secondaryColor?: string | undefined;
  /** Accent colour used for highlights on documents. */
  accentColor: string;
  /** Foreground colour placed on top of the primary colour. */
  primaryForeground: string;
  /** Optional logo URL (Supabase Storage or similar). */
  logoUrl?: string | null | undefined;
};

/**
 * Defaults carry no optional members: every colour is present, so a consumer
 * never has to branch on "is there a fallback?". `Required<>` alone would not
 * do it — it strips the `?` but keeps `| undefined` — so the undefined is
 * removed explicitly instead. `logoUrl` stays nullable because "no logo" is a
 * real state rather than a default colour.
 */
export type TenantBrandingDefaults = {
  [Key in keyof TenantBranding]-?: Exclude<TenantBranding[Key], undefined>;
};

export const DEFAULT_TENANT_BRANDING: TenantBrandingDefaults = {
  displayName: "",
  primaryColor: "#1d4ed8",
  secondaryColor: "#1e3a5f",
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
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const LIGHT_FOREGROUND = DEFAULT_TENANT_BRANDING.primaryForeground;
const DARK_FOREGROUND = "#0f172a";

/**
 * Unrecognised colour text must never reach the DOM. Branding writes are
 * validated server-side, but a row that predates that rule still has to render
 * safely, so anything malformed falls back to the documented default.
 */
function safeHex(value: string | null | undefined, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
}

/**
 * Picks whichever standard foreground reads better on `background`.
 *
 * `accentColor` has no matching tenant setting, so its foreground is derived
 * rather than echoing the background (which would render invisible text).
 */
function readableForeground(background: string): string {
  const light = contrastRatio(background, LIGHT_FOREGROUND) ?? 1;
  const dark = contrastRatio(background, DARK_FOREGROUND) ?? 1;
  return light >= dark ? LIGHT_FOREGROUND : DARK_FOREGROUND;
}

export function tenantCssVariables(
  branding: TenantBranding = DEFAULT_TENANT_BRANDING,
): CSSProperties {
  const primary = safeHex(
    branding.primaryColor,
    DEFAULT_TENANT_BRANDING.primaryColor,
  );
  const secondary = safeHex(
    branding.secondaryColor,
    DEFAULT_TENANT_BRANDING.secondaryColor,
  );
  const accent = safeHex(
    branding.accentColor,
    DEFAULT_TENANT_BRANDING.accentColor,
  );
  const primaryForeground = safeHex(
    branding.primaryForeground,
    DEFAULT_TENANT_BRANDING.primaryForeground,
  );

  return {
    "--tenant-primary": hexToHslChannels(primary),
    "--tenant-primary-foreground": hexToHslChannels(primaryForeground),
    "--tenant-secondary": hexToHslChannels(secondary),
    "--tenant-accent": hexToHslChannels(accent),
    "--tenant-accent-foreground": hexToHslChannels(readableForeground(accent)),
  } as CSSProperties;
}
