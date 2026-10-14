import type { z } from "zod";
import { meetsContrastMinimum } from "@amisibiz/domain";
import { brandingFieldsSchema } from "@/lib/validations/branding";

/**
 * Branding write payload built from validated fields only.
 *
 * Lives outside the `"use server"` action modules because both writers — the
 * workspace's own `updateTenantBrandingAction` and the provider console's
 * `updateTenantBrandingForTenantAction` — have to produce exactly the same row,
 * and a module that exports a non-async helper cannot be a Server Action file.
 * If the two ever diverged, a provider-set branding row and a self-service-set
 * one would mean different things to the same document template.
 */

/**
 * Free-text fields treat an empty string as "clear this value" — that is the
 * only way to remove a website or footer previously saved. Colour, currency and
 * layout fields are never nullable (the row keeps a documented default), so an
 * empty value there is a validation failure rather than a silent reset.
 */
export type BrandingPatch = {
  displayName?: string | null;
  registeredName?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  primaryForeground?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  postalAddress?: string | null;
  physicalAddress?: string | null;
  website?: string | null;
  taxPin?: string | null;
  currency?: string;
  defaultFooter?: string | null;
  paymentInstructions?: string | null;
  documentLayout?: "standard" | "compact" | "detailed";
};

export function toBrandingPatch(
  data: z.infer<typeof brandingFieldsSchema>,
): BrandingPatch {
  const clearable = (value: string | undefined): string | null =>
    value === undefined ? null : value.trim() || null;

  const patch: BrandingPatch = {};

  if (data.displayName !== undefined)
    patch.displayName = clearable(data.displayName);
  if (data.registeredName !== undefined)
    patch.registeredName = clearable(data.registeredName);
  if (data.primaryColor !== undefined) patch.primaryColor = data.primaryColor;
  if (data.secondaryColor !== undefined)
    patch.secondaryColor = data.secondaryColor;
  if (data.accentColor !== undefined) patch.accentColor = data.accentColor;
  if (data.primaryForeground !== undefined)
    patch.primaryForeground = data.primaryForeground;
  if (data.contactEmail !== undefined)
    patch.contactEmail = clearable(data.contactEmail?.toLowerCase());
  if (data.contactPhone !== undefined)
    patch.contactPhone = clearable(data.contactPhone);
  if (data.postalAddress !== undefined)
    patch.postalAddress = clearable(data.postalAddress);
  if (data.physicalAddress !== undefined)
    patch.physicalAddress = clearable(data.physicalAddress);
  if (data.website !== undefined) {
    // Only an absolute http(s) URL survived validation; anything else (e.g.
    // `javascript:`) was rejected by the schema.
    patch.website = data.website.trim() || null;
  }
  if (data.taxPin !== undefined) patch.taxPin = clearable(data.taxPin);
  if (data.currency !== undefined) patch.currency = data.currency;
  if (data.defaultFooter !== undefined)
    patch.defaultFooter = clearable(data.defaultFooter);
  if (data.paymentInstructions !== undefined)
    patch.paymentInstructions = clearable(data.paymentInstructions);
  if (data.documentLayout !== undefined)
    patch.documentLayout = data.documentLayout;

  return patch;
}

/**
 * Contrast is a server-side rule, not just a form rule, so that a direct call
 * with unreadable colours is refused whoever made it. Only checked when both
 * sides of the pair are present in this patch — a partial patch that changes one
 * colour cannot be judged without the stored other half.
 */
export function contrastProblemFor(
  data: z.infer<typeof brandingFieldsSchema>,
): string | null {
  if (!data.primaryColor || !data.primaryForeground) return null;
  if (meetsContrastMinimum(data.primaryColor, data.primaryForeground)) {
    return null;
  }
  return "Insufficient contrast between primary colour and foreground. Minimum 4.5:1 required.";
}
