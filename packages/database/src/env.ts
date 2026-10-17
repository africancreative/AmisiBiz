import { z } from "zod";

const databaseUrlSchema = z.string().trim().min(1);

export function collectDatabaseEnvProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  if (!env.DATABASE_URL?.trim()) problems.push("DATABASE_URL: is required");
  if (!env.APP_DATABASE_URL?.trim() && !env.DATABASE_URL?.trim()) problems.push("APP_DATABASE_URL: is required when DATABASE_URL is absent");
  return problems;
}

export function requireDatabaseEnv(env: Record<string, string | undefined> = process.env) {
  const problems = collectDatabaseEnvProblems(env);
  if (problems.length) throw new Error(["Database environment is not configured correctly:", ...problems.map((p) => `  - ${p}`)].join("\\n"));
  return { DATABASE_URL: databaseUrlSchema.parse(env.DATABASE_URL), APP_DATABASE_URL: databaseUrlSchema.parse(env.APP_DATABASE_URL ?? env.DATABASE_URL) };
}

export function getDatabaseUrl(): string {
  const value = process.env.APP_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("APP_DATABASE_URL is not configured (and no DATABASE_URL fallback exists).");
  return value;
}

