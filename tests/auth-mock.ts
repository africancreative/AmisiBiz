import { vi } from "vitest";

/**
 * Shared Auth.js mock. Test files mock `@/lib/auth/config` with
 * `vi.mock("@/lib/auth/config", () => import("./auth-mock"))` and configure
 * `authMock` to return (or not) a session.
 */
export const authMock = vi.fn();
export const auth = authMock;
export const handlers = {};
export const signIn = vi.fn();
export const signOut = vi.fn();
