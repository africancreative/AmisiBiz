import { describe, expect, it } from "vitest";

// ── Package import smoke tests ─────────────────────────────────────────────
// Phase 1 acceptance: every workspace package imports cleanly from the app
// (no circular dependencies) and re-exports working behaviour. These imports
// are deliberately real — nothing here is mocked — so a broken export map,
// circular dependency or plugin-load-time throw fails the suite.
import * as auth from "@amisibiz/auth";
import * as domain from "@amisibiz/domain";
import * as documents from "@amisibiz/documents";
import * as database from "@amisibiz/database";
import type { QueuedOperation } from "@amisibiz/sync";
import { cn } from "@amisibiz/ui/utils";
import { Button } from "@amisibiz/ui/button";
import { Spinner } from "@amisibiz/ui/spinner";
import {
  getAppName,
  getAppUrlOrNull,
  emailVerificationRequired,
} from "@/lib/env";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("@amisibiz/auth", () => {
  it("enforces the documented tenant role policy", () => {
    expect(
      auth.tenantRoleHasPermission(
        "TENANT_OWNER",
        auth.PERMISSIONS.CONTACTS_CREATE,
      ),
    ).toBe(true);
    expect(
      auth.tenantRoleHasPermission("VIEWER", auth.PERMISSIONS.CONTACTS_CREATE),
    ).toBe(false);
    expect(
      auth.tenantRoleHasPermission(null, auth.PERMISSIONS.CONTACTS_READ),
    ).toBe(false);
  });

  it("keeps platform and tenant domains disjoint", () => {
    expect(
      auth.platformRoleHasPermission(
        "SUPER_ADMIN",
        auth.PERMISSIONS.PLATFORM_TENANTS_READ,
      ),
    ).toBe(true);
    expect(
      auth.platformRoleHasPermission(null, auth.PERMISSIONS.CONTACTS_READ),
    ).toBe(false);
    for (const permission of auth.TENANT_PERMISSIONS) {
      expect(auth.isPlatformPermission(permission)).toBe(false);
    }
  });
});

describe("@amisibiz/domain", () => {
  it("normalises emails and rejects invalid ones", () => {
    expect(domain.emailSchema.parse("  USER@Example.COM ")).toBe(
      "user@example.com",
    );
    expect(domain.emailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("computes WCAG contrast fail-closed", () => {
    expect(domain.meetsContrastMinimum("#000000", "#ffffff")).toBe(true);
    expect(domain.meetsContrastMinimum("#777777", "#888888")).toBe(false);
    expect(domain.meetsContrastMinimum("nonsense", "#ffffff")).toBe(false);
  });
});

describe("@amisibiz/documents", () => {
  it("formats money from decimal strings without float parsing", () => {
    expect(documents.formatMoney("1234.5000", "KES")).toBe("KSh1,234.50");
    expect(documents.formatMoney("-0.999", "USD")).toBe("-US$1.00");
    expect(documents.formatMoney("not-a-number", "KES")).toBe("not-a-number");
    expect(documents.formatPercent("0.1667")).toBe("16.67%");
  });

  it("exposes the default document series", () => {
    expect(documents.DEFAULT_DOCUMENT_SERIES).toHaveLength(3);
    expect(documents.DEFAULT_DOCUMENT_SERIES.map((s) => s.type)).toEqual([
      "QUOTATION",
      "INVOICE",
      "DELIVERY_NOTE",
    ]);
  });
});

describe("@amisibiz/database", () => {
  /** Wipes every pooled URL key so resolution is deterministic. */
  function withoutPooledUrls(): Record<string, string | undefined> {
    const overrides: Record<string, string | undefined> = {};
    for (const key of database.POOLED_DATABASE_URL_KEYS) {
      overrides[key] = undefined;
    }
    return overrides;
  }

  it("reports missing DATABASE_URL by name", () => {
    const problems = database.collectDatabaseEnvProblems({});
    expect(problems.length).toBeGreaterThanOrEqual(1);
    const joined = problems.join("\n");
    expect(joined).toContain("DATABASE_URL");
  });

  it("rejects an invalid DATABASE_URL with a clear message", () => {
    const problems = database.collectDatabaseEnvProblems({
      DATABASE_URL: "not-a-valid-url",
    });
    expect(problems.length).toBeGreaterThanOrEqual(1);
    expect(problems[0]).toContain("DATABASE_URL");
    expect(problems[0]).toContain("valid PostgreSQL connection URL");
  });

  it("requireDatabaseEnv throws one aggregated error naming missing variables", () => {
    expect(() => database.requireDatabaseEnv({})).toThrowError(/DATABASE_URL/);
    const parsed = database.requireDatabaseEnv({
      DATABASE_URL:
        "postgresql://user:pass@ep-test.neon.tech/amisibiz?sslmode=require",
    });
    expect(parsed.DATABASE_URL).toBe(
      "postgresql://user:pass@ep-test.neon.tech/amisibiz?sslmode=require",
    );
  });

  it("accepts a platform-injected Neon key in place of DATABASE_URL", () => {
    const problems = database.collectDatabaseEnvProblems({
      POSTGRES_PRISMA_URL:
        "postgresql://owner:pw@ep-pooler.eu-central-1.aws.neon.tech/amisibiz?sslmode=require",
    });
    expect(problems).toEqual([]);
  });

  it("prefers the canonical pooled key over injected aliases, in a fixed order", () => {
    expect(
      database.resolvePooledDatabaseUrl({
        DATABASE_URL: "postgresql://canonical",
        POSTGRES_PRISMA_URL: "postgresql://injected",
      }),
    ).toEqual({ url: "postgresql://canonical", source: "DATABASE_URL" });

    expect(
      database.resolvePooledDatabaseUrl({
        POSTGRES_URL: "postgresql://pooled",
        POSTGRES_PRISMA_URL: "postgresql://injected",
      })?.source,
    ).toBe("POSTGRES_PRISMA_URL");
  });

  it("treats empty injected keys as absent", () => {
    expect(
      database.resolvePooledDatabaseUrl({
        DATABASE_URL: "   ",
        POSTGRES_URL: "postgresql://pooled",
      })?.source,
    ).toBe("POSTGRES_URL");
    // All pooled keys empty → still a problem, still named.
    const problems = database.collectDatabaseEnvProblems({ DATABASE_URL: "" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("DATABASE_URL");
  });

  it("maps unpooled injections to the direct endpoint without overriding DIRECT_URL", () => {
    expect(
      database.resolveDirectDatabaseUrl({
        DIRECT_URL: "postgresql://direct",
        DATABASE_URL_UNPOOLED: "postgresql://unpooled",
      })?.source,
    ).toBe("DIRECT_URL");
    expect(
      database.resolveDirectDatabaseUrl({
        DATABASE_URL_UNPOOLED: "postgresql://unpooled",
        POSTGRES_URL_NON_POOLING: "postgresql://nonpooling",
      })?.source,
    ).toBe("DATABASE_URL_UNPOOLED");
  });

  it("getDatabaseUrl falls back to an injected pooled key and names its source", () => {
    withEnv(
      { ...withoutPooledUrls(), POSTGRES_URL: "postgresql://injected" },
      () => {
        expect(database.getDatabaseUrl()).toBe("postgresql://injected");
        expect(database.getDatabaseUrlSource()).toBe("POSTGRES_URL");
      },
    );
  });

  it("lazy accessors name the missing variable and every key they checked", () => {
    withEnv(withoutPooledUrls(), () => {
      expect(() => database.getDatabaseUrl()).toThrowError(
        /DATABASE_URL is not configured/,
      );
      expect(() => database.getDatabaseUrl()).toThrowError(
        /POSTGRES_PRISMA_URL/,
      );
    });
  });

  it("keeps connection-string values out of validation messages", () => {
    const problems = database.collectDatabaseEnvProblems({
      DATABASE_URL: "not-a-url:owner-password-here",
      POSTGRES_URL: "junk",
    });
    const joined = problems.join("\n");
    expect(joined).toContain("POSTGRES_URL");
    expect(joined).not.toContain("owner-password-here");
  });
});

describe("@amisibiz/sync (contracts)", () => {
  it("types an offline operation with a client idempotency key", () => {
    const operation: QueuedOperation = {
      id: "3d1b2c33-3d2f-4f13-9a2e-3c1a2b3d4e5f",
      type: "contact.create",
      // The row this operation writes, named rather than guessed from the type:
      // `entity` + `entityId` is what the server routes and upserts by.
      entity: "contact",
      entityId: "9f8e7d6c-5b4a-4321-8765-43210fedcba9",
      payload: { name: "Example" },
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
      lastError: null,
    };
    expect(operation.status).toBe("pending");
    expect(operation.id).toHaveLength(36);
  });
});

describe("@amisibiz/ui", () => {
  it("composes Tailwind classes with later classes winning", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("flex", false && "hidden", ["gap-2"])).toBe("flex gap-2");
  });

  it("exports components through subpath exports", () => {
    // `Button` is a forwardRef exotic component (an object); `Spinner` is a
    // plain function component — both prove subpath resolution works.
    expect(Button).toBeTruthy();
    expect(typeof Spinner).toBe("function");
  });
});

describe("web app env accessors", () => {
  it("returns the configured app URL with trailing slashes stripped", () => {
    withEnv({ NEXT_PUBLIC_APP_URL: "https://app.example.com/" }, () => {
      expect(getAppUrlOrNull()).toBe("https://app.example.com");
    });
  });

  it("returns null for an unset URL outside production", () => {
    withEnv({ NEXT_PUBLIC_APP_URL: undefined, NODE_ENV: "development" }, () => {
      expect(getAppUrlOrNull()).toBeNull();
    });
  });

  it("throws a clear error for an unset URL in production", () => {
    withEnv({ NEXT_PUBLIC_APP_URL: undefined, NODE_ENV: "production" }, () => {
      expect(() => getAppUrlOrNull()).toThrowError(/NEXT_PUBLIC_APP_URL/);
    });
  });

  it("falls back to the product name and treats verification as opt-in", () => {
    withEnv({ NEXT_PUBLIC_APP_NAME: undefined }, () => {
      expect(getAppName()).toBe("AmisiBiz");
    });
    withEnv({ REQUIRE_EMAIL_VERIFICATION: undefined }, () => {
      expect(emailVerificationRequired()).toBe(false);
    });
    withEnv({ REQUIRE_EMAIL_VERIFICATION: "true" }, () => {
      expect(emailVerificationRequired()).toBe(true);
    });
  });
});
