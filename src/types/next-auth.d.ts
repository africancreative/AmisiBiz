import type { DefaultUser } from "next-auth";
import type { PlatformRole, UserStatus } from "@prisma/client";

/**
 * Auth.js (NextAuth v5) type augmentation for AmisiBiz.
 *
 * Adds AmisiBiz-specific fields to the session, user and JWT types. These
 * values are only ever populated server-side (see `lib/auth/config.ts`);
 * browser-supplied roles are never trusted.
 *
 * `sessionVersion` is embedded in the JWT and compared against the database on
 * every session read to support session revocation.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      platformRole: PlatformRole;
      status: UserStatus;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }

  interface User extends DefaultUser {
    id: string;
    platformRole: PlatformRole;
    status: UserStatus;
    sessionVersion: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    platformRole?: PlatformRole;
    status?: UserStatus;
    sessionVersion?: number;
  }
}
