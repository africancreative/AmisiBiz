import { vi } from "vitest";

/**
 * Shared auth mock. Test files mock `@/lib/auth/session-user` with
 * `vi.mock("@/lib/auth/session-user", () => import("./auth-mock"))` and
 * configure `authMock` to resolve (or not) an `AppSessionUser`.
 */
export const authMock = vi.fn();
export const getSessionUser = authMock;
