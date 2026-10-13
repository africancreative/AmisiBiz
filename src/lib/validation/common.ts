import { z } from "zod";

/**
 * Shared Zod validation utilities.
 *
 * Reuse these primitives across every form, Server Action and API route so
 * validation rules (email normalisation, password policy, ids, pagination)
 * stay consistent across the whole product.
 */

/** Trimmed, lower-cased, validated email address. */
export const emailSchema = z
  .string()
  .min(1, "Email is required")
  .trim()
  .toLowerCase()
  .email("Please enter a valid email address");

/** Display name: 2–100 characters, trimmed. */
export const nameSchema = z
  .string()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name too long")
  .trim();

/**
 * Password policy: 8–128 characters with at least one uppercase letter, one
 * lowercase letter and one digit.
 */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password too long")
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    "Password must contain at least one uppercase letter, one lowercase letter, and one number",
  );

/** Opaque non-empty identifier (cuid/uuid/token). */
export const idSchema = z.string().min(1, "Identifier is required");

/** URL-safe slug. */
export const slugSchema = z
  .string()
  .min(1, "Slug is required")
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format");

/** Positive integer query parameter with a default and a sane upper bound. */
export const pageSizeSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20);

export const pageSchema = z.coerce.number().int().min(1).default(1);

export const paginationSchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Wraps a schema so `undefined`/`null` optional fields tolerate empty strings
 * from `<input>` elements (which browsers submit as `""`).
 */
export function optionalString<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    schema.optional(),
  );
}

/**
 * Confirms two fields match; returns a `refine`-style check usable on a Zod
 * object schema with `path` pointing at the confirmation field.
 */
export const passwordsMatch = {
  message: "Passwords do not match",
  path: ["confirmPassword"] as const,
};
