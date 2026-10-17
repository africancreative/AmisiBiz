import { z } from "zod";

/**
 * Server-side environment for the database connection (Neon PostgreSQL).
 *
 * Access is intentionally LAZY — functions, never module-load validation —
 * so importing this module is always safe (including from tests that mock it
 * partially) and every failure names the exact variable that is missing or
 * invalid.
 *
 * Two URL families are understood:
 *
 *  - Pooled owner/admin URLs. `DATABASE_URL` is the canonical key declared in
 *    `apps/web/.env.example`. The remaining pooled keys are the connection
 *    strings hosting platforms inject when a Neon integration is attached
 *    (Vercel injects `POSTGRES_PRISMA_URL` and `POSTGRES_URL`, suffixing `_2`
 *    per extra database). They are accepted in a fixed order so a deployed
 *    preview works without re-declaring the project's own variables.
 *  - Unpooled (direct) URLs for the same project. `DIRECT_URL` is canonical —
 *    the Prisma CLI needs the direct endpoint for migrations because pooled
 *    hosts proxy through PgBouncer. The unpooled injections stand in for it
 *    the same way, in a fixed order.
 *
 * SECURITY: every injected key carries the project OWNER credential. An owner
 * role bypasses row-level security, so alias fallbacks are a development and
 * preview convenience only: production must provision `APP_DATABASE_URL`
 * (least-privilege `amisibiz_app`) — `client.ts` enforces that boundary, and
 * `STRICT_APP_ROLE="true"` refuses the owner fallback outright. The Prisma CLI
 * (`migrate`, `db seed`) resolves `env("DATABASE_URL")` / `env("DIRECT_URL")`
 * itself, so it always needs the canonical keys in the environment it runs in.
 */

/** Pooled owner URL keys in resolution order (first match wins). */
export const POOLED_DATABASE_URL_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_2",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_PRISMA_URL_2",
  "POSTGRES_URL",
  "POSTGRES_URL_2",
] as const;

/** Unpooled/direct URL keys in resolution order (first match wins). */
export const UNPOOLED_DATABASE_URL_KEYS = [
  "DIRECT_URL",
  "DATABASE_URL_UNPOOLED",
  "DATABASE_URL_UNPOOLED_2",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NON_POOLING_2",
] as const;

/**
 * An optional URL variable. Platforms occasionally inject keys set to the
 * empty string; those count as "absent" rather than raising a confusing
 * "must be a valid URL" against a value nobody configured.
 */
const optionalUrl = () =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z
      .string()
      .trim()
      .url("must be a valid PostgreSQL connection URL")
      .optional(),
  );

export const databaseEnvSchema = z
  .object({
    DATABASE_URL: optionalUrl(),
    DATABASE_URL_2: optionalUrl(),
    POSTGRES_PRISMA_URL: optionalUrl(),
    POSTGRES_PRISMA_URL_2: optionalUrl(),
    POSTGRES_URL: optionalUrl(),
    POSTGRES_URL_2: optionalUrl(),
    DATABASE_URL_UNPOOLED: optionalUrl(),
    DATABASE_URL_UNPOOLED_2: optionalUrl(),
    POSTGRES_URL_NON_POOLING: optionalUrl(),
    POSTGRES_URL_NON_POOLING_2: optionalUrl(),
    DIRECT_URL: optionalUrl(),
    APP_DATABASE_URL: optionalUrl(),
  })
  .superRefine((env, ctx) => {
    if (!findFirstUrl(POOLED_DATABASE_URL_KEYS, env)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message:
          "is required (a pooled PostgreSQL connection URL — set DATABASE_URL, or deploy with the platform's Neon integration so POSTGRES_PRISMA_URL / POSTGRES_URL are injected)",
      });
    }
  });

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

/** A connection string plus the environment key it was resolved from. */
export type ResolvedDatabaseUrl = {
  /** The connection string. NEVER log it — it embeds the owner password. */
  url: string;
  /** The environment key the URL came from. Safe to log. */
  source: string;
};

function findFirstUrl(
  keys: readonly string[],
  env: Record<string, string | undefined>,
): ResolvedDatabaseUrl | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { url: value, source: key };
  }
  return null;
}

/**
 * The first pooled owner URL found among the canonical and injected keys, or
 * null. The resolved `source` is the key NAME — the only part that is safe to
 * log.
 */
export function resolvePooledDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): ResolvedDatabaseUrl | null {
  return findFirstUrl(POOLED_DATABASE_URL_KEYS, env);
}

/** The first unpooled (direct) URL found, or null. Same caveat as pooled. */
export function resolveDirectDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): ResolvedDatabaseUrl | null {
  return findFirstUrl(UNPOOLED_DATABASE_URL_KEYS, env);
}

/**
 * Every problem found in the database environment, aggregated so a
 * misconfigured deployment reports all missing/invalid variables at once
 * instead of failing on the first one touched. Values are never echoed —
 * a connection string embeds a password (constitution: no credentials in
 * logs or errors).
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

export function getDatabaseUrl(): string {
  const resolved = resolvePooledDatabaseUrl();
  if (!resolved) {
    throw new Error(
      `DATABASE_URL is not configured (no pooled database URL found — checked: ${POOLED_DATABASE_URL_KEYS.join(", ")}). See apps/web/.env.example.`,
    );
  }
  return resolved.url;
}

/**
 * Which environment key the pooled URL was resolved from, or null. Key NAME
 * only — for diagnostics that must stay secret-free.
 */
export function getDatabaseUrlSource(): string | null {
  return resolvePooledDatabaseUrl()?.source ?? null;
}

export function getDirectUrl(): string | undefined {
  return resolveDirectDatabaseUrl()?.url;
}

export function getAppDatabaseUrl(): string | undefined {
  return process.env.APP_DATABASE_URL?.trim();
}
