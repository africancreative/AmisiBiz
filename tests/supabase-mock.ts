import { vi } from "vitest";

/**
 * Shared Supabase client mocks.
 *
 * Test files mock `@/lib/supabase/server` with
 * `vi.mock("@/lib/supabase/server", () => import("./supabase-mock"))`:
 *
 * - `createServerSupabase()` resolves the request-scoped client mock.
 * - `createAdminSupabase()` resolves the admin (secret-key) client mock.
 *
 * All defaults are benign (`error: null`). Call `resetSupabaseMocks()` in
 * `beforeEach` to restore defaults after tests that simulate failures.
 */

// Mocks are typed with a loose call signature (args: unknown[], resolves
// unknown) so tests can install success AND failure shapes without fighting
// the exact Supabase SDK generics.
type LooseProcedure = (...args: unknown[]) => Promise<unknown>;

const okAdmin = async (): Promise<unknown> => ({
  data: { user: {} },
  error: null,
});
const emptyUsers = async (): Promise<unknown> => ({
  data: { users: [] },
  error: null,
});
const noUser = async (): Promise<unknown> => ({
  data: { user: null },
  error: null,
});
const noSession = async (): Promise<unknown> => ({
  data: { user: null, session: null },
  error: null,
});
const okVoid = async (): Promise<unknown> => ({ data: {}, error: null });

export const supabaseAdminMock = {
  auth: {
    admin: {
      updateUserById: vi.fn<LooseProcedure>(okAdmin),
      createUser: vi.fn<LooseProcedure>(okAdmin),
      deleteUser: vi.fn<LooseProcedure>(okAdmin),
      listUsers: vi.fn<LooseProcedure>(emptyUsers),
    },
  },
};

export const supabaseServerMock = {
  auth: {
    getUser: vi.fn<LooseProcedure>(noUser),
    getSession: vi.fn<LooseProcedure>(noSession),
    signUp: vi.fn<LooseProcedure>(noSession),
    signInWithPassword: vi.fn<LooseProcedure>(noSession),
    signOut: vi.fn<LooseProcedure>(okVoid),
    updateUser: vi.fn<LooseProcedure>(okAdmin),
    refreshSession: vi.fn<LooseProcedure>(noSession),
    resetPasswordForEmail: vi.fn<LooseProcedure>(okVoid),
  },
};

export const createAdminSupabase = vi.fn(() => supabaseAdminMock);
export const createServerSupabase = vi.fn(async () => supabaseServerMock);

export function resetSupabaseMocks(): void {
  createAdminSupabase.mockClear().mockImplementation(() => supabaseAdminMock);
  createServerSupabase
    .mockClear()
    .mockImplementation(async () => supabaseServerMock);

  const admin = supabaseAdminMock.auth.admin;
  admin.updateUserById.mockReset().mockImplementation(okAdmin);
  admin.createUser.mockReset().mockImplementation(okAdmin);
  admin.deleteUser.mockReset().mockImplementation(okAdmin);
  admin.listUsers.mockReset().mockImplementation(emptyUsers);

  const auth = supabaseServerMock.auth;
  auth.getUser.mockReset().mockImplementation(noUser);
  auth.getSession.mockReset().mockImplementation(noSession);
  auth.signUp.mockReset().mockImplementation(noSession);
  auth.signInWithPassword.mockReset().mockImplementation(noSession);
  auth.signOut.mockReset().mockImplementation(okVoid);
  auth.updateUser.mockReset().mockImplementation(okAdmin);
  auth.refreshSession.mockReset().mockImplementation(noSession);
  auth.resetPasswordForEmail.mockReset().mockImplementation(okVoid);
}
