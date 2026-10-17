import { z } from "zod";

/**
 * Server-side environment for the database connection (Neon PostgreSQL).
 *
 * Access is intentionally LAZY — functions, never module-load validation —
 * so importing this module is always safe (including from tests that mock it
 * partially) and every failure names the exact variable that is missing or
 * invalid.
 */

export const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .min(1, "is required (PostgreSQL connection URL)")
    .url("must be a valid PostgreSQL connection URL"),
  DIRECT_URL: z
    .string()
    .trim()
    .url("must be a valid PostgreSQL connection URL")
    .optional(),
  APP_DATABASE_URL: z
    .string()
    .trim()
    .url("must be a valid PostgreSQL connection URL")
    .optional(),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

/**
 * Every problem found in the database environment, aggregated so a
 * misconfigured deployment reports all missing/invalid variables at once
 * instead of failing on the first one touched.
 */
export function collectDatabaseEnvProblems(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const parsed = databaseEnvSchema.safeParse(env);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
}

/** Throws a single aggregated error when the database environment is not valid. */
export function requireDatabaseEnv(
  env: Record<string, string | undefined> = process.env,
): DatabaseEnv {
  const problems = collectDatabaseEnvProblems(env);
  if (problems.length > 0) {
    throw new Error(
      [
        "Database environment is not configured correctly:",
        ...problems.map((problem) => `  - ${problem}`),
        "See apps/web/.env.example for the full list of required variables.",
      ].join("\n"),
    );
  }
  return databaseEnvSchema.parse(env);
}

function requireVar(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `${name} is not configured. See .env.example for the full list of required variables.`,
    );
  }
  return trimmed;
}

export function getDatabaseUrl(): string {
  return requireVar("DATABASE_URL", process.env.DATABASE_URL);
}

export function getDirectUrl(): string | undefined {
  return process.env.DIRECT_URL?.trim();
}

export function getAppDatabaseUrl(): string | undefined {
  return process.env.APP_DATABASE_URL?.trim();
}
