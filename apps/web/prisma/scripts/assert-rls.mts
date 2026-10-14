/**
 * Phase 1 verification probe — is row-level security actually governing the app?
 *
 * This answers a question no unit test can: the mocked Prisma client has no
 * policies. Here the statements run as the real runtime role, so a `pass` means
 * the database itself refused to show rows the context did not earn.
 *
 * Two checks, both from `@amisibiz/database`:
 *
 *  1. `connectionBypassesRowLevelSecurity()` — the connection must not be a
 *     SUPERUSER or BYPASSRLS role. If it is, every policy is decoration.
 *  2. `assertRowLevelSecurityActive()` — with an intentionally EMPTY tenant
 *     context, `SELECT count(*) FROM "Tenant"` must return zero rows. That is
 *     the smallest proof that the policies filter rather than merely exist.
 *
 * The probe reads no business data and writes nothing, so it is safe to run
 * against a live project. It is also the check to run immediately after the
 * operator step in `prisma/scripts/setup-app-role.sql` (§1): until
 * `APP_DATABASE_URL` points at a password-protected `amisibiz_app`, this probe
 * will report the owner role and RLS is inert.
 *
 * Run (from apps/web; it reads .env.local then .env, and never prints them):
 *   pnpm tsx prisma/scripts/assert-rls.mts
 *
 * Exit code: 0 = enforced, 1 = not enforced, 2 = misconfigured / unreachable.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * Minimal .env reader — no new dependency for eight lines of parsing.
 *
 * Values already present in the real environment win, so CI can inject secrets
 * without a file, and a local run needs none.
 */
function loadEnvFile(name: string): void {
  const file = resolve(process.cwd(), name);
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match) continue;
    const [, key, rawValue] = match as [string, string, string];
    if (process.env[key] !== undefined) continue;
    const value = rawValue
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
    process.env[key] = value;
  }
}

function main(): Promise<number> {
  // .env.local first: it is the machine-local override file Next.js prefers.
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const usingAppRole = Boolean(process.env.APP_DATABASE_URL?.trim());

  console.log(
    `[rls-probe] runtime role source: ${
      usingAppRole ? "APP_DATABASE_URL (amisibiz_app)" : "DATABASE_URL fallback"
    }`,
  );

  if (!usingAppRole && process.env.NODE_ENV !== "production") {
    console.warn(
      "[rls-probe] APP_DATABASE_URL is unset. The scoped client falls back to DATABASE_URL, " +
        "which is the owner role — it bypasses RLS, so this run can only prove the fallback exists. " +
        "Complete step 1 of prisma/scripts/setup-app-role.sql, then publish APP_DATABASE_URL.",
    );
  }

  return import("@amisibiz/database").then(async (db) =>
    runChecks(
      db.assertRowLevelSecurityActive,
      db.connectionBypassesRowLevelSecurity,
    ),
  );
}

async function runChecks(
  assertActive: () => Promise<{ ok: true } | { ok: false; problem: string }>,
  bypasses: () => Promise<boolean>,
): Promise<number> {
  let isBypass: boolean;
  try {
    isBypass = await bypasses();
  } catch (error) {
    // Name and short message only: a Prisma connection error can echo the host,
    // port and sometimes the whole connection string.
    console.error(
      "[rls-probe] could not reach the database:",
      error instanceof Error ? error.name : "unknown error",
    );
    return 2;
  }

  console.log(
    `[rls-probe] 1. connection role ${isBypass ? "BYPASSES" : "is subject to"} row-level security`,
  );

  const result = await assertActive();

  if (result.ok) {
    console.log(
      "[rls-probe] 2. an empty tenant context reads zero tenant rows — policies are filtering",
    );
    console.log("[rls-probe] PASS: RLS governs the runtime connection.");
    return 0;
  }

  console.error(`[rls-probe] FAIL: ${result.problem}`);
  return 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(
      "[rls-probe] unexpected failure:",
      error instanceof Error ? error.name : "unknown error",
    );
    process.exit(2);
  });
