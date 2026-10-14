export * from "./env";
export {
  APP_DATABASE_URL_ENV,
  disconnectScopedClient,
  getScopedClient,
  pingDatabase,
} from "./client";
export { prisma } from "./prisma";
export {
  assertRowLevelSecurityActive,
  connectionBypassesRowLevelSecurity,
} from "./rls-probe";
export {
  applyTenantContext,
  bootstrapScope,
  currentScope,
  currentTransaction,
  enterScope,
  hasScope,
  requireScope,
  runInScope,
  runScoped,
  ScopeNotSetError,
  scopeParams,
  sessionScope,
  tenantScope,
  type DbScope,
  type DbScopeReason,
  type PlatformClaims,
  type ScopedTx,
} from "./scope";
export { createAdminSupabase } from "./supabase-admin";
export type { Prisma } from "@prisma/client";
