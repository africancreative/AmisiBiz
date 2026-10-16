import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

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

  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        name,
        passwordHash,
        platformRole: "SUPER_ADMIN",
        status: "ACTIVE",
      },
    });
    console.log(`[seed] Platform admin converged for ${email} (${existing.id}).`);
  } else {
    const created = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        platformRole: "SUPER_ADMIN",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    console.log(`[seed] Platform admin created for ${email} (${created.id}).`);
  }
}

main()
  .catch((err) => {
    console.error("[seed] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
