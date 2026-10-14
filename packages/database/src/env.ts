import { z } from "zod";

/**
 * Server-side environment for the database and Supabase clients.
 *
 * Access is intentionally LAZY — functions, never module-load validation —
 * so importing this module is always safe (including from tests that mock it
 * partially) and every failure names the exact variable that is missing or
 * invalid. `NEXT_PUBLIC_*` values are browser-safe by design;
 * `SUPABASE_SECRET_KEY` is a server-only credential that must never be
 * referenced from a client bundle.
 */

export const supabaseEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string()
    .trim()
    .min(1, "is required (Supabase project URL)")
    .url("must be a valid URL, e.g. https://<ref>.supabase.co"),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .trim()
    .min(1, "is required (browser-safe publishable key)"),
  SUPABASE_SECRET_KEY: z
    .string()
    .trim()
    .min(
      1,
      "is required (server-only secret key — never expose it to clients)",
    ),
});

export type SupabaseEnv = z.infer<typeof supabaseEnvSchema>;

/**
 * Every problem found in the Supabase environment, aggregated so a
 * misconfigured deployment reports all missing/invalid variables at once
 * instead of failing on the first one touched.
 */
export function collectSupabaseEnvProblems(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const parsed = supabaseEnvSchema.safeParse(env);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
}

/** Throws a single aggregated error when the Supabase environment is not valid. */
export function requireSupabaseEnv(
  env: Record<string, string | undefined> = process.env,
): SupabaseEnv {
  const problems = collectSupabaseEnvProblems(env);
  if (problems.length > 0) {
    throw new Error(
      [
        "Supabase environment is not configured correctly:",
        ...problems.map((problem) => `  - ${problem}`),
        "See .env.example for the full list of required variables.",
      ].join("\n"),
    );
  }
  return supabaseEnvSchema.parse(env);
}

function require(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `${name} is not configured. See .env.example for the full list of required variables.`,
    );
  }
  return trimmed;
}

export function getSupabaseUrl(): string {
  return require("NEXT_PUBLIC_SUPABASE_URL", process.env
    .NEXT_PUBLIC_SUPABASE_URL);
}

export function getSupabasePublishableKey(): string {
  return require("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", process.env
    .NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}

export function getSupabaseSecretKey(): string {
  return require("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY);
}
