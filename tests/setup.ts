/**
 * Vitest global setup.
 *
 * Provides safe, non-secret placeholder environment variables so that modules
 * which validate env at import time can be loaded in tests. No real
 * credentials are ever used here.
 */
process.env.AUTH_SECRET = "test-secret-value-not-used-in-production-0000";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.DATABASE_URL =
  "postgresql://test:test@localhost:5432/amisibiz_test";
process.env.DIRECT_URL = "postgresql://test:test@localhost:5432/amisibiz_test";
