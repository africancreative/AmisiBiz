import { z } from "zod";
import { isValidSlug } from "@/lib/tenancy/host";

// Roles that may be granted through invitation / role-change actions.
// TENANT_OWNER is deliberately excluded: ownership transfer is not a routine
// operation and must not be reachable via these actions.
export const assignableTenantRoleSchema = z.enum([
  "TENANT_ADMIN",
  "SALES",
  "FINANCE",
  "OPERATIONS",
  "VIEWER",
  "CUSTOMER_PORTAL_USER",
]);

export const createTenantSchema = z.object({
  name: z
    .string()
    .min(2, "Organisation name must be at least 2 characters")
    .max(100, "Name too long")
    .trim(),
  slug: z
    .string()
    .min(2, "Slug must be at least 2 characters")
    .max(50, "Slug too long")
    .regex(
      /^[a-z0-9-]+$/,
      "Slug may only contain lowercase letters, numbers, and hyphens",
    )
    .transform((v) => v.toLowerCase().trim()),
  country: z
    .string()
    .length(2, "Country must be a 2-letter ISO code")
    .optional(),
  currency: z
    .string()
    .length(3, "Currency must be a 3-letter ISO code")
    .default("USD"),
  timezone: z.string().default("UTC"),
});

export const updateTenantSchema = createTenantSchema
  .omit({ slug: true })
  .partial();

// Platform-operator provisioning input. The owner is invited by email and must
// accept the invitation — an owner is never assigned from this email alone.
export const platformCreateTenantSchema = z.object({
  name: z
    .string()
    .min(2, "Organisation name must be at least 2 characters")
    .max(100, "Name too long")
    .trim(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .refine((v) => v === undefined || isValidSlug(v), {
      message:
        "Slug must be 2-63 lowercase letters, numbers or hyphens and not a reserved name",
    }),
  ownerEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address")
    .optional(),
  country: z
    .string()
    .length(2, "Country must be a 2-letter ISO code")
    .optional(),
  currency: z
    .string()
    .length(3, "Currency must be a 3-letter ISO code")
    .default("USD"),
  timezone: z.string().default("UTC"),
  locale: z.enum(["en", "fr", "sw"]).default("en"),
});

// The lifecycle input shapes moved to `@/lib/validations/platform-tenant` with
// Phase 2, where EVERY transition requires a recorded reason. A
// suspension-only reason rule used to imply activation and reactivation were
// unexplained, which is exactly what a status history must never be.

export type PlatformCreateTenantInput = z.infer<
  typeof platformCreateTenantSchema
>;

export const inviteMemberSchema = z.object({
  email: z.string().min(1).trim().toLowerCase().email("Invalid email address"),
  role: assignableTenantRoleSchema,
  tenantId: z.string().uuid("Invalid tenant ID"),
});

export const updateMemberRoleSchema = z.object({
  memberId: z.string().uuid("Invalid member ID"),
  role: assignableTenantRoleSchema,
  tenantId: z.string().uuid("Invalid tenant ID"),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
