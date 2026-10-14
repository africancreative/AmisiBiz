import { existsSync } from "node:fs";
import { PrismaClient, type Prisma } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

// A plain `tsx prisma/seed.ts` run does not load .env (only the Prisma CLI
// does). Load it explicitly so local seeding sees the Supabase credentials.
if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

/**
 * AmisiBiz seed script.
 *
 * Security policy (see project constitution, rule 9):
 * - NEVER seeds hardcoded administrator credentials or sample tenant accounts.
 * - A platform super admin is only created when explicit credentials are
 *   supplied via environment variables, and only outside production unless
 *   ALLOW_PROD_SEED=true is deliberately set.
 *
 * Identity authority is Supabase Auth (GoTrue):
 * - The admin user is ensured in Supabase Auth (created, or converged if the
 *   address already exists).
 * - The local `User` profile row is reconciled so its `id` EQUALS the
 *   Supabase Auth user UUID — legacy rows with a cuid id are migrated in a
 *   transaction. All foreign keys to `User` use ON UPDATE CASCADE, so the id
 *   change follows through automatically; the two unconstrained actor columns
 *   (`DocumentStatusEvent.actorId`, `Invitation.invitedBy`) are updated
 *   explicitly.
 *
 * Required env vars (optional — omit to skip seeding entirely):
 *   SEED_PLATFORM_ADMIN_EMAIL
 *   SEED_PLATFORM_ADMIN_PASSWORD   (min 12 chars)
 *   SEED_PLATFORM_ADMIN_NAME       (optional)
 * Plus the Supabase connection env vars used by the app:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SECRET_KEY            (server-only; never commit)
 */

const prisma = new PrismaClient();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[seed] ${name} is not set.`);
  }
  return value;
}

function createAdminSupabase() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SECRET_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** Finds an existing Supabase Auth user by email (paginated). */
async function findAuthUserByEmail(
  admin: ReturnType<typeof createAdminSupabase>,
  email: string,
) {
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw error;
    const users = data.users;
    const match = users.find(
      (user) => user.email?.toLowerCase() === email.toLowerCase(),
    );
    if (match) return match;
    if (users.length < perPage) return null;
  }
  return null;
}

/** Ensures the Supabase Auth user exists and matches the provided secret. */
async function ensureAuthUser(
  admin: ReturnType<typeof createAdminSupabase>,
  input: { email: string; password: string; name: string },
): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { name: input.name },
  });

  if (!created.error && created.data.user) {
    return created.data.user.id;
  }

  const existing = await findAuthUserByEmail(admin, input.email);
  if (!existing) {
    throw new Error(
      `[seed] Supabase Auth refused to create the admin user: ${created.error?.message ?? "unknown error"}`,
    );
  }

  // Converge the existing user onto the seeded credential and confirmation
  // state so the seed is idempotent.
  const updated = await admin.auth.admin.updateUserById(existing.id, {
    password: input.password,
    email_confirm: true,
    user_metadata: { name: input.name },
  });
  if (updated.error) throw updated.error;

  return existing.id;
}

/**
 * Reconciles the local profile row with the Supabase Auth identity.
 * Foreign keys to `User` cascade on update; the unconstrained actor columns
 * are repointed first so no audit trail is lost in the swap.
 */
async function reconcileProfile(input: {
  email: string;
  name: string;
  authUserId: string;
}): Promise<{ id: string; action: "created" | "converged" | "reidentified" }> {
  const { email, name, authUserId } = input;

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!existing) {
    const created = await prisma.user.create({
      data: {
        id: authUserId,
        email,
        name,
        platformRole: "PLATFORM_ADMIN",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    return { id: created.id, action: "created" };
  }

  if (existing.id === authUserId) {
    const converged = await prisma.user.update({
      where: { id: existing.id },
      data: { name, platformRole: "PLATFORM_ADMIN", status: "ACTIVE" },
      select: { id: true },
    });
    return { id: converged.id, action: "converged" };
  }

  // Legacy row (pre-Supabase-Auth id) — repoint it to the Auth UUID.
  const reidentified = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // No FK constraints on these two actor columns: update them explicitly.
      await tx.documentStatusEvent.updateMany({
        where: { actorId: existing.id },
        data: { actorId: authUserId },
      });
      await tx.invitation.updateMany({
        where: { invitedBy: existing.id },
        data: { invitedBy: authUserId },
      });

      // The id change cascades to every FK that references "User" (TenantMember,
      // AuditLog, Tenant.activatedById/suspendedById, Document.issuedById/
      // voidedById — all declared ON UPDATE CASCADE).
      const updated = await tx.user.update({
        where: { id: existing.id },
        data: {
          id: authUserId,
          name,
          platformRole: "PLATFORM_ADMIN",
          status: "ACTIVE",
        },
        select: { id: true },
      });

      return updated;
    },
  );

  return { id: reidentified.id, action: "reidentified" };
}

async function main() {
  const email = process.env.SEED_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD;
  const name = process.env.SEED_PLATFORM_ADMIN_NAME?.trim() || "Platform Admin";

  if (!email || !password) {
    console.log(
      "[seed] SEED_PLATFORM_ADMIN_EMAIL / SEED_PLATFORM_ADMIN_PASSWORD not set — nothing to seed.",
    );
    return;
  }

  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PROD_SEED !== "true"
  ) {
    throw new Error(
      "[seed] Refusing to seed in production. Set ALLOW_PROD_SEED=true to override deliberately.",
    );
  }

  if (password.length < 12) {
    throw new Error(
      "[seed] SEED_PLATFORM_ADMIN_PASSWORD must be at least 12 characters.",
    );
  }

  const admin = createAdminSupabase();

  const authUserId = await ensureAuthUser(admin, { email, password, name });
  console.log(`[seed] Supabase Auth user ensured (${authUserId}).`);

  const { id, action } = await reconcileProfile({ email, name, authUserId });
  console.log(`[seed] Platform admin profile ${action} for ${email} (${id}).`);
}

main()
  .catch((err) => {
    console.error("[seed] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
