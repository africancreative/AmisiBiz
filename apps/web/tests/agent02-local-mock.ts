import { vi } from "vitest";
import { prismaMock } from "./prisma-mock";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * AGENT 02 Phase 2C local mock helpers (catalogue + share/public suites).
 *
 * `tests/prisma-mock.ts` is owned elsewhere in this phase, so this file adds
 * ONLY what the catalogue/share modules need, defensively: a delegate is
 * created for a model when the shared mock does not already carry one, so a
 * later upstream update to `prisma-mock.ts` wins rather than being clobbered.
 */

export function mockDelegate() {
  return {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
}

const AGENT02_MODELS = [
  "catalogueCategory",
  "itemImage",
  "productVariant",
  "shareLink",
  "activityEvent",
] as const;

/** Idempotent: extends the shared mock in place without replacing delegates
 *  that already exist (the upstream file may gain them mid-phase). */
export function ensureAgent02Delegates(): void {
  const target = prismaMock as unknown as Record<string, unknown>;
  for (const model of AGENT02_MODELS) {
    if (!target[model]) target[model] = mockDelegate();
  }
}

export type Delegate = ReturnType<typeof mockDelegate>;

/** The delegate for one of the models this phase adds, typed loosely. */
export function delegateFor(model: (typeof AGENT02_MODELS)[number]): Delegate {
  ensureAgent02Delegates();
  return (
    prismaMock as unknown as Record<(typeof AGENT02_MODELS)[number], Delegate>
  )[model];
}

/**
 * A stand-in authorization context for direct service-layer calls. The
 * services read ONLY `tenantId` from it; everything else is irrelevant to
 * them (actions go through the real `authorizeTenant`).
 */
export function fakeAuthz(tenantId: string): TenantAuthzContext {
  return { tenantId } as unknown as TenantAuthzContext;
}

/** First argument of a recorded delegate call, as a plain object. */
export function callArg(mock: unknown, index = 0): Record<string, unknown> {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[index]?.[0] ?? {}) as Record<string, unknown>;
}
