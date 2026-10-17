import type { PlatformRole, UserStatus } from "./roles";

/**
 * The application's view of the signed-in user — the ONLY identity shape that
 * application code may rely on. It always originates from a cryptographic session
 * cookie validated against the database; an id, role or status that exists
 * only in a client store is never trusted.
 */
export type AppSessionUser = {
  id: string;
  email: string | null;
  name: string | null;
  /** null = no platform privileges (the default; platform roles are rare). */
  platformRole: PlatformRole | null;
  status: UserStatus;
};
