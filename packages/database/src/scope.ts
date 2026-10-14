import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { getScopedClient } from "./client";

/**
 * Request-scoped database context — the application half of RLS enforcement.
 *
 * How the pieces fit (design §5, implemented by migration
 * 20261018000002_rls_enforcement_storage_and_grants):
 *
 *  1. The runtime connects as the `amisibiz_app` role (see `client.ts`), which
 *     has no BYPASSRLS and only per-table privileges, so every statement is
 *     filtered by the table's policies.
 *  2. Each unit of work runs inside a transaction in which
 *     `public.set_tenant_context(...)` writes the five `app.*` GUCs with
 *     transaction-local scope. Policies read `current_tenant_id()` /
 *     `current_user_id()` from those GUCs.
 *  3. The claims are information only. `is_platform_admin()`,
 *     `app_tenant_role()` and `has_support_grant()` re-read `User`,
 *     `TenantMember` and `SupportAccessGrant`, so a connection that lies about
 *     being a platform admin — or about which tenant it is in — gains nothing
 *     it does not already own. That is why an attacker-controlled tenant id can
 *     never be used to hop tenants: the membership row has to exist.
 *
 * Transaction-local settings revert at COMMIT, and `set_tenant_context` always
 * writes all five keys, so a pooled connection can never inherit the previous
 * borrower's context. `clear_tenant_context()` remains available for session
 * scrubbing, but the scoped client never relies on it.
 */

export type DbScopeReason =
  /** No authenticated identity yet (registration, invitation lookups). */
  | "bootstrap"
  /** Authenticated user, no tenant selected (session resolution, profile). */
  | "session"
  /** A tenant member acting inside their own workspace. */
  | "tenant"
  /** A platform console action (super admin). */
  | "platform"
  /** Provider support acting under an explicit, time-boxed grant. */
  | "support";

export type DbScope = {
  readonly userId: string | null;
  readonly tenantId: string | null;
  /** Informational claim for the GUC; policies use the database's own answer. */
  readonly tenantRole: string | null;
  readonly isPlatformAdmin: boolean;
  readonly isPlatformSupport: boolean;
  readonly reason: DbScopeReason;
};

/** Platform flags always come from the actor's `User` row, never from the client. */
export type PlatformClaims = {
  readonly isPlatformAdmin?: boolean;
  readonly isPlatformSupport?: boolean;
};

export function bootstrapScope(userId: string | null = null): DbScope {
  return {
    userId,
    tenantId: null,
    tenantRole: null,
    isPlatformAdmin: false,
    isPlatformSupport: false,
    reason: "bootstrap",
  };
}

export function sessionScope(
  userId: string,
  claims: PlatformClaims = {},
): DbScope {
  return {
    userId,
    tenantId: null,
    tenantRole: null,
    isPlatformAdmin: claims.isPlatformAdmin === true,
    isPlatformSupport: claims.isPlatformSupport === true,
    reason:
      claims.isPlatformAdmin || claims.isPlatformSupport
        ? "platform"
        : "session",
  };
}

export function tenantScope(
  userId: string,
  tenantId: string,
  tenantRole: string | null,
  claims: PlatformClaims = {},
): DbScope {
  return {
    userId,
    tenantId,
    tenantRole,
    isPlatformAdmin: claims.isPlatformAdmin === true,
    isPlatformSupport: claims.isPlatformSupport === true,
    reason:
      claims.isPlatformSupport && !claims.isPlatformAdmin
        ? "support"
        : "tenant",
  };
}

/**
 * Raised when tenant data is touched without a database context. Fail-closed on
 * purpose: an unscoped query would run with an empty `app.current_tenant_id`,
 * which every policy reads as "no rows" — silently returning an empty workspace
 * is worse than a loud error at the call site that forgot to authorize.
 */
export class ScopeNotSetError extends Error {
  constructor(operation: string) {
    super(
      [
        `Database operation "${operation}" was attempted outside a request scope.`,
        "Authorize the actor and open a scope first: runInScope(tenantScope(...), ...) for",
        "a unit of work, or enterScope(sessionScope(userId)) at the point where the session",
        "is resolved. This check exists so a missing authorization can never be masked by",
        "an empty RLS result.",
      ].join(" "),
    );
    this.name = "ScopeNotSetError";
  }
}

type ScopeFrame = {
  readonly scope: DbScope;
  /** Set while an interactive transaction is open; null between operations. */
  readonly tx: Prisma.TransactionClient | null;
};

const frames = new AsyncLocalStorage<ScopeFrame>();

export function currentScope(): DbScope | null {
  return frames.getStore()?.scope ?? null;
}

export function hasScope(): boolean {
  return frames.getStore() !== undefined;
}

function requireFrame(operation: string): ScopeFrame {
  const frame = frames.getStore();
  if (!frame) throw new ScopeNotSetError(operation);
  return frame;
}

/** The ambient scope, or a fail-closed `ScopeNotSetError` naming the caller. */
export function requireScope(operation: string): DbScope {
  return requireFrame(operation).scope;
}

/**
 * The interactive transaction the current scope has open, if any. Helpers use it
 * to join the caller's transaction instead of taking a second pooled connection.
 */
export function currentTransaction(): ScopedTx | null {
  return frames.getStore()?.tx ?? null;
}

/**
 * Declares the ambient scope for the rest of the current request's async
 * execution. Used by the authorization helpers: once an actor has been
 * authorized, the Server Action or Server Component that follows inherits the
 * context instead of having to wrap every query by hand.
 *
 * `enterWith` only affects the current async context — one request, one server
 * action, one render — so two concurrent requests cannot see each other's
 * scope. An already-open interactive transaction is preserved.
 */
export function enterScope(scope: DbScope): void {
  frames.enterWith({ scope, tx: frames.getStore()?.tx ?? null });
}

/** A transaction client that already carries the context. */
export type ScopedTx = Prisma.TransactionClient;

/** Statement executor: the generated client or a transaction of it. */
type Executor = Prisma.TransactionClient | ReturnType<typeof getScopedClient>;

function params(scope: DbScope): [string, string, string, boolean, boolean] {
  // Empty strings, never NULL: `set_tenant_context` treats a blank value as
  // "unset this key for this transaction", and Prisma raw parameters stay
  // plainly typed as text/boolean.
  return [
    scope.tenantId ?? "",
    scope.userId ?? "",
    scope.tenantRole ?? "",
    scope.isPlatformAdmin,
    scope.isPlatformSupport,
  ];
}

/** Writes the five `app.*` GUCs (transaction-local) on the given connection. */
export async function applyTenantContext(
  tx: Executor,
  scope: DbScope,
): Promise<void> {
  const [tenantId, userId, tenantRole, isAdmin, isSupport] = params(scope);
  await tx.$executeRaw`SELECT public.set_tenant_context(
      ${tenantId}::text,
      ${userId}::text,
      ${tenantRole}::text,
      ${isAdmin}::boolean,
      ${isSupport}::boolean
    )`;
}

/**
 * Interactive timeout budget for the wrapped statements. A scoped operation is
 * a handful of statements on one connection; keeping the ceiling explicit means
 * a stuck transaction cannot hold a pooled connection indefinitely.
 */
const SCOPE_TX_TIMEOUT_MS = 10_000;
const SCOPE_TX_MAX_WAIT_MS = 5_000;

/**
 * Runs `fn` with the scope applied to a dedicated transaction. Nested calls
 * reuse the open transaction, switch the context for the duration, and restore
 * the caller's context afterwards — so a helper can legitimately act inside
 * another tenant (platform console, support grant) without the outer
 * transaction silently keeping the elevated context.
 */
export async function runInScope<T>(
  scope: DbScope,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  const frame = frames.getStore();

  if (frame?.tx) {
    const tx = frame.tx;
    const previous = frame.scope;
    const sameContext = isSameContext(previous, scope);
    if (!sameContext) await applyTenantContext(tx, scope);
    try {
      return await frames.run({ scope, tx }, () => fn(tx));
    } finally {
      if (!sameContext) await applyTenantContext(tx, previous);
    }
  }

  return getScopedClient().$transaction(
    async (tx) => {
      await applyTenantContext(tx, scope);
      return frames.run({ scope, tx }, () => fn(tx));
    },
    { timeout: SCOPE_TX_TIMEOUT_MS, maxWait: SCOPE_TX_MAX_WAIT_MS },
  );
}

/**
 * Runs a single statement under the ambient scope. When an interactive
 * transaction is already open the statement joins it; otherwise it gets its own
 * short transaction with the context applied first. This is what the scoped
 * `prisma` proxy delegates to.
 */
export async function runScoped<T>(
  operation: string,
  op: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  const frame = requireFrame(operation);
  if (frame.tx) return op(frame.tx);

  return getScopedClient().$transaction(
    async (tx) => {
      await applyTenantContext(tx, frame.scope);
      return op(tx);
    },
    { timeout: SCOPE_TX_TIMEOUT_MS, maxWait: SCOPE_TX_MAX_WAIT_MS },
  );
}

function isSameContext(a: DbScope, b: DbScope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.userId === b.userId &&
    a.tenantRole === b.tenantRole &&
    a.isPlatformAdmin === b.isPlatformAdmin &&
    a.isPlatformSupport === b.isPlatformSupport
  );
}

/** Test/inspection helper: the context a scoped statement would send. */
export function scopeParams(
  scope: DbScope,
): [string, string, string, boolean, boolean] {
  return params(scope);
}
