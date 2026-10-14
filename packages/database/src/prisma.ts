import type { PrismaClient } from "@prisma/client";
import { getScopedClient } from "./client";
import {
  currentTransaction,
  requireScope,
  runInScope,
  runScoped,
  type ScopedTx,
} from "./scope";

/**
 * The application's database handle.
 *
 * It is a scope-aware view over the least-privilege runtime client rather than
 * the client itself, and that distinction is the enforcement mechanism:
 *
 *  - every model call runs inside a transaction that has just written the
 *    `app.*` request context, so PostgreSQL policies decide what the statement
 *    can touch — not the `where` clause the application remembered to write;
 *  - a model call made before an actor has been authorized raises
 *    `ScopeNotSetError` instead of quietly returning zero rows. An empty result
 *    and a missing authorization are not the same fact, and treating them as
 *    one is how tenancy bugs survive review.
 *
 * The call sites stay `prisma.contact.findMany({ where: { tenantId } })`: the
 * tenant filter remains (defence in depth and index selectivity), while the
 * scope around it is what makes the filter non-negotiable.
 */

type ModelDelegate = Record<string, unknown>;

function scopedDelegate(modelName: string): ModelDelegate {
  return new Proxy({} as ModelDelegate, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      const operation = `${modelName}.${property}`;

      return (...args: unknown[]): Promise<unknown> =>
        runScoped(operation, (tx: ScopedTx) => {
          const delegate = (tx as unknown as Record<string, ModelDelegate>)[
            modelName
          ];
          if (!delegate) {
            throw new Error(
              `Unknown Prisma model "${modelName}" — the runtime client has no such delegate.`,
            );
          }
          const method = delegate[property];
          if (typeof method !== "function") {
            throw new Error(
              `Unknown Prisma operation "${operation}" — it is not a method on the delegate.`,
            );
          }
          return (method as (...a: unknown[]) => Promise<unknown>).apply(
            delegate,
            args,
          );
        });
    },
  });
}

/**
 * `prisma.$transaction(async (tx) => …)`.
 *
 * The array form is rejected on purpose: its promises are built before the
 * transaction opens, so they would each get their own transaction and their own
 * context — a "transaction" that is neither atomic nor consistently scoped.
 * Nothing in this codebase uses it, and an error is better than a silent
 * difference in semantics.
 *
 * Per-transaction options (`isolationLevel`, `maxWait`, `timeout`) are rejected
 * for the same reason: this wrapper may either join the ambient transaction or
 * open one under the ambient scope, so it cannot honour settings that belong to
 * a transaction it did not create. Silently ignoring them would let a caller
 * believe it had asked for `SERIALIZABLE` when it got the connection default.
 */
async function scopedTransaction(
  arg: unknown,
  options?: unknown,
): Promise<unknown> {
  if (Array.isArray(arg)) {
    throw new Error(
      "prisma.$transaction([...]) is not supported under RLS scoping. Use the interactive form: prisma.$transaction(async (tx) => { … }).",
    );
  }
  if (options !== undefined) {
    throw new Error(
      "prisma.$transaction options are not supported under RLS scoping: the scoped wrapper joins an ambient transaction or opens its own, so isolationLevel/maxWait/timeout cannot be honoured.",
    );
  }
  if (typeof arg !== "function") {
    throw new TypeError("prisma.$transaction expects an interactive callback.");
  }

  const callback = arg as (tx: ScopedTx) => Promise<unknown>;
  const scope = requireScope("$transaction");

  // Already inside a scoped transaction (a service called from a Server Action):
  // join it rather than opening a second one on another connection.
  const ambientTx = currentTransaction();
  if (ambientTx) return callback(ambientTx);

  return runInScope(scope, callback) as Promise<unknown>;
}

const RAW_METHODS = new Set([
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
]);

function scopedRaw(method: string) {
  return (...args: unknown[]): Promise<unknown> =>
    runScoped(method, (tx: ScopedTx) => {
      const fn = (tx as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        throw new Error(`Unsupported raw operation "${method}".`);
      }
      return (fn as (...a: unknown[]) => Promise<unknown>).apply(tx, args);
    });
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;

    if (property === "$transaction") return scopedTransaction;
    if (RAW_METHODS.has(property)) return scopedRaw(property);

    if (property === "$connect") {
      return () => getScopedClient().$connect();
    }
    if (property === "$disconnect") {
      return () => getScopedClient().$disconnect();
    }
    if (property.startsWith("$")) {
      throw new Error(
        `prisma.${property} is not available through the scoped client — every statement must run inside a request scope.`,
      );
    }

    return scopedDelegate(property);
  },
});
