/**
 * Database-backed authorization harness (task #37).
 *
 * These tests are the reason `docs/architecture/security-model.md` §13.6 can
 * stop saying "offline scratch battery only". Everything below runs against a
 * disposable PostgreSQL as the role the policies were written for: the tests
 * connect as the table owner (which bypasses RLS) only to build fixtures, then
 * switch to `amisibiz_app` inside a transaction with `SET LOCAL ROLE` and assert
 * what the policies actually allow.
 *
 * What each case proves, mapped to the eight required proofs:
 *   proof 1  anonymous/other Supabase roles hold no privileges
 *   proof 2  tenant A cannot read tenant B
 *   proof 3  tenant A cannot mutate or delete tenant B
 *   proof 5  a portal seat is not a business seat
 *   proof 6  users cannot elevate their own role
 *   proof 7  tenant ids cannot be forged into access
 *   plus the Phase 2 suspension split, the support grant, the viewer ban, the
 *   append-only audit table, least privilege over foreign tables, and the
 *   code↔database permission-catalog parity.
 *
 * SAFETY: this file refuses to run against anything that looks like the shared
 * Supabase project. `TEST_DATABASE_URL` must point at a local/disposable
 * database (docs/RUNBOOK.md §5), never the pooled production instance.
 *
 *   PGHOST=localhost PGPORT=55499 sh scripts/db/cleanroom-chain.sh   # batteries
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55499/<freshdb> \
 *     pnpm --filter @amisibiz/web vitest run tests/integration-security.test.ts
 *
 * Skipped (not failed) when `TEST_DATABASE_URL` is unset, so the ordinary
 * `pnpm test:run` gate stays green on a machine without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import {
  ALL_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
} from "@amisibiz/auth";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * A connection string that could reach the shared project. The pooled Supabase
 * host is the only reason this is a list rather than a check for "localhost".
 */
const FORBIDDEN_HOSTS = [
  /\.supabase\.co/i,
  /pooler\.supabase\.com/i,
  /jqaqfphdhknkyhjsvqep/i,
];

function assertDisposable(url: string): void {
  const hit = FORBIDDEN_HOSTS.find((pattern) => pattern.test(url));
  if (hit) {
    throw new Error(
      "REFUSING TO RUN: TEST_DATABASE_URL looks like the shared Supabase project. " +
        "This harness creates, alters and drops rows; point it at a disposable " +
        "database (docs/RUNBOOK.md §5) instead.",
    );
  }
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * `SET LOCAL timezone = ...` cannot take a bound parameter, so the name is
 * validated against the shape a timezone identifier can have and then quoted.
 * Only the harness's own literals reach here.
 */
function sqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9_+/ -]+$/.test(value)) {
    throw new Error(`Refusing to interpolate an unsafe SQL literal: ${value}`);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Fixture handles, created once by the owner and torn down at the end. */
type Fixtures = {
  tenantA: string; // ACTIVE, owns contactA/itemA
  tenantB: string; // ACTIVE, owns contactB/itemB
  tenantS: string; // SUSPENDED, owns contactS
  tenantX: string; // ACTIVE spare, so the self-suspension probe cannot disturb A
  ownerA: string; // TENANT_OWNER of A
  ownerB: string; // TENANT_OWNER of B
  ownerX: string; // TENANT_OWNER of X
  viewerA: string; // VIEWER of A
  ownerS: string; // TENANT_OWNER of the suspended tenant
  support: string; // SUPER-free PLATFORM SUPPORT user
  portal: string; // CUSTOMER_PORTAL_USER of A
  superAdmin: string; // platformRole SUPER_ADMIN, no membership anywhere
  contactA: string;
  contactB: string;
  contactS: string;
  itemA: string;
};

describeDb("database-backed authorization proofs (as amisibiz_app)", () => {
  // Built in `beforeAll`, once TEST_DATABASE_URL has been proven disposable —
  // constructing it at collection time would hand Prisma an undefined URL on a
  // machine with no test database, where this whole suite is skipped.
  let owner!: PrismaClient;
  let fx!: Fixtures;

  /**
   * Run one statement group as the runtime role with a tenant context installed.
   * `SET LOCAL ROLE` and `set_tenant_context(...)` are both transaction-local, so
   * nothing leaks into the next case. A policy violation aborts its own
   * transaction, which is why denial cases that expect a throw get their own
   * call rather than sharing one.
   */
  async function asApp<T>(
    scope: {
      tenantId: string | null;
      userId: string;
      role: string | null;
      platform?: boolean;
      /**
       * Opens the transaction in a specific session timezone. Used by the window
       * proof: a `timestamp WITHOUT TIME ZONE` column means different instants to
       * connections in different zones, which is what migration 20261021000001
       * removes.
       */
      timezone?: string;
    },
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE amisibiz_app`);
      if (scope.timezone) {
        await tx.$executeRawUnsafe(
          `SET LOCAL timezone = ${sqlLiteral(scope.timezone)}`,
        );
      }
      await tx.$queryRawUnsafe(
        `SELECT public.set_tenant_context($1, $2, $3, $4, false)::text AS ok`,
        scope.tenantId,
        scope.userId,
        scope.role,
        scope.platform === true,
      );
      return fn(tx as unknown as PrismaClient);
    });
  }

  beforeAll(async () => {
    assertDisposable(TEST_DATABASE_URL!);

    owner = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
      log: ["error"],
    });

    // Bring the disposable database to the current schema. Both URLs are pinned
    // to the test database here — `prisma migrate deploy` resolves DIRECT_URL
    // from apps/web/.env otherwise, which is the production pooler
    // (docs/RUNBOOK.md §5). Failures are thrown, never warned away: a suite that
    // silently ran against a stale schema would prove nothing.
    try {
      execSync("npx prisma migrate deploy", {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: TEST_DATABASE_URL!,
          DIRECT_URL: TEST_DATABASE_URL!,
        },
        stdio: "pipe",
      });
    } catch (error) {
      throw new Error(
        "prisma migrate deploy failed against TEST_DATABASE_URL; the harness will " +
          `not run against a partial schema: ${String(error)}`,
      );
    }

    // The disposable database's timezone is pinned to UTC — Supabase's own
    // servers run UTC, and the schema's window columns (`SupportAccessGrant
    // .expiresAt`, `Invitation.expiresAt`) are `timestamp(3) WITHOUT TIME ZONE`,
    // so a +03 session makes every window Prisma wrote (UTC) look three hours
    // shorter. Pinning the test database keeps the harness honest about the
    // production posture instead of papering over it; the column-type finding is
    // tracked separately (`docs/IMPLEMENTATION_STATUS.md` risks).
    const dbName = new URL(TEST_DATABASE_URL!).pathname
      .slice(1)
      .replace(/"/g, "");
    await owner.$executeRawUnsafe(
      `ALTER DATABASE "${dbName}" SET timezone = 'UTC'`,
    );
    // Pool connections pick the database default up when they are established.
    await owner.$disconnect();

    const run = Date.now().toString(36);
    const mk = (label: string) => `${label}-${run}@example.test`;

    const [tenantA, tenantB, tenantS, tenantX] = await Promise.all([
      owner.tenant.create({
        data: {
          name: `Harness A ${run}`,
          slug: `harness-a-${run}`,
          status: "ACTIVE",
        },
      }),
      owner.tenant.create({
        data: {
          name: `Harness B ${run}`,
          slug: `harness-b-${run}`,
          status: "ACTIVE",
        },
      }),
      owner.tenant.create({
        data: {
          name: `Harness S ${run}`,
          slug: `harness-s-${run}`,
          status: "SUSPENDED",
          suspendedAt: new Date(),
          suspensionReason: "harness fixture",
        },
      }),
      owner.tenant.create({
        data: {
          name: `Harness X ${run}`,
          slug: `harness-x-${run}`,
          status: "ACTIVE",
        },
      }),
    ]);

    const [
      ownerA,
      ownerB,
      viewerA,
      ownerS,
      support,
      portal,
      superAdmin,
      ownerX,
    ] = await Promise.all([
      owner.user.create({
        data: { email: mk("owner-a"), name: "Owner A", status: "ACTIVE" },
      }),
      owner.user.create({
        data: { email: mk("owner-b"), name: "Owner B", status: "ACTIVE" },
      }),
      owner.user.create({
        data: { email: mk("viewer-a"), name: "Viewer A", status: "ACTIVE" },
      }),
      owner.user.create({
        data: { email: mk("owner-s"), name: "Owner S", status: "ACTIVE" },
      }),
      owner.user.create({
        data: {
          email: mk("support"),
          name: "Support",
          status: "ACTIVE",
          platformRole: "SUPPORT",
        },
      }),
      owner.user.create({
        data: { email: mk("portal"), name: "Portal", status: "ACTIVE" },
      }),
      owner.user.create({
        data: {
          email: mk("super"),
          name: "Super Admin",
          status: "ACTIVE",
          platformRole: "SUPER_ADMIN",
        },
      }),
      owner.user.create({
        data: { email: mk("owner-x"), name: "Owner X", status: "ACTIVE" },
      }),
    ]);

    await Promise.all([
      owner.tenantMember.create({
        data: {
          tenantId: tenantA.id,
          userId: ownerA.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      }),
      owner.tenantMember.create({
        data: {
          tenantId: tenantB.id,
          userId: ownerB.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      }),
      owner.tenantMember.create({
        data: {
          tenantId: tenantA.id,
          userId: viewerA.id,
          role: "VIEWER",
          isDefault: true,
        },
      }),
      owner.tenantMember.create({
        data: {
          tenantId: tenantS.id,
          userId: ownerS.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      }),
      owner.tenantMember.create({
        data: {
          tenantId: tenantX.id,
          userId: ownerX.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      }),
      owner.tenantMember.create({
        data: {
          tenantId: tenantA.id,
          userId: portal.id,
          role: "CUSTOMER_PORTAL_USER",
          isDefault: true,
        },
      }),
      owner.supportAccessGrant.create({
        data: {
          tenantId: tenantA.id,
          platformUserId: support.id,
          reason: "Harness: read-only support proof",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      }),
      owner.contact.create({
        data: { tenantId: tenantA.id, type: "INDIVIDUAL", firstName: "Alpha" },
      }),
      owner.contact.create({
        data: { tenantId: tenantB.id, type: "INDIVIDUAL", firstName: "Bravo" },
      }),
      owner.contact.create({
        data: {
          tenantId: tenantS.id,
          type: "BUSINESS",
          companyName: "Suspended Co",
        },
      }),
      owner.item.create({
        data: {
          tenantId: tenantA.id,
          name: `Item A ${run}`,
          sku: `A-${run}`,
          unitPrice: "1234.5600",
        },
      }),
    ]);

    fx = {
      tenantA: tenantA.id,
      tenantB: tenantB.id,
      tenantS: tenantS.id,
      tenantX: tenantX.id,
      ownerA: ownerA.id,
      ownerB: ownerB.id,
      ownerX: ownerX.id,
      viewerA: viewerA.id,
      ownerS: ownerS.id,
      support: support.id,
      portal: portal.id,
      superAdmin: superAdmin.id,
      contactA: "",
      contactB: "",
      contactS: "",
      itemA: "",
    };
    [fx.contactA, fx.contactB, fx.contactS, fx.itemA] = await Promise.all([
      owner.contact
        .findFirstOrThrow({
          where: { tenantId: tenantA.id },
          select: { id: true },
        })
        .then((r) => r.id),
      owner.contact
        .findFirstOrThrow({
          where: { tenantId: tenantB.id },
          select: { id: true },
        })
        .then((r) => r.id),
      owner.contact
        .findFirstOrThrow({
          where: { tenantId: tenantS.id },
          select: { id: true },
        })
        .then((r) => r.id),
      owner.item
        .findFirstOrThrow({
          where: { tenantId: tenantA.id },
          select: { id: true },
        })
        .then((r) => r.id),
    ]);
  }, 180_000);

  afterAll(async () => {
    // beforeAll may have failed before either was assigned; never leak a client.
    if (!owner) return;
    if (!fx) {
      await owner.$disconnect();
      return;
    }
    try {
      // Owner-level teardown. `tenant_members_guard_delete` protects real
      // workspaces from losing their last owner, so it is paused for this
      // cleanup only — the same procedure the psql battery documents in its purge
      // block. Without it every fixture workspace's lone owner blocks the
      // cascade, the delete aborts, and the disposable database accumulates
      // tenants between runs.
      await owner.$executeRawUnsafe(
        `ALTER TABLE "TenantMember" DISABLE TRIGGER tenant_members_guard_delete`,
      );
      await owner.auditLog.deleteMany({
        where: {
          tenantId: { in: [fx.tenantA, fx.tenantB, fx.tenantS, fx.tenantX] },
        },
      });
      await owner.tenant.deleteMany({
        where: {
          id: { in: [fx.tenantA, fx.tenantB, fx.tenantS, fx.tenantX] },
        },
      });
      await owner.user.deleteMany({
        where: {
          id: {
            in: [
              fx.ownerA,
              fx.ownerB,
              fx.ownerX,
              fx.viewerA,
              fx.ownerS,
              fx.support,
              fx.portal,
              fx.superAdmin,
            ],
          },
        },
      });
    } finally {
      await owner.$executeRawUnsafe(
        `ALTER TABLE "TenantMember" ENABLE TRIGGER tenant_members_guard_delete`,
      );
      await owner.$disconnect();
    }
  });

  // ─── The enforcement surface itself ────────────────────────────────────────

  it("amisibiz_app is a real enforcement role: no superuser, no BYPASSRLS, NOINHERIT", async () => {
    const rows = await owner.$queryRaw<
      {
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolcanlogin: boolean;
      }[]
    >`
      SELECT rolsuper, rolbypassrls, rolinherit, rolcanlogin
        FROM pg_catalog.pg_roles WHERE rolname = 'amisibiz_app'
    `;
    expect(rows).toHaveLength(1);
    const role = rows[0]!;
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolinherit).toBe(false);
    expect(role.rolcanlogin).toBe(true);
  });

  it("every public application table is row-level-security protected", async () => {
    const rows = await owner.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND NOT rowsecurity
       ORDER BY tablename
    `;
    // `_prisma_migrations` is Prisma's bookkeeping table; the runtime role holds
    // no privilege on it at all (migration 20261015000001). Anything else in this
    // list is an unprotected table and a hard failure.
    expect(rows.map((r) => r.tablename)).toEqual(["_prisma_migrations"]);
  });

  it("the five context helpers the policies depend on all exist", async () => {
    const rows = await owner.$queryRaw<{ proname: string }[]>`
      SELECT proname FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('current_tenant_id','current_user_id','is_platform_admin',
                         'set_tenant_context','clear_tenant_context')
    `;
    expect(rows.map((r) => r.proname).sort()).toEqual([
      "clear_tenant_context",
      "current_tenant_id",
      "current_user_id",
      "is_platform_admin",
      "set_tenant_context",
    ]);
  });

  it("proof 1: roles that are not the runtime role hold no privileges on tenant tables", async () => {
    // Supabase ships `anon` and `authenticated`; a vanilla PostgreSQL (CI) may
    // not have them, so only the roles that exist are asserted.
    const roles = await owner.$queryRaw<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')
    `;
    for (const { rolname } of roles) {
      const granted = await owner.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM information_schema.table_privileges
         WHERE grantee = ${rolname} AND table_schema = 'public'
           AND table_name IN ('Tenant','Contact','Item','Document','User','TenantMember','AuditLog')
      `;
      expect(Number(granted[0]?.n ?? 1n)).toBe(0);
    }
  });

  // ─── Proofs 2 and 3: cross-tenant isolation ────────────────────────────────

  it("proof 2: a tenant sees its own rows and none of another tenant's", async () => {
    const contacts = await asApp(
      { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Contact" ORDER BY id`,
    );
    expect(contacts.map((r) => r.id)).toEqual([fx.contactA]);

    const items = await asApp(
      { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Item"`,
    );
    expect(items.map((r) => r.id)).toEqual([fx.itemA]);

    // The tenant row itself: only the scoped workspace is visible.
    const tenants = await asApp(
      { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Tenant"`,
    );
    expect(tenants.map((r) => r.id)).toEqual([fx.tenantA]);
  });

  it("proof 2: with no tenant context at all, nothing is visible and nothing is writable", async () => {
    const counts = await asApp(
      { tenantId: null, userId: fx.ownerA, role: null },
      (tx) =>
        tx.$queryRaw<
          { contacts: bigint; tenants: bigint; items: bigint; audit: bigint }[]
        >`
          SELECT (SELECT count(*) FROM "Contact")  AS contacts,
                 (SELECT count(*) FROM "Tenant")   AS tenants,
                 (SELECT count(*) FROM "Item")     AS items,
                 (SELECT count(*) FROM "AuditLog") AS audit
        `,
    );
    expect(counts).toHaveLength(1);
    const row = counts[0]!;
    // One object so a failure names the table that leaked instead of just
    // "expected 1 to be 0". `tenants` is 1 on purpose, and only there:
    // `tenant_read_access` has a membership branch (`has_tenant_membership(id)`)
    // so a signed-in user can list the workspaces they belong to before any
    // context is chosen — the workspace switcher depends on it. Every
    // tenant-scoped business table stays at zero, and the next case proves the
    // membership branch reveals only the caller's own workspaces.
    expect({
      contacts: Number(row.contacts),
      items: Number(row.items),
      audit: Number(row.audit),
    }).toEqual({ contacts: 0, items: 0, audit: 0 });
    expect(Number(row.tenants)).toBe(1);

    const ownTenants = await asApp(
      { tenantId: null, userId: fx.ownerA, role: null },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Tenant"`,
    );
    expect(ownTenants.map((r) => r.id)).toEqual([fx.tenantA]);

    // `User` is the deliberate exception: `user_select` lets a connection read
    // its OWN profile row with no tenant context (the session loader needs it).
    // The proof is therefore that exactly one row is visible and it is the
    // caller's — never another user's, and never a platform-role row someone
    // else owns.
    const visibleUsers = await asApp(
      { tenantId: null, userId: fx.ownerA, role: null },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User"`,
    );
    expect(visibleUsers.map((r) => r.id)).toEqual([fx.ownerA]);

    await expect(
      asApp({ tenantId: null, userId: fx.ownerA, role: null }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Contact" ("tenantId","firstName","updatedAt") VALUES ($1::uuid, 'NoContext', now())`,
          fx.tenantA,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("proof 3: another tenant's rows cannot be mutated or deleted", async () => {
    const touched = await asApp(
      { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
      (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "Contact" SET "firstName" = 'Hacked' WHERE "id" = $1::uuid`,
          fx.contactB,
        ),
    );
    // RLS cloaks the row from the USING clause, so the statement matches nothing.
    expect(touched).toBe(0);

    // The stronger barrier sits one layer down: the runtime role holds no DELETE
    // privilege on tenant tables at all, so a destructive statement cannot even
    // reach the policy check. Business records are archived, never deleted.
    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "Contact" WHERE "id" = $1::uuid`,
            fx.contactB,
          ),
      ),
    ).rejects.toThrow(/permission denied/i);

    // The foreign row is untouched, and its own tenant still sees it.
    const stillBravo = await owner.contact.findUnique({
      where: { id: fx.contactB },
      select: { firstName: true },
    });
    expect(stillBravo?.firstName).toBe("Bravo");
  });

  it("proof 3: INSERT into another tenant is refused by the WITH CHECK clause", async () => {
    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "Contact" ("tenantId","firstName","updatedAt") VALUES ($1::uuid, 'CrossTenant', now())`,
            fx.tenantB,
          ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const leaked = await owner.contact.findMany({
      where: { tenantId: fx.tenantB, firstName: "CrossTenant" },
    });
    expect(leaked).toHaveLength(0);
  });

  it("proof 3: a member's own writes do land (the denial above is not a blanket block)", async () => {
    const inserted = await asApp(
      { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
      (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Contact" ("tenantId","firstName","updatedAt") VALUES ($1::uuid, 'OwnTenantOk', now())`,
          fx.tenantA,
        ),
    );
    expect(inserted).toBe(1);

    const visible = await asApp(
      { tenantId: fx.tenantB, userId: fx.ownerB, role: "TENANT_OWNER" },
      (tx) =>
        tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Contact" WHERE "firstName" = 'OwnTenantOk'`,
    );
    expect(visible).toHaveLength(0);

    await owner.contact.deleteMany({
      where: { tenantId: fx.tenantA, firstName: "OwnTenantOk" },
    });
  });

  // ─── Proof 7: forged identifiers ──────────────────────────────────────────

  it("proof 7: forging the tenant GUC without a membership gains nothing", async () => {
    // The application is the only thing that may call set_tenant_context, but a
    // custom GUC is settable by any role on its own session — so the policies
    // must never take `app.current_tenant_id` at face value. They do not: the
    // role comes from TenantMember, re-read by a SECURITY DEFINER helper.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE amisibiz_app`);
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1, true)`,
        fx.tenantB,
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_id', $1, true)`,
        fx.ownerA,
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_role', 'TENANT_OWNER', true)`,
      );

      const visible = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Contact"`;
      // Owner A is not a member of B, so B's rows stay invisible — and A's own
      // rows are not visible under a B context either.
      expect(visible).toHaveLength(0);

      const touched = await tx.$executeRawUnsafe(
        `UPDATE "Contact" SET "firstName" = 'Forged' WHERE "id" = $1::uuid`,
        fx.contactB,
      );
      expect(touched).toBe(0);
    });

    const after = await owner.contact.findUnique({
      where: { id: fx.contactB },
      select: { firstName: true },
    });
    expect(after?.firstName).toBe("Bravo");
  });

  it("proof 7: a claimed platform-admin flag is re-derived, not trusted", async () => {
    // set_tenant_context's p_is_platform_admin argument is decorative: the
    // helper `is_platform_admin()` asks the User row. A plain tenant owner who
    // asks to be treated as platform admin must get nothing.
    const visible = await asApp(
      {
        tenantId: fx.tenantA,
        userId: fx.ownerA,
        role: "TENANT_OWNER",
        platform: true,
      },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Tenant"`,
    );
    expect(visible.map((r) => r.id)).toEqual([fx.tenantA]);
  });

  it("proof 7: set_tenant_context refuses a malformed tenant id instead of poisoning the session", async () => {
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE amisibiz_app`);
        await tx.$queryRawUnsafe(
          `SELECT public.set_tenant_context('not-a-uuid', $1, 'TENANT_OWNER', false, false)::text AS ok`,
          fx.ownerA,
        );
      }),
    ).rejects.toThrow(/invalid input syntax|uuid/i);
  });

  // ─── Proof 6: role elevation ──────────────────────────────────────────────

  it("proof 6: a member cannot grant themselves a platform role", async () => {
    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "User" SET "platformRole" = 'SUPER_ADMIN' WHERE "id" = $1::uuid`,
            fx.ownerA,
          ),
      ),
    ).rejects.toThrow();

    const user = await owner.user.findUnique({
      where: { id: fx.ownerA },
      select: { platformRole: true },
    });
    expect(user?.platformRole ?? null).toBeNull();
  });

  it("proof 6: a member cannot escalate their own tenant role", async () => {
    // viewerA holds VIEWER in tenant A. Escalating to TENANT_OWNER must fail at
    // the database, not merely in the UI. `tenant_member_update` uses
    // `has_tenant_admin_write_access(tenantId)` as its USING clause, so a viewer
    // cannot even see its own membership row for updating: the statement matches
    // zero rows and the role cannot move.
    const touched = await asApp(
      { tenantId: fx.tenantA, userId: fx.viewerA, role: "VIEWER" },
      (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "TenantMember" SET "role" = 'TENANT_OWNER'
            WHERE "tenantId" = $1::uuid AND "userId" = $2::uuid`,
          fx.tenantA,
          fx.viewerA,
        ),
    );
    expect(touched).toBe(0);

    const member = await owner.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId: fx.tenantA, userId: fx.viewerA } },
      select: { role: true },
    });
    expect(member?.role).toBe("VIEWER");
  });

  it("proof 6: a tenant cannot move its own lifecycle status", async () => {
    // `tenant_admin_update` requires has_tenant_admin_write_access, which folds in
    // app_tenant_accepts_writes() — a SUSPENDED tenant fails that test, so the
    // suspended owner cannot see its own Tenant row for updating and the
    // self-reactivation attempt matches zero rows. Reactivation is provider-only.
    const touched = await asApp(
      { tenantId: fx.tenantS, userId: fx.ownerS, role: "TENANT_OWNER" },
      (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "Tenant" SET "status" = 'ACTIVE' WHERE "id" = $1::uuid`,
          fx.tenantS,
        ),
    );
    expect(touched).toBe(0);

    const tenant = await owner.tenant.findUnique({
      where: { id: fx.tenantS },
      select: { status: true },
    });
    expect(tenant?.status).toBe("SUSPENDED");

    // The other half of the same rule, on a workspace that IS writable: tenantX
    // exists so this probe cannot disturb tenant A. An active owner may edit its
    // own profile columns, but `tenant_status_guard` refuses a status move that
    // did not come from a provider context — so self-suspension fails loudly
    // rather than silently doing nothing.
    await expect(
      asApp(
        { tenantId: fx.tenantX, userId: fx.ownerX, role: "TENANT_OWNER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "Tenant" SET "status" = 'SUSPENDED' WHERE "id" = $1::uuid`,
            fx.tenantX,
          ),
      ),
    ).rejects.toThrow(/status|provider|platform/i);
  });

  // ─── Phase 2: the suspension split ────────────────────────────────────────

  it("suspension denies writes but preserves reads for the suspended workspace", async () => {
    const visible = await asApp(
      { tenantId: fx.tenantS, userId: fx.ownerS, role: "TENANT_OWNER" },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Contact"`,
    );
    expect(visible.map((r) => r.id)).toEqual([fx.contactS]);

    await expect(
      asApp(
        { tenantId: fx.tenantS, userId: fx.ownerS, role: "TENANT_OWNER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "Contact" ("tenantId","firstName","updatedAt") VALUES ($1::uuid, 'WhileSuspended', now())`,
            fx.tenantS,
          ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const updated = await asApp(
      { tenantId: fx.tenantS, userId: fx.ownerS, role: "TENANT_OWNER" },
      (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "Contact" SET "firstName" = 'Changed' WHERE "id" = $1::uuid`,
          fx.contactS,
        ),
    );
    expect(updated).toBe(0);

    const untouched = await owner.contact.findUnique({
      where: { id: fx.contactS },
      select: { companyName: true },
    });
    expect(untouched?.companyName).toBe("Suspended Co");
    await owner.contact.deleteMany({
      where: { tenantId: fx.tenantS, firstName: "WhileSuspended" },
    });
  });

  it("a provider can still act on a suspended workspace (the platform branch is not gated)", async () => {
    const inserted = await asApp(
      {
        tenantId: fx.tenantS,
        userId: fx.superAdmin,
        role: null,
        platform: true,
      },
      (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Contact" ("tenantId","firstName","updatedAt") VALUES ($1::uuid, 'ProviderWrite', now())`,
          fx.tenantS,
        ),
    );
    expect(inserted).toBe(1);
    await owner.contact.deleteMany({
      where: { tenantId: fx.tenantS, firstName: "ProviderWrite" },
    });
  });

  // ─── Proofs 4 and 5: the roles that must not write or expand ───────────────

  it("proof 4: a VIEWER can read its workspace and cannot write business records", async () => {
    const visible = await asApp(
      { tenantId: fx.tenantA, userId: fx.viewerA, role: "VIEWER" },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Contact"`,
    );
    expect(visible.map((r) => r.id)).toEqual([fx.contactA]);

    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.viewerA, role: "VIEWER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "Item" ("tenantId","name","sku","unitPrice","updatedAt")
           VALUES ($1::uuid, 'Viewer Item', 'viewer-item', 10, now())`,
            fx.tenantA,
          ),
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.viewerA, role: "VIEWER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "Item" SET "name" = 'Renamed' WHERE "id" = $1::uuid`,
            fx.itemA,
          ),
      ),
    ).resolves.toBe(0);

    const item = await owner.item.findUnique({
      where: { id: fx.itemA },
      select: { name: true },
    });
    expect(item?.name.startsWith("Item A")).toBe(true);
  });

  it("proof 5: a customer-portal seat cannot write and cannot read internal records", async () => {
    await expect(
      asApp(
        {
          tenantId: fx.tenantA,
          userId: fx.portal,
          role: "CUSTOMER_PORTAL_USER",
        },
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "Item" ("tenantId","name","sku","unitPrice","updatedAt")
             VALUES ($1::uuid, 'Portal Item', 'portal-item', 10, now())`,
            fx.tenantA,
          ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const audit = await asApp(
      { tenantId: fx.tenantA, userId: fx.portal, role: "CUSTOMER_PORTAL_USER" },
      (tx) =>
        tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM "AuditLog"`,
    );
    expect(Number(audit[0]?.n ?? 1n)).toBe(0);
  });

  it("a support grant reads the granted workspace only, and never writes", async () => {
    const granted = await asApp(
      { tenantId: fx.tenantA, userId: fx.support, role: null },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Contact"`,
    );
    expect(granted.map((r) => r.id)).toEqual([fx.contactA]);

    // Task #50: the support branch of `has_tenant_read_access` is fenced by the
    // ACTIVE CONTEXT as well as by the grant. A session that claims tenant B must
    // see neither B's rows (no grant) nor A's rows (grant, wrong context) — the
    // grant alone used to be enough, which is the behaviour the first harness run
    // surfaced and recorded in docs/architecture/security-model.md §13.7.
    const elsewhere = await asApp(
      { tenantId: fx.tenantB, userId: fx.support, role: null },
      (tx) =>
        tx.$queryRaw<{ id: string; tenantId: string }[]>`
          SELECT "id", "tenantId" FROM "Contact"`,
    );
    expect(elsewhere).toEqual([]);

    // The one case that stays open is the provider console's own listing: a
    // support session with no tenant context may still see the workspaces it is
    // granted on, before it enters any of them. Per-workspace reads then go
    // through `authorizePlatformTenant(...)`, which sets that tenant's context —
    // so the row fence above is what guards them, not the grant alone.
    const unscoped = await asApp(
      { tenantId: null, userId: fx.support, role: null },
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Contact"`,
    );
    expect(unscoped.map((r) => r.id)).toEqual([fx.contactA]);

    await expect(
      asApp({ tenantId: fx.tenantA, userId: fx.support, role: null }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Contact" ("tenantId","firstName","updatedAt") VALUES ($1::uuid, 'SupportWrite', now())`,
          fx.tenantA,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
    await owner.contact.deleteMany({
      where: { tenantId: fx.tenantA, firstName: "SupportWrite" },
    });
  });

  it("a support window is the same instant in every session timezone", async () => {
    // Task #51. `has_support_grant()` asks `expiresAt > now()`. While the column
    // was `timestamp(3) WITHOUT TIME ZONE`, a connection in Africa/Nairobi (+03)
    // reinterpreted the UTC wall time Prisma had written as local time, so a
    // window that opened for an hour read as already closed — the effect that
    // first made the support path read nothing at all. `createdAt`/`expiresAt` in
    // the fixture below are written exactly the way the server actions write them.
    const grant = await owner.supportAccessGrant.create({
      data: {
        tenantId: fx.tenantX,
        platformUserId: fx.support,
        reason: "Harness: the window is an instant",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    try {
      const inUtc = await asApp(
        { tenantId: fx.tenantX, userId: fx.support, role: null },
        (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Tenant"`,
      );
      const inNairobi = await asApp(
        {
          tenantId: fx.tenantX,
          userId: fx.support,
          role: null,
          timezone: "Africa/Nairobi",
        },
        (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Tenant"`,
      );
      // One granted workspace, seen identically from both sessions.
      expect(inUtc.map((r) => r.id)).toEqual([fx.tenantX]);
      expect(inNairobi.map((r) => r.id)).toEqual([fx.tenantX]);
    } finally {
      await owner.supportAccessGrant.delete({ where: { id: grant.id } });
    }
  });

  // ─── Append-only audit, least privilege over foreign objects ───────────────

  it("audit rows are append-only for the runtime role", async () => {
    const audit = await owner.auditLog.create({
      data: {
        action: "harness.seed",
        tenantId: fx.tenantA,
        userId: fx.ownerA,
        resource: "Contact",
        resourceId: fx.contactA,
      },
    });

    // AuditLog is append-only in the strongest sense available: the runtime role
    // holds INSERT and SELECT only, so tampering never reaches a policy check —
    // it is refused at the privilege layer, which no policy mistake can reopen.
    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "AuditLog" SET "action" = 'harness.tampered' WHERE "id" = $1::uuid`,
            audit.id,
          ),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
        (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "id" = $1::uuid`,
            audit.id,
          ),
      ),
    ).rejects.toThrow(/permission denied/i);

    const row = await owner.auditLog.findUnique({
      where: { id: audit.id },
      select: { action: true },
    });
    expect(row?.action).toBe("harness.seed");
    await owner.auditLog.deleteMany({ where: { id: audit.id } });
  });

  it("least privilege: a table belonging to another application stays unreachable", async () => {
    // The pre-Phase-1 default-privilege river granted the runtime role everything
    // in schema public, including other products' tables. Migration 20261018000002
    // closes it; this proves a table created AFTER that migration is still closed.
    try {
      await owner.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS public.harness_foreign_app_data (id serial PRIMARY KEY, payload text)`,
      );
    } catch {
      // The connecting role may not hold CREATE on a shared schema; that is the
      // stricter posture, so the proof below cannot regress either.
      return;
    }
    await owner.$executeRawUnsafe(
      `INSERT INTO public.harness_foreign_app_data (payload) VALUES ('foreign')`,
    );

    await expect(
      asApp(
        { tenantId: fx.tenantA, userId: fx.ownerA, role: "TENANT_OWNER" },
        (tx) =>
          tx.$queryRaw<
            { id: number }[]
          >`SELECT id FROM public.harness_foreign_app_data`,
      ),
    ).rejects.toThrow(/permission denied/i);

    await owner.$executeRawUnsafe(
      `DROP TABLE IF EXISTS public.harness_foreign_app_data`,
    );
  });

  // ─── Code ↔ database catalog parity ───────────────────────────────────────

  it("the permission catalog in code is the catalog in the database", async () => {
    const permissions = await owner.permission.findMany({
      select: { key: true },
    });
    const dbKeys = permissions.map((p) => p.key).sort();
    const codeKeys = [...ALL_PERMISSIONS].sort();

    expect(dbKeys).toEqual(codeKeys);
    expect(dbKeys.length).toBe(ALL_PERMISSIONS.length);
  });

  it("the role→permission matrix in code is the matrix in the database", async () => {
    const rows = await owner.$queryRaw<{ roleKey: string; key: string }[]>`
      SELECT rp."roleKey" AS "roleKey", p."key" AS key
        FROM "RolePermission" rp JOIN "Permission" p ON p."id" = rp."permissionId"
    `;
    const byRole = new Map<string, string[]>();
    for (const row of rows) {
      const list = byRole.get(row.roleKey) ?? [];
      list.push(row.key);
      byRole.set(row.roleKey, list);
    }

    const codeMatrix: Record<string, readonly string[]> = {
      ...TENANT_ROLE_PERMISSIONS,
      ...PLATFORM_ROLE_PERMISSIONS,
    };
    for (const [roleKey, perms] of Object.entries(codeMatrix)) {
      const dbList = (byRole.get(roleKey) ?? []).sort();
      expect(
        { role: roleKey, keys: dbList },
        `role ${roleKey}: database rows differ from @amisibiz/auth`,
      ).toEqual({ role: roleKey, keys: [...perms].sort() });
    }
    // SUPPORT deliberately holds no tenant permissions directly; its read path is
    // the audited SupportAccessGrant, which the support case above proves.
    expect(byRole.get("SUPPORT") ?? []).toHaveLength(0);
    // Nothing may have leaked platform permissions into a tenant role.
    for (const [roleKey, perms] of Object.entries(TENANT_ROLE_PERMISSIONS)) {
      expect(
        perms.filter((key) => key.startsWith("platform.")),
        `tenant role ${roleKey} must hold no platform.* permission`,
      ).toHaveLength(0);
    }
  });

  it("the plan catalogue holds no entitlement columns", async () => {
    // Owner decision of record: a plan is informational. If somebody adds price,
    // quota or expiry to it, the "no automatic suspension" rule becomes
    // enforceable-by-accident and this shape check should fail the build.
    const cols = await owner.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Plan'
    `;
    const names = cols.map((c) => c.column_name.toLowerCase());
    expect(names).toContain("id");
    for (const forbidden of [
      "price",
      "amount",
      "quota",
      "limit",
      "currency",
      "expiresat",
    ]) {
      expect(
        names,
        `Plan must stay informational (${forbidden})`,
      ).not.toContain(forbidden);
    }
  });

  // ─── Point 9: database-enforced cross-tenant integrity ─────────────────────
  // Agent 2 acceptance gate: "Database constraints reject invalid cross-tenant
  // relationships." Cross-tenant *relationships* are enforced below the
  // application with BEFORE INSERT/UPDATE triggers — the mission's "equivalent
  // database-enforced mechanism" — so a forged reference is rejected even by a
  // query that forgot its tenant predicate. These cases connect as the table
  // owner (bypassing RLS) on purpose: it is the trigger, not the policy, that
  // must refuse the row.

  it("rejects a document that references another tenant's customer", async () => {
    await expect(
      owner.document.create({
        data: { tenantId: fx.tenantA, type: "INVOICE", contactId: fx.contactB },
      }),
    ).rejects.toThrow(/does not belong to tenant/i);
  });

  it("rejects a document derived from or replacing another tenant's document", async () => {
    const docB = await owner.document.create({
      data: { tenantId: fx.tenantB, type: "INVOICE" },
    });

    await expect(
      owner.document.create({
        data: {
          tenantId: fx.tenantA,
          type: "INVOICE",
          sourceDocumentId: docB.id,
        },
      }),
    ).rejects.toThrow(/does not belong to tenant/i);

    await expect(
      owner.document.create({
        data: {
          tenantId: fx.tenantA,
          type: "INVOICE",
          replacementOfId: docB.id,
        },
      }),
    ).rejects.toThrow(/does not belong to tenant/i);
  });

  it("rejects a document line whose parent document is in another tenant", async () => {
    const docB = await owner.document.create({
      data: { tenantId: fx.tenantB, type: "INVOICE" },
    });

    await expect(
      owner.documentLine.create({
        data: {
          tenantId: fx.tenantA,
          documentId: docB.id,
          position: 1,
          description: "forged cross-tenant line",
          quantity: "1",
          unitPrice: "1",
          lineTotal: "1",
          lineNet: "1",
        },
      }),
    ).rejects.toThrow(/not a document of tenant/i);
  });

  it("rejects a document line that references another tenant's item", async () => {
    const [docA, itemB] = await Promise.all([
      owner.document.create({
        data: { tenantId: fx.tenantA, type: "INVOICE" },
      }),
      owner.item.create({
        data: { tenantId: fx.tenantB, name: "Item B", unitPrice: "1" },
      }),
    ]);

    await expect(
      owner.documentLine.create({
        data: {
          tenantId: fx.tenantA,
          documentId: docA.id,
          position: 1,
          description: "forged item link",
          itemId: itemB.id,
          quantity: "1",
          unitPrice: "1",
          lineTotal: "1",
          lineNet: "1",
        },
      }),
    ).rejects.toThrow(/does not belong to tenant/i);
  });

  it("rejects a customer-specific price that mixes tenants", async () => {
    await expect(
      owner.contactItem.create({
        data: {
          tenantId: fx.tenantA,
          contactId: fx.contactB,
          itemId: fx.itemA,
          agreedPrice: "0",
        },
      }),
    ).rejects.toThrow(/does not belong to this tenant/i);
  });

  it("rejects a tax rate under another tenant's tax category", async () => {
    const categoryB = await owner.taxCategory.create({
      data: { tenantId: fx.tenantB, name: "VAT" },
    });

    await expect(
      owner.taxRate.create({
        data: {
          tenantId: fx.tenantA,
          categoryId: categoryB.id,
          name: "Forged 10%",
          rate: "0.1000",
        },
      }),
    ).rejects.toThrow(/does not belong to this tenant/i);
  });

  it("binds a portal seat to at most one customer per tenant", async () => {
    // The portal "membership" is the Contact whose `portalUserId` is the seat.
    // The database allows one such contact per tenant, so a seat cannot be
    // quietly re-pointed at a second customer's documents.
    await owner.contact.create({
      data: {
        tenantId: fx.tenantA,
        type: "INDIVIDUAL",
        firstName: "Portal One",
        portalUserId: fx.portal,
      },
    });

    await expect(
      owner.contact.create({
        data: {
          tenantId: fx.tenantA,
          type: "INDIVIDUAL",
          firstName: "Portal Two",
          portalUserId: fx.portal,
        },
      }),
    ).rejects.toThrow();
  });
});
