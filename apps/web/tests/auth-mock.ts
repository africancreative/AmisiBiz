import { vi } from "vitest";
import {
  bootstrapScope,
  enterScope,
  resetMockScope,
  sessionScope,
} from "./prisma-mock";

/**
 * Shared auth mock. Test files mock `@/lib/auth/session-user` with
 * `vi.mock("@/lib/auth/session-user", () => import("./auth-mock"))` and
 * configure `authMock` to resolve (or not) an `AppSessionUser`.
 *
 * `getSessionUser` is not the bare spy: the production implementation also
 * opens the RLS scope for the resolved actor (that is how a Server Action knows
 * who is calling), and the authorization helpers refuse anyone whose session
 * never did. So the mock mirrors that contract — resolve the user, then declare
 * the scope — while tests keep configuring `authMock` directly.
 */
export const authMock = vi.fn(async () => null as unknown);

type MockSessionUser = {
  id: string;
  platformRole?: string | null;
  [key: string]: unknown;
};

export async function getSessionUser(): Promise<MockSessionUser | null> {
  const user = (await authMock()) as MockSessionUser | null;

  if (!user) {
    enterScope(bootstrapScope());
    return null;
  }

  // Platform claims come from the resolved user row, exactly as in production.
  enterScope(
    sessionScope(user.id, {
      isPlatformAdmin: user.platformRole === "SUPER_ADMIN",
      isPlatformSupport: user.platformRole === "SUPPORT",
    }),
  );

  return user;
}

/** Test hook: clear any scope left over from the previous case. */
export { resetMockScope };
