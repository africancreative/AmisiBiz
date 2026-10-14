import { getScopedClient } from "./client";
import { applyTenantContext, bootstrapScope } from "./scope";

/**
 * RLS self-verification probes.
 *
 * These live in their own module because they need both the runtime connection
 * and the scope helpers — importing them from `client.ts` would close a cycle
 * (`scope.ts` already depends on `client.ts` for `getScopedClient`).
 */

/**
 * Does the current connection role make RLS irrelevant?
 *
 * The per-table grants in 20261018000002 only bite for a role that is actually
 * subject to the policies. A superuser or a `BYPASSRLS` role reads every row
 * regardless of the context, which is precisely the state `APP_DATABASE_URL`
 * exists to avoid. This is a configuration fact, not a security oracle:
 * `pg_roles` is world-readable and nothing here reveals a hostname, role name
 * or grant list.
 */
export async function connectionBypassesRowLevelSecurity(): Promise<boolean> {
  const rows = await getScopedClient().$queryRaw<{ bypass: boolean }[]>`
    SELECT (r.rolsuper OR r.rolbypassrls) AS bypass
      FROM pg_roles r
     WHERE r.rolname = current_user`;
  return rows[0]?.bypass ?? false;
}

/**
 * Verifies the runtime is really governed by row-level security: the role is not
 * a bypass, and an unscoped read of `Tenant` sees nothing. Used by the
 * integration harness and by `pnpm db:assert-rls`; the web process does not run
 * it per request because a wrong answer here must not be a silent log line.
 */
export async function assertRowLevelSecurityActive(): Promise<
  { ok: true } | { ok: false; problem: string }
> {
  if (await connectionBypassesRowLevelSecurity()) {
    return {
      ok: false,
      problem:
        "The runtime role bypasses row-level security. Point APP_DATABASE_URL at the application role.",
    };
  }

  const visible = await getScopedClient().$transaction(async (tx) => {
    // An intentionally empty context: no tenant, no user, no platform claim.
    await applyTenantContext(tx, bootstrapScope());
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM public."Tenant"`;
    return Number(rows[0]?.count ?? 0);
  });

  if (visible !== 0) {
    return {
      ok: false,
      problem: `An empty context still reads ${visible} tenant rows — the policies are not effective.`,
    };
  }

  return { ok: true };
}
