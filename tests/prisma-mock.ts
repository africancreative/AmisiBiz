import { vi } from "vitest";

/**
 * Shared Prisma mock. Test files mock `@/lib/db/prisma` with
 * `vi.mock("@/lib/db/prisma", () => import("./prisma-mock"))` and then import
 * `{ prismaMock }` from this module to configure return values and assert calls.
 * The mock exposes only the delegates used by the code under test.
 */
export const prismaMock = {
  tenantMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  invitation: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  tenant: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    groupBy: vi.fn(),
  },
  accountToken: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
};

export const prisma = prismaMock;
