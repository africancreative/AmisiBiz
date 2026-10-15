import { vi } from "vitest";

/**
 * Shared Prisma mock.
 *
 * Test files replace the database module with
 * `vi.mock("@amisibiz/database", () => import("./prisma-mock"))`, then import
 * `{ prismaMock }` here to configure return values and assert calls.
 *
 * Every model in `apps/web/prisma/schema.prisma` gets a delegate with the full
 * Prisma method surface. That is deliberate: `vi.mock` swaps the whole module, so
 * a missing model would surface as `Cannot read properties of undefined` in an
 * unrelated assertion, and adding delegates one failure at a time makes the
 * harness the bottleneck instead of the behaviour under test.
 */
function mockDelegate() {
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

export const prismaMock = {
  tenant: mockDelegate(),
  // Phase 2's informational plan catalogue (`model Plan` in schema.prisma). The
  // provider console reads it and `assignTenantPlanAction` checks the plan's
  // status through this delegate, so a missing entry would surface as an
  // unrelated `undefined` error rather than as a behaviour difference.
  plan: mockDelegate(),
  tenantSettings: mockDelegate(),
  tenantBranding: mockDelegate(),
  tenantDomain: mockDelegate(),
  tenantStatusHistory: mockDelegate(),
  permission: mockDelegate(),
  rolePermission: mockDelegate(),
  supportAccessGrant: mockDelegate(),
  taxCategory: mockDelegate(),
  taxRate: mockDelegate(),
  contact: mockDelegate(),
  contactAddress: mockDelegate(),
  item: mockDelegate(),
  contactItem: mockDelegate(),
  document: mockDelegate(),
  documentLine: mockDelegate(),
  documentPayment: mockDelegate(),
  documentStatusEvent: mockDelegate(),
  documentNumbering: mockDelegate(),
  documentNumberSequence: mockDelegate(),
  user: mockDelegate(),
  tenantMember: mockDelegate(),
  invitation: mockDelegate(),
  // Audit rows are appended through `$executeRaw`, never through this delegate —
  // see `apps/web/src/lib/audit/index.ts` for the RLS reason.
  auditLog: mockDelegate(),
  // Phase 06 server half: the push receipt store and the pull tombstone store.
  // They are ordinary models in `schema.prisma`, so they get ordinary delegates
  // for the same reason the comment at the top of this file gives.
  syncOperation: mockDelegate(),
  syncDeletion: mockDelegate(),
  $transaction: vi.fn(async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(prismaMock)
      : await Promise.all(arg as Promise<unknown>[]),
  ),
  // Raw SQL paths. The audit append and the bootstrap lookups both go through
  // these, and the real client always resolves them (an INSERT to a row count,
  // a SELECT to a row array), so the defaults mirror that shape. Calls remain
  // fully recorded for assertions, and tests override per case.
  $executeRaw: vi.fn(async (): Promise<number> => 1),
  $executeRawUnsafe: vi.fn(async (): Promise<number> => 1),
  $queryRaw: vi.fn(async (): Promise<unknown[]> => []),
  $queryRawUnsafe: vi.fn(async (): Promise<unknown[]> => []),
};

export const prisma = prismaMock;

/**
 * RLS scope stubs.
 *
 * `vi.mock("@amisibiz/database", ...)` replaces the whole module, so every name
 * the application imports from it has to exist here — including the scope API
 * added in Phase 1. The real implementation drives a pooled transaction and
 * `set_tenant_context`; unit tests have no database, so these keep the same
 * contract (an ambient scope per async context, fail-closed `requireScope`)
 * without a connection.
 */
export class ScopeNotSetError extends Error {
  constructor(operation: string) {
    super(
      `[test scope] Database operation "${operation}" was attempted outside a request scope.`,
    );
    this.name = "ScopeNotSetError";
  }
}

export type MockScope = {
  readonly userId: string | null;
  readonly tenantId: string | null;
  readonly tenantRole: string | null;
  readonly isPlatformAdmin: boolean;
  readonly isPlatformSupport: boolean;
  readonly reason: string;
};

let activeScope: MockScope | null = null;

/** Test hook: the scope the code under test currently believes it is in. */
export function mockActiveScope(): MockScope | null {
  return activeScope;
}

/** Test hook: reset the ambient scope between cases. */
export function resetMockScope(): void {
  activeScope = null;
}

export function bootstrapScope(userId: string | null = null): MockScope {
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
  claims: { isPlatformAdmin?: boolean; isPlatformSupport?: boolean } = {},
): MockScope {
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
  claims: { isPlatformAdmin?: boolean; isPlatformSupport?: boolean } = {},
): MockScope {
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

export function currentScope(): MockScope | null {
  return activeScope;
}

export function hasScope(): boolean {
  return activeScope !== null;
}

export function requireScope(operation: string): MockScope {
  if (!activeScope) throw new ScopeNotSetError(operation);
  return activeScope;
}

export function enterScope(scope: MockScope): void {
  activeScope = scope;
}

/** The context write is a database concern; in tests it is observed, not executed. */
export const applyTenantContext = vi.fn(async (): Promise<void> => {});

/**
 * Statements run against the mocked delegates. Both helpers route through
 * `prismaMock.$transaction` exactly like the real scope (an interactive
 * transaction per unit of work), so tests that assert on transaction use stay
 * meaningful instead of silently passing.
 */
export async function runInScope<T>(
  scope: MockScope,
  fn: (tx: typeof prismaMock) => Promise<T>,
): Promise<T> {
  const previous = activeScope;
  activeScope = scope;
  try {
    return (await prismaMock.$transaction(async () => fn(prismaMock))) as T;
  } finally {
    activeScope = previous;
  }
}

export async function runScoped<T>(
  operation: string,
  fn: (tx: typeof prismaMock) => Promise<T>,
): Promise<T> {
  requireScope(operation);
  if (activeScope) return fn(prismaMock);
  return (await prismaMock.$transaction(async () => fn(prismaMock))) as T;
}

export function currentTransaction(): typeof prismaMock | null {
  return activeScope ? prismaMock : null;
}

export function scopeParams(
  scope: MockScope,
): [string, string, string, boolean, boolean] {
  return [
    scope.tenantId ?? "",
    scope.userId ?? "",
    scope.tenantRole ?? "",
    scope.isPlatformAdmin,
    scope.isPlatformSupport,
  ];
}

export const APP_DATABASE_URL_ENV = "APP_DATABASE_URL";
export const getScopedClient = vi.fn(() => prismaMock);
export const disconnectScopedClient = vi.fn(async (): Promise<void> => {});
export const pingDatabase = vi.fn(async (): Promise<boolean> => true);
export const connectionBypassesRowLevelSecurity = vi.fn(
  async (): Promise<boolean> => false,
);
export const assertRowLevelSecurityActive = vi.fn(
  async (): Promise<{ ok: true }> => ({ ok: true }),
);
export const createAdminSupabase = vi.fn();

/**
 * Flatten every bound value passed to `$executeRaw` so far.
 *
 * Audit events are appended with a raw parameterised INSERT (an ORM `create()`
 * would emit `RETURNING` and be filtered by the SELECT policy, which a viewer
 * cannot satisfy). The values array therefore carries the action, tenant, user
 * and resource of each event — enough to assert what was audited without
 * pretending to be the old `auditLog.create` call shape.
 */
export function rawSqlValues(): unknown[] {
  return prismaMock.$executeRaw.mock.calls
    .flat(2)
    .filter((value) => !Array.isArray(value));
}

/**
 * Every audit action appended so far, in order.
 *
 * This reads the recorded `INSERT INTO "AuditLog"` rows rather than pattern
 * matching every bound string: the action vocabulary is camelCase in its second
 * segment (`tenant.writeDenied`, `support.accessDenied`,
 * `platform.tenantBrandingUpdated`), and a loose regex would both miss those and
 * pick up unrelated dotted parameters such as a hostname.
 */
export function auditedActions(): string[] {
  return auditRows().map((row) => row.action);
}

/**
 * Rebuild the appended audit rows from the parameterised INSERT.
 *
 * `appendAuditLog` binds the columns in a fixed order, so each recorded call can
 * be read back as a row: `["INSERT INTO "AuditLog" (…", tenantId, userId,
 * action, resource, resourceId, metadata, ipAddress, userAgent]`. Empty strings
 * are the SQL-side marker for NULL (`nullif(… , '')`), so they are reported as
 * `null` here — tests then describe what landed in the table, not the encoding.
 */
export type MockAuditRow = {
  tenantId: string | null;
  userId: string | null;
  action: string;
  resource: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
};

function nullable(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The bound metadata is JSON text on the wire; tests read it as an object. */
function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function auditRows(): MockAuditRow[] {
  // The mock is declared without parameters (the real signature takes a tagged
  // template plus values), so the recorded call tuples need re-widening here.
  const calls = prismaMock.$executeRaw.mock.calls as unknown as unknown[][];

  return calls
    .filter((call) =>
      String((call[0] as readonly string[] | undefined)?.[0] ?? "").includes(
        'INSERT INTO "AuditLog"',
      ),
    )
    .map((call) => ({
      tenantId: nullable(call[1]),
      userId: nullable(call[2]),
      action: String(call[3]),
      resource: nullable(call[4]),
      resourceId: nullable(call[5]),
      metadata: parseMetadata(call[6]),
    }));
}

/** The audit rows written for one action, in order. */
export function auditsFor(action: string): MockAuditRow[] {
  return auditRows().filter((row) => row.action === action);
}
