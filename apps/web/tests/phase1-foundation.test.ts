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
  it("reports every missing Supabase variable at once, by name", () => {
    const problems = database.collectSupabaseEnvProblems({});
    expect(problems).toHaveLength(3);
    const joined = problems.join("\n");
    expect(joined).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(joined).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(joined).toContain("SUPABASE_SECRET_KEY");
  });

  it("rejects an invalid URL with a clear message", () => {
    const problems = database.collectSupabaseEnvProblems({
      NEXT_PUBLIC_SUPABASE_URL: "not a url",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
      SUPABASE_SECRET_KEY: "sb_secret_x",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(problems[0]).toContain("valid URL");
  });

  it("requireSupabaseEnv throws one aggregated error naming the variables", () => {
    expect(() => database.requireSupabaseEnv({})).toThrowError(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
    expect(() => database.requireSupabaseEnv({})).toThrowError(
      /SUPABASE_SECRET_KEY/,
    );
    const parsed = database.requireSupabaseEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
      SUPABASE_SECRET_KEY: "sb_secret_x",
    });
    expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toBe("https://example.supabase.co");
  });

  it("lazy accessors name the missing variable", () => {
    withEnv({ SUPABASE_SECRET_KEY: undefined }, () => {
      expect(() => database.getSupabaseSecretKey()).toThrowError(
        /SUPABASE_SECRET_KEY is not configured/,
      );
    });
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
