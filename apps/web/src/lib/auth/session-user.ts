import { cookies } from "next/headers";
import {
  prisma,
  enterScope,
  bootstrapScope,
  sessionScope,
} from "@amisibiz/database";
import { isSessionValid } from "@/lib/auth/session";
import { currentRequestSessionUser } from "@/lib/auth/request-session";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/token";
import type { AppSessionUser } from "@amisibiz/auth";

export type { AppSessionUser };

/**
 * Resolves the signed-in user for Server Components, Server Actions and Route Handlers,
 * or null when the request is unauthenticated.
 *
 * Backed directly by PostgreSQL on Neon and secure signed HTTP-only cookies.
 */
export async function getSessionUser(): Promise<AppSessionUser | null> {
  const bearer = currentRequestSessionUser();
  if (bearer !== undefined) return bearer;

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  // Open the RLS scope for the rest of this request.
  enterScope(sessionScope(payload.userId));

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      name: true,
      platformRole: true,
      status: true,
      sessionVersion: true,
    },
  });

  if (!user || !isSessionValid(user, payload.sessionVersion)) {
    enterScope(bootstrapScope());
    return null;
  }

  enterScope(
    sessionScope(user.id, {
      isPlatformAdmin: user.platformRole === "SUPER_ADMIN",
      isPlatformSupport: user.platformRole === "SUPPORT",
    }),
  );

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    platformRole: user.platformRole,
    status: user.status,
  };
}
