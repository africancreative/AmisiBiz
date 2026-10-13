import { z } from "zod";

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Must be a valid hex colour (e.g. #1d4ed8)")
  .transform((v) => v.toLowerCase());

export const updateTenantBrandingSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  displayName: z.string().max(100, "Display name too long").optional(),
  registeredName: z.string().max(200, "Registered name too long").optional(),
  primaryColor: hexColorSchema.optional(),
  secondaryColor: hexColorSchema.optional(),
  accentColor: hexColorSchema.optional(),
  primaryForeground: hexColorSchema.optional(),
  contactEmail: z.string().email("Invalid email address").max(254).optional().or(z.literal("")),
  contactPhone: z.string().max(50).optional().or(z.literal("")),
  postalAddress: z.string().max(500).optional().or(z.literal("")),
  physicalAddress: z.string().max(500).optional().or(z.literal("")),
  website: z.string().url("Invalid URL").max(254).optional().or(z.literal("")),
  taxPin: z.string().max(50).optional().or(z.literal("")),
  currency: z.string().length(3, "Currency must be a 3-letter ISO code").optional(),
  defaultFooter: z.string().max(1000).optional().or(z.literal("")),
  paymentInstructions: z.string().max(2000).optional().or(z.literal("")),
  documentLayout: z.enum(["standard", "compact", "detailed"]).optional(),
});

export type UpdateTenantBrandingInput = z.infer<typeof updateTenantBrandingSchema>;

export const logoUploadSchema = z.object({
  tenantId: z.string().cuid("Invalid tenant ID"),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive().max(5 * 1024 * 1024, "File size must not exceed 5 MB"),
  fileType: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
  width: z.number().int().positive().max(2000, "Image width must not exceed 2000px"),
  height: z.number().int().positive().max(2000, "Image height must not exceed 2000px"),
});

export type LogoUploadInput = z.infer<typeof logoUploadSchema>;