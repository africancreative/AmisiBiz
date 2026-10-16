import "server-only";

import {
  prisma,
  enterScope,
  bootstrapScope,
  sessionScope,
} from "@amisibiz/database";
import { isSessionValid } from "@/lib/auth/session";
import { verifySessionToken } from "@/lib/auth/token";
import type { AppSessionUser } from "@/lib/auth/session-user";

/** Extracts the token from `Authorization: Bearer …`, or null. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Resolves the caller's session from the request's bearer token.
 */
export async function getBearerSessionUser(
  request: Request,
): Promise<AppSessionUser | null> {
  const token = readBearerToken(request);
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

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
