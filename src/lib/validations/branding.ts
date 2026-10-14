import { z } from "zod";
import { SUPPORTED_CURRENCIES, currencySchema } from "@/lib/validation/common";

/**
 * Branding validation.
 *
 * Colours are restricted to 6-digit hex so they can only ever reach the DOM as
 * a CSS custom-property *value* (see `TenantTheme`); no free-form CSS or HTML is
 * accepted anywhere in branding, so a tenant cannot inject markup or stylesheet
 * text into its own documents — and never into the shared admin chrome.
 */
const hexColorRegex = /^#[0-9a-fA-F]{6}$/;

const hexColorSchema = z
  .string()
  .regex(hexColorRegex, "Must be a valid hex colour (e.g. #1d4ed8)")
  .transform((v) => v.toLowerCase());

/** Form-facing colour rule: same constraint, no transform, so the value the
 *  user typed is exactly the value react-hook-form keeps. */
export const hexColorFormSchema = z
  .string()
  .regex(hexColorRegex, "Must be a valid hex colour (e.g. #1d4ed8)");

const WEBSITE_REGEX = /^https?:\/\/[^\s]+$/;

/** Absolute http(s) URL — rejects `javascript:`/`data:` schemes outright. */
const websiteSchema = z
  .string()
  .trim()
  .max(254)
  .refine((value) => value === "" || WEBSITE_REGEX.test(value), {
    message: "Website must start with http:// or https://",
  });

/** Same rule without a transform, for form state. Empty means "no website". */
export const websiteFormSchema = z
  .union([
    z.literal(""),
    z
      .string()
      .trim()
      .max(254, "Website is too long")
      .regex(WEBSITE_REGEX, "Website must start with http:// or https://"),
  ])
  .optional();

const optionalText = (max: number) =>
  z.string().max(max).optional().or(z.literal(""));

export const DOCUMENT_LAYOUTS = ["standard", "compact", "detailed"] as const;
export type DocumentLayout = (typeof DOCUMENT_LAYOUTS)[number];
export const documentLayoutFormSchema = z.enum(DOCUMENT_LAYOUTS);

/**
 * The branding fields an authorized business admin may set. Shared by the form
 * and the server action so the two can never drift apart.
 */
export const brandingFieldsSchema = z.object({
  displayName: optionalText(100),
  registeredName: optionalText(200),
  primaryColor: hexColorSchema.optional(),
  secondaryColor: hexColorSchema.optional(),
  accentColor: hexColorSchema.optional(),
  primaryForeground: hexColorSchema.optional(),
  contactEmail: z
    .string()
    .email("Invalid email address")
    .max(254)
    .optional()
    .or(z.literal("")),
  contactPhone: optionalText(50),
  postalAddress: optionalText(500),
  physicalAddress: optionalText(500),
  website: websiteSchema.optional(),
  taxPin: optionalText(50),
  currency: currencySchema.optional(),
  defaultFooter: optionalText(1000),
  paymentInstructions: optionalText(2000),
  documentLayout: documentLayoutFormSchema.optional(),
});

export const updateTenantBrandingSchema = brandingFieldsSchema.extend({
  tenantId: z.string().cuid("Invalid tenant ID"),
});

export type UpdateTenantBrandingInput = z.infer<
  typeof updateTenantBrandingSchema
>;
export type BrandingFieldsInput = z.infer<typeof brandingFieldsSchema>;

/**
 * Form schema for the branding screen.
 *
 * The server action accepts a *partial* patch (`brandingFieldsSchema`) because
 * it must stay safe to call with only the section being edited; the form always
 * submits the whole document-branding record, so its colours, currency and
 * layout are required and carry no transforms. Keeping both built from the same
 * primitives means the UI can never accept a value the server would reject.
 */
export const brandingFormSchema = z.object({
  displayName: optionalText(100),
  registeredName: optionalText(200),
  primaryColor: hexColorFormSchema,
  secondaryColor: hexColorFormSchema,
  accentColor: hexColorFormSchema,
  primaryForeground: hexColorFormSchema,
  contactEmail: z
    .string()
    .email("Invalid email address")
    .max(254)
    .optional()
    .or(z.literal("")),
  contactPhone: optionalText(50),
  postalAddress: optionalText(500),
  physicalAddress: optionalText(500),
  website: websiteFormSchema,
  taxPin: optionalText(50),
  currency: z.enum(SUPPORTED_CURRENCIES),
  defaultFooter: optionalText(1000),
  paymentInstructions: optionalText(2000),
  documentLayout: documentLayoutFormSchema,
});

export type BrandingFormValues = z.infer<typeof brandingFormSchema>;

export const BRANDING_DEFAULT_VALUES: BrandingFormValues = {
  displayName: "",
  registeredName: "",
  primaryColor: "#1d4ed8",
  secondaryColor: "#1e3a5f",
  accentColor: "#f59e0b",
  primaryForeground: "#f8fafc",
  contactEmail: "",
  contactPhone: "",
  postalAddress: "",
  physicalAddress: "",
  website: "",
  taxPin: "",
  currency: "KES",
  defaultFooter: "",
  paymentInstructions: "",
  documentLayout: "standard",
};

/**
 * Logo uploads: raster formats only.
 *
 * SVG is deliberately unsupported — an SVG is a scripting-capable document, and
 * serving tenant-supplied SVG from the application origin would let stored
 * scripts run against other workspace users. The upload route additionally
 * verifies magic bytes and pixel dimensions from the file content, so neither
 * the extension nor the declared MIME type is trusted.
 */
export const LOGO_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export const LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const LOGO_MAX_DIMENSION_PX = 2000;

const logoMimeTypeSchema = z.enum(LOGO_ALLOWED_MIME_TYPES);

export const logoUploadSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  fileName: z.string().min(1).max(255),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(LOGO_MAX_BYTES, `File size must not exceed ${LOGO_MAX_BYTES} bytes`),
  fileType: logoMimeTypeSchema,
  width: z
    .number()
    .int()
    .positive()
    .max(
      LOGO_MAX_DIMENSION_PX,
      `Image width must not exceed ${LOGO_MAX_DIMENSION_PX}px`,
    ),
  height: z
    .number()
    .int()
    .positive()
    .max(
      LOGO_MAX_DIMENSION_PX,
      `Image height must not exceed ${LOGO_MAX_DIMENSION_PX}px`,
    ),
});

export type LogoUploadInput = z.infer<typeof logoUploadSchema>;
export { logoMimeTypeSchema };
