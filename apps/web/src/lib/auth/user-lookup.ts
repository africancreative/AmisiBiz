import { bootstrapScope, runInScope } from "@amisibiz/database";
import type { UserStatus } from "@prisma/client";

/**
 * Pre-session identity lookup.
 *
 * Registration and password reset happen *before* anybody has a session, so
 * there is no `app.current_user_id` for the `User` policies to anchor on — a
 * plain `prisma.user.findUnique({ where: { email } })` would correctly return
 * nothing and the flows would silently break.
 *
 * The answer comes from `public.app_find_user_id_by_email()`: a SECURITY
 * DEFINER function created by migration 20261018000002 that returns exactly two
 * facts (`id`, `status`) for one address, is executable by the application role
 * only (revoked from PUBLIC), and is not a general read of the `User` table.
 * That is the narrow door the design §5.4 allows for the bootstrap phase; the
 * broader truth — whether an address is registered — is decided from this same
 * function, and a miss means "no such account".
 */
export async function findUserIdByEmail(
  email: string,
): Promise<{ id: string; status: UserStatus } | null> {
  const rows = await runInScope(
    bootstrapScope(),
    (tx) => tx.$queryRaw<{ id: string; status: UserStatus }[]>`
      SELECT "id", "status"
        FROM public.app_find_user_id_by_email(${email})`,
  );

  const row = rows[0];
  return row ? { id: row.id, status: row.status } : null;
}
