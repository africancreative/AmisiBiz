import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/**
 * AmisiBiz seed script.
 *
 * Security policy (see project constitution, rule 9):
 * - NEVER seeds hardcoded administrator credentials or sample tenant accounts.
 * - A platform super admin is only created when explicit credentials are
 *   supplied via environment variables, and only outside production unless
 *   ALLOW_PROD_SEED=true is deliberately set.
 *
 * Required env vars (optional — omit to skip seeding entirely):
 *   SEED_PLATFORM_ADMIN_EMAIL
 *   SEED_PLATFORM_ADMIN_PASSWORD   (min 12 chars)
 *   SEED_PLATFORM_ADMIN_NAME       (optional)
 */
const prisma = new PrismaClient();

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

  const hashedPassword = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name,
      password: hashedPassword,
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    },
    update: {
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
    },
    select: { id: true, email: true },
  });

  console.log(`[seed] Platform admin ensured for ${user.email} (${user.id}).`);
}

main()
  .catch((err) => {
    console.error("[seed] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
