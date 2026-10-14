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

/**
 * Currencies AmisiBiz writes amounts in. Phase 04 supports KES only; the list is
 * the single source of truth, so enabling another ISO 4217 code is a one-line
 * change here plus the corresponding tenant/document rollout.
 */
export const SUPPORTED_CURRENCIES = ["KES"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: SupportedCurrency = "KES";

/**
 * Display labels for the supported codes, kept beside the list so a currency
 * cannot be enabled without a human-readable name in the UI.
 */
export const CURRENCY_LABELS: Record<SupportedCurrency, string> = {
  KES: "KES - Kenyan Shilling",
};

/** Narrows arbitrary stored text to a supported currency, else the default. */
export function toSupportedCurrency(value: string): SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
    ? (value as SupportedCurrency)
    : DEFAULT_CURRENCY;
}

/** ISO 4217 code restricted to the supported set. */
export const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine(
    (value): value is SupportedCurrency =>
      (SUPPORTED_CURRENCIES as readonly string[]).includes(value),
    `Unsupported currency. Supported: ${SUPPORTED_CURRENCIES.join(", ")}`,
  );

/**
 * Monetary and rate inputs as decimal **strings**.
 *
 * Authoritative amounts are never parsed through a JS `number`: the string goes
 * straight into `Decimal` / PostgreSQL `numeric`, so totals stay exact. The
 * optional `maxPlaces` mirrors the column scale (4 for amounts, 2 for
 * percentages).
 */
export function decimalStringSchema(maxPlaces = 4) {
  const pattern = new RegExp(`^\\d+(\\.\\d{1,${maxPlaces}})?$`);
  return z.string().regex(pattern, {
    message: `Must be a decimal string with up to ${maxPlaces} decimal places`,
  });
}

/** A non-negative money amount (major units, up to 4 decimal places). */
export const moneySchema = decimalStringSchema(4).refine(
  (value) => Number(value) < 1e12,
  "Amount is too large",
);

/** A percentage between 0 and 100 inclusive (up to 2 decimal places). */
export const percentSchema = decimalStringSchema(2).refine(
  (value) => Number(value) <= 100,
  "Must be between 0 and 100",
);

/** A tax rate fraction between 0 and 1 inclusive (up to 4 decimal places). */
export const taxRateFractionSchema = decimalStringSchema(4).refine(
  (value) => Number(value) <= 1,
  "Rate must be between 0 and 1 (e.g. 0.16 for 16%)",
);
