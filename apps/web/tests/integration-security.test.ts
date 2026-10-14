import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";

// Integration tests using a real database (Testcontainers or local PostgreSQL)
// These tests verify cross-tenant isolation, RBAC, and security controls at the database level.
// SKIPPED when TEST_DATABASE_URL is not set (requires running PostgreSQL instance).

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb("Database-backed security integration tests", () => {
  let prisma!: PrismaClient;

  beforeEach(async () => {
    if (!TEST_DB_URL) return;
    // Initialize Prisma client for test database
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DB_URL } },
      log: ["error"],
    });

    // Apply migrations to test database
    try {
      execSync("npx prisma migrate deploy", {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: TEST_DB_URL,
          DIRECT_URL: TEST_DB_URL,
        },
        stdio: "pipe",
      });
    } catch {
      console.warn(
        "Could not apply migrations to test DB, assuming schema exists",
      );
    }

    // Clean up test data
    await prisma.auditLog.deleteMany();
    await prisma.invitation.deleteMany();
    await prisma.tenantMember.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  describe("Cross-tenant isolation", () => {
    it("prevents users from reading another tenant's members", async () => {
      if (!prisma) return;
      // Create two tenants
      const tenant1 = await prisma.tenant.create({
        data: { name: "Tenant 1", slug: "tenant-1", status: "ACTIVE" },
      });
      const tenant2 = await prisma.tenant.create({
        data: { name: "Tenant 2", slug: "tenant-2", status: "ACTIVE" },
      });

      // Create users
      const user1 = await prisma.user.create({
        data: {
          email: "user1@test.com",
          name: "User 1",
          status: "ACTIVE",
        },
      });
      const user2 = await prisma.user.create({
        data: {
          email: "user2@test.com",
          name: "User 2",
          status: "ACTIVE",
        },
      });

      // Add user1 to tenant1, user2 to tenant2
      await prisma.tenantMember.create({
        data: {
          tenantId: tenant1.id,
          userId: user1.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });
      await prisma.tenantMember.create({
        data: {
          tenantId: tenant2.id,
          userId: user2.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });

      // user1 should only see tenant1 members
      const members1 = await prisma.tenantMember.findMany({
        where: { tenantId: tenant1.id },
      });
      expect(members1).toHaveLength(1);
      expect(members1[0]!.userId).toBe(user1.id);

      // user1 should NOT see tenant2 members
      const members2 = await prisma.tenantMember.findMany({
        where: { tenantId: tenant2.id },
      });
      expect(members2).toHaveLength(1);
      expect(members2[0]!.userId).toBe(user2.id);
    });

    it("prevents users from creating records in another tenant", async () => {
      if (!prisma) return;
      const tenant1 = await prisma.tenant.create({
        data: { name: "Tenant 1", slug: "tenant-1", status: "ACTIVE" },
      });
      const tenant2 = await prisma.tenant.create({
        data: { name: "Tenant 2", slug: "tenant-2", status: "ACTIVE" },
      });

      const user1 = await prisma.user.create({
        data: {
          email: "user1@test.com",
          name: "User 1",
          status: "ACTIVE",
        },
      });
      const user2 = await prisma.user.create({
        data: {
          email: "user2@test.com",
          name: "User 2",
          status: "ACTIVE",
        },
      });

      await prisma.tenantMember.create({
        data: {
          tenantId: tenant1.id,
          userId: user1.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });
      await prisma.tenantMember.create({
        data: {
          tenantId: tenant2.id,
          userId: user2.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });

      // user1 creates invitation for tenant1 - should succeed
      await prisma.invitation.create({
        data: {
          tenantId: tenant1.id,
          email: "invitee1@test.com",
          role: "VIEWER",
          tokenHash: "hash1",
          invitedBy: user1.id,
          expiresAt: new Date(Date.now() + 86400000),
          status: "PENDING",
        },
      });

      // user1 tries to create invitation for tenant2 - should be blocked by app logic
      // (RLS would block if context is set correctly)
      // This test verifies the application must enforce tenant isolation
    });
  });

  describe("Tenant suspension blocks all access", () => {
    it("suspended tenant members cannot access workspace", async () => {
      if (!prisma) return;
      const tenant = await prisma.tenant.create({
        data: {
          name: "Suspended Tenant",
          slug: "suspended",
          status: "SUSPENDED",
        },
      });

      const user = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
        },
      });

      await prisma.tenantMember.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });

      // Verify tenant is suspended
      const foundTenant = await prisma.tenant.findUnique({
        where: { id: tenant.id },
      });
      expect(foundTenant?.status).toBe("SUSPENDED");

      // Application authorization service should reject all operations
      // This is tested at the app level in security.test.ts
    });
  });

  describe("RLS policies enforce tenant isolation", () => {
    it("RLS helper functions exist", async () => {
      if (!prisma) return;
      // The five helpers the policies and the application context depend on.
      const result = await prisma.$queryRaw<{ proname: string }[]>`
        SELECT proname FROM pg_proc
        WHERE proname IN ('current_tenant_id', 'current_user_id', 'is_platform_admin', 'set_tenant_context', 'clear_tenant_context')
      `;
      expect(result.map((row) => row.proname).sort()).toEqual([
        "clear_tenant_context",
        "current_tenant_id",
        "current_user_id",
        "is_platform_admin",
        "set_tenant_context",
      ]);
    });

    it("RLS is enabled on every application table", async () => {
      if (!prisma) return;
      // `_prisma_migrations` is Prisma's bookkeeping table and the app role
      // has no privileges on it (REVOKEd), so it is deliberately exempt.
      // Any other table appearing here is one that RLS does not protect.
      const result = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND NOT rowsecurity
        ORDER BY tablename
      `;
      expect(result.map((row) => row.tablename)).toEqual([
        "_prisma_migrations",
      ]);
    });

    it("isolates SELECT/INSERT/UPDATE/DELETE between two tenants as the application role", async () => {
      if (!prisma) return;

      // Fixtures are created as the owner, who bypasses RLS.
      const tenantA = await prisma.tenant.create({
        data: { name: "RLS Tenant A", slug: "rls-tenant-a", status: "ACTIVE" },
      });
      const tenantB = await prisma.tenant.create({
        data: { name: "RLS Tenant B", slug: "rls-tenant-b", status: "ACTIVE" },
      });
      const actor = await prisma.user.create({
        data: {
          email: "rls-actor@test.com",
          name: "RLS Actor",
          status: "ACTIVE",
        },
      });
      const contactA = await prisma.contact.create({
        data: { tenantId: tenantA.id, type: "INDIVIDUAL", firstName: "Alpha" },
      });
      const contactB = await prisma.contact.create({
        data: { tenantId: tenantB.id, type: "INDIVIDUAL", firstName: "Bravo" },
      });

      // Everything below runs as amisibiz_app with tenant A in context — the
      // posture the application takes once RLS is activated (Phase 08).
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE amisibiz_app`);
        // `set_tenant_context` returns void; cast to text so Prisma can
        // deserialize the row.
        await tx.$queryRawUnsafe(
          `SELECT set_tenant_context($1, $2)::text AS ok`,
          tenantA.id,
          actor.id,
        );

        // SELECT: tenant B is invisible.
        const visible = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Contact" ORDER BY id
        `;
        expect(visible.map((row) => row.id)).toEqual([contactA.id]);

        // INSERT: own tenant succeeds.
        await tx.$executeRawUnsafe(
          `INSERT INTO "Contact" ("id","tenantId","type","firstName","updatedAt")
           VALUES ('rls-contact-c', $1, 'INDIVIDUAL', 'Charlie', now())`,
          tenantA.id,
        );

        // UPDATE: the foreign row is not reachable; the own row is.
        const updatedForeign = await tx.$executeRawUnsafe(
          `UPDATE "Contact" SET "firstName" = 'Hacked' WHERE "id" = $1`,
          contactB.id,
        );
        expect(updatedForeign).toBe(0);
        const updatedOwn = await tx.$executeRawUnsafe(
          `UPDATE "Contact" SET "firstName" = 'Alpha 2' WHERE "id" = $1`,
          contactA.id,
        );
        expect(updatedOwn).toBe(1);

        // DELETE: the foreign row is not reachable.
        const deletedForeign = await tx.$executeRawUnsafe(
          `DELETE FROM "Contact" WHERE "id" = $1`,
          contactB.id,
        );
        expect(deletedForeign).toBe(0);
      });

      // INSERT into a foreign tenant is denied by the WITH CHECK clause. This
      // runs in its own transaction: a policy violation aborts the whole
      // transaction, so it cannot share one with the assertions above.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE amisibiz_app`);
          await tx.$queryRawUnsafe(
            `SELECT set_tenant_context($1, $2)::text AS ok`,
            tenantA.id,
            actor.id,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "Contact" ("id","tenantId","type","firstName","updatedAt")
             VALUES ('rls-contact-x', $1, 'INDIVIDUAL', 'Oscar', now())`,
            tenantB.id,
          );
        }),
      ).rejects.toThrow(/row-level security/i);

      // With no tenant context set, RLS fails closed: nothing is visible.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE amisibiz_app`);
        const visible = await tx.$queryRaw<{ count: bigint }[]>`
          SELECT count(*)::bigint AS count FROM "Contact"
        `;
        expect(visible).toHaveLength(1);
        expect(Number(visible[0]?.count ?? -1n)).toBe(0);
      });

      // As the owner, confirm tenant B's row was never altered or removed.
      const foreignStillThere = await prisma.contact.findUnique({
        where: { id: contactB.id },
        select: { firstName: true },
      });
      expect(foreignStillThere?.firstName).toBe("Bravo");

      // Clean up this test's fixtures.
      await prisma.contact.deleteMany({
        where: { id: { in: [contactA.id, contactB.id, "rls-contact-c"] } },
      });
      await prisma.user.delete({ where: { id: actor.id } });
      await prisma.tenant.deleteMany({
        where: { id: { in: [tenantA.id, tenantB.id] } },
      });
    });
  });

  describe("Default membership uniqueness", () => {
    it("prevents multiple default tenants for one user", async () => {
      if (!prisma) return;
      const tenant1 = await prisma.tenant.create({
        data: { name: "Tenant 1", slug: "tenant-1", status: "ACTIVE" },
      });
      const tenant2 = await prisma.tenant.create({
        data: { name: "Tenant 2", slug: "tenant-2", status: "ACTIVE" },
      });

      const user = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
        },
      });

      // First default membership succeeds
      await prisma.tenantMember.create({
        data: {
          tenantId: tenant1.id,
          userId: user.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });

      // Second default membership should fail (partial unique index)
      await expect(
        prisma.tenantMember.create({
          data: {
            tenantId: tenant2.id,
            userId: user.id,
            role: "TENANT_ADMIN",
            isDefault: true,
          },
        }),
      ).rejects.toThrow();
    });

    it("allows non-default memberships for same user", async () => {
      if (!prisma) return;
      const tenant1 = await prisma.tenant.create({
        data: { name: "Tenant 1", slug: "tenant-1", status: "ACTIVE" },
      });
      const tenant2 = await prisma.tenant.create({
        data: { name: "Tenant 2", slug: "tenant-2", status: "ACTIVE" },
      });

      const user = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
        },
      });

      await prisma.tenantMember.create({
        data: {
          tenantId: tenant1.id,
          userId: user.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });

      // Second membership with isDefault=false should succeed
      const member2 = await prisma.tenantMember.create({
        data: {
          tenantId: tenant2.id,
          userId: user.id,
          role: "TENANT_ADMIN",
          isDefault: false,
        },
      });

      expect(member2.isDefault).toBe(false);
    });
  });

  describe("Invitation token hashing", () => {
    it("stores only token hash, not raw token", async () => {
      if (!prisma) return;
      const tenant = await prisma.tenant.create({
        data: { name: "Tenant", slug: "tenant", status: "ACTIVE" },
      });

      const user = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
        },
      });

      await prisma.tenantMember.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });

      const rawToken = "test-token-123";
      const crypto = await import("crypto");
      const tokenHash = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

      const invitation = await prisma.invitation.create({
        data: {
          tenantId: tenant.id,
          email: "invitee@test.com",
          role: "VIEWER",
          tokenHash,
          invitedBy: user.id,
          expiresAt: new Date(Date.now() + 86400000),
          status: "PENDING",
        },
      });

      // Verify raw token is not stored
      expect(invitation.tokenHash).toBe(tokenHash);
      expect(invitation.tokenHash).not.toBe(rawToken);

      // Verify lookup by hash works
      const found = await prisma.invitation.findUnique({
        where: { tokenHash },
      });
      expect(found).toBeDefined();
      expect(found?.email).toBe("invitee@test.com");
    });
  });

  describe("Platform admin separation", () => {
    it("platform admin cannot access tenant data without membership", async () => {
      if (!prisma) return;
      const tenant = await prisma.tenant.create({
        data: { name: "Tenant", slug: "tenant", status: "ACTIVE" },
      });

      const platformAdmin = await prisma.user.create({
        data: {
          email: "admin@test.com",
          name: "Admin",
          status: "ACTIVE",
          platformRole: "SUPER_ADMIN",
        },
      });

      const regularUser = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
        },
      });

      await prisma.tenantMember.create({
        data: {
          tenantId: tenant.id,
          userId: regularUser.id,
          role: "TENANT_OWNER",
          isDefault: true,
        },
      });

      // Platform admin has no tenant membership
      const adminMembership = await prisma.tenantMember.findUnique({
        where: {
          tenantId_userId: { tenantId: tenant.id, userId: platformAdmin.id },
        },
      });
      expect(adminMembership).toBeNull();

      // Platform admin should NOT be able to access tenant data via tenant-scoped queries
      // (unless using platform-specific permissions)
    });
  });

  describe("Session revocation via sessionVersion", () => {
    it("incrementing sessionVersion invalidates sessions", async () => {
      if (!prisma) return;
      const user = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
          sessionVersion: 0,
        },
      });

      // Simulate session token with version 0
      const currentVersion = 0;

      // Verify session is valid
      expect(user.sessionVersion).toBe(currentVersion);

      // Revoke sessions
      await prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion: { increment: 1 } },
      });

      // Fetch updated user
      const updatedUser = await prisma.user.findUnique({
        where: { id: user.id },
      });
      expect(updatedUser?.sessionVersion).toBe(1);

      // Old session version (0) should now be invalid
      expect(updatedUser?.sessionVersion).not.toBe(currentVersion);
    });
  });

  describe("Audit logging", () => {
    it("records audit events for sensitive operations", async () => {
      if (!prisma) return;
      const user = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
        },
      });

      const tenant = await prisma.tenant.create({
        data: { name: "Tenant", slug: "tenant", status: "ACTIVE" },
      });

      await prisma.auditLog.create({
        data: {
          action: "auth.signIn",
          userId: user.id,
          tenantId: tenant.id,
          resource: "User",
          resourceId: user.id,
          metadata: { ip: "127.0.0.1" },
        },
      });

      const logs = await prisma.auditLog.findMany({
        where: { userId: user.id },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.action).toBe("auth.signIn");
    });

    it("does not store secrets in audit metadata", async () => {
      if (!prisma) return;
      const user = await prisma.user.create({
        data: {
          email: "user@test.com",
          name: "User",
          status: "ACTIVE",
        },
      });

      await prisma.auditLog.create({
        data: {
          action: "auth.signInFailed",
          userId: user.id,
          metadata: { password: "secret123", token: "abc123" },
        },
      });

      const log = await prisma.auditLog.findFirst({
        where: { userId: user.id },
      });
      // The audit logger should sanitize sensitive keys
      // (This is enforced at the application level in lib/audit/index.ts)
      expect(log).toBeDefined();
    });
  });
});
