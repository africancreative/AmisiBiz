import { PrismaClient } from "@prisma/client";

import { POOLED_DATABASE_URL_KEYS, resolvePooledDatabaseUrl } from "./env";

/**
 * The runtime database connection — the role that RLS is written for.
 *
 * Two URLs describe the same PostgreSQL project and are deliberately not
 * interchangeable:
 *
 *  - `DATABASE_URL` is the *owner/administrator* connection used by Prisma CLI
 *    work (`migrate`, `db seed`). That is the administrator role, which
 *    bypasses row-level security and holds every privilege. Application code has
 *    no business using it: a single forgotten `where` clause would read across
 *    tenants and nothing in the database would object.
 *  - `APP_DATABASE_URL` is the *least-privilege runtime* connection
 *    (`amisibiz_app`): per-table verb grants, no BYPASSRLS, so the policies from
 *    migration 20261018000002 decide what any statement can see.
 *
 * Outside production the scoped client falls back to the pooled owner URL so a
 * fresh clone works before a local `amisibiz_app` role has been created — with
 * one loud warning, because that fallback is a development convenience, not a
 * security posture. In production the fallback is refused when
 * `STRICT_APP_ROLE="true"`: booting as the owner role would silently disable
 * every RLS guarantee, and an unavailable service beats an unprotected one.
 *
 * The owner fallback also accepts the pooled keys hosting platforms inject for
 * a Neon integration (`POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `…_2` per extra
 * database) — see `resolvePooledDatabaseUrl` in `./env` for the fixed order.
 * They are still owner credentials, so every caveat above applies unchanged;
 * only the variable name differs.
 */

export const APP_DATABASE_URL_ENV = "APP_DATABASE_URL";

let cached: { url: string; client: PrismaClient } | null = null;
let warned = false;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function resolveScopedUrl(): string {
  const appUrl = process.env[APP_DATABASE_URL_ENV]?.trim();
  if (appUrl) return appUrl;

  const owner = resolvePooledDatabaseUrl();
  if (!owner) {
    throw new Error(
      [
        `${APP_DATABASE_URL_ENV} is not configured (and no pooled database URL fallback exists).`,
        "The runtime needs the least-privilege application role, e.g.",
        `  ${APP_DATABASE_URL_ENV}="postgresql://amisibiz_app:<password>@<host>:<port>/postgres"`,
        `Owner fallbacks checked: ${POOLED_DATABASE_URL_KEYS.join(", ")}.`,
        "See apps/web/.env.example.",
      ].join(" "),
    );
  }

  if (isProduction() && process.env.STRICT_APP_ROLE === "true") {
    throw new Error(
      [
        `${APP_DATABASE_URL_ENV} is required in production.`,
        "Falling back to DATABASE_URL would run the application as a role that bypasses",
        "row-level security, which defeats the Phase 1 authorization model. Refusing to",
        "connect is intentional — see docs/RUNBOOK.md (RLS activation).",
      ].join(" "),
    );
  }

  if (!warned) {
    warned = true;
    console.warn(
      [
        `[database] ${APP_DATABASE_URL_ENV} is not set — using ${owner.source} (an owner/administrator URL).`,
        "Row-level security is NOT enforced by this connection if the role bypasses it.",
        "Create the application role (apps/web/prisma/scripts/setup-app-role.sql) before",
        "testing any authorization behaviour.",
      ].join(" "),
    );
  }

  return owner.url;
}

/**
 * The scoped runtime client. Lazy so importing this package never validates the
 * environment (a browser-safe import graph must not trip over server URLs), and
 * cached per URL so hot reloads do not exhaust the pool.
 */
export function getScopedClient(): PrismaClient {
  const url = resolveScopedUrl();
  if (cached?.url === url) return cached.client;

  const client = new PrismaClient({
    // Prisma 6 accepts a datasource URL override; the generated client would
    // otherwise always read DATABASE_URL.
    datasourceUrl: url,
    // Deliberately no "query" logging: Prisma's query log emits bound parameter
    // values, which in this application are contact details, document numbers
    // and identifiers. Constitution: no PII in logs.
    log: isProduction() ? ["error"] : ["error", "warn"],
  });

  cached = { url, client };
  return client;
}

/** Connection probe for health checks — touches no table, needs no context. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getScopedClient().$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    // Name only: Prisma connection errors can echo host, port and sometimes the
    // connection string, none of which belongs in a log line (constitution: no
    // credentials or PII in logs). The probe's caller only ever reports "degraded".
    console.error(
      "[database] connection probe failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return false;
  }
}

/** Releases the pool (used by the integration harness between suites). */
export async function disconnectScopedClient(): Promise<void> {
  if (!cached) return;
  const client = cached.client;
  cached = null;
  await client.$disconnect();
}
