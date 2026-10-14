/**
 * Vitest global setup.
 *
 * Provides safe, non-secret placeholder environment variables so that modules
 * which validate env at import time can be loaded in tests. No real
 * credentials are ever used here.
 */
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_test_placeholder_000000000000000";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test_placeholder_000000000000000";
process.env.DATABASE_URL =
  "postgresql://test:test@localhost:5432/amisibiz_test";
process.env.DIRECT_URL = "postgresql://test:test@localhost:5432/amisibiz_test";

/**
 * Scope hygiene.
 *
 * The database mock keeps an ambient RLS scope (the stand-in for
 * `AsyncLocalStorage` in the real client). A scope left over from one case would
 * let the next one authorize against the previous actor, so every case starts
 * from "no context" exactly like a fresh request.
 */
import { beforeEach } from "vitest";
import { resetMockScope } from "./prisma-mock";

beforeEach(() => {
  resetMockScope();
});
