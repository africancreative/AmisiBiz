/**
 * Service capability report.
 *
 * One place that answers "is this external service actually wired up?" without
 * touching a secret value. It exists so the app never *claims* that email
 * delivery, private object storage or distributed rate limiting is operational
 * when it is not (see docs/implementation/agent-work-plan.md P0).
 *
 * Every accessor is lazy, so importing this module is always safe and it can
 * be used from a readiness probe. Database detection delegates to
 * `@amisibiz/database` so the injected-key list has one source of truth
 * (this module stays server-only: it transitively references the Prisma
 * client).
 */

import { resolvePooledDatabaseUrl } from "@amisibiz/database";

export type ServiceMode = "production" | "development" | "none";

export type ServiceCapability = {
  /** True only when a real external implementation is configured. */
  configured: boolean;
  /** How the app behaves today for this service. */
  mode: ServiceMode;
  /** Secret-free, human-readable description. */
  detail: string;
};

export type Capabilities = {
  database: ServiceCapability;
  email: ServiceCapability;
  objectStorage: ServiceCapability;
  rateLimit: ServiceCapability;
  pdf: ServiceCapability;
};

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function databaseCapability(): ServiceCapability {
  // Key NAME only in the detail line — a connection string embeds a password.
  const resolved = resolvePooledDatabaseUrl();
  return {
    configured: resolved !== null,
    mode: resolved ? (isProduction() ? "production" : "development") : "none",
    detail: resolved
      ? `Neon PostgreSQL connection configured (via ${resolved.source}).`
      : "No pooled database URL is configured (checked DATABASE_URL and the platform-injected Neon keys).",
  };
}

function emailCapability(): ServiceCapability {
  const provider = process.env.EMAIL_PROVIDER?.trim();

  if (!provider) {
    return isProduction()
      ? {
          configured: false,
          mode: "none",
          detail:
            "No EMAIL_PROVIDER configured — verification, password-reset and invitation emails are not delivered in production.",
        }
      : {
          configured: false,
          mode: "development",
          detail:
            "No EMAIL_PROVIDER configured — the development console adapter prints messages instead of delivering them.",
        };
  }

  // A provider name is set but no transport is implemented yet.
  return {
    configured: false,
    mode: "none",
    detail: `EMAIL_PROVIDER="${provider}" is set but no transport is implemented; nothing is delivered.`,
  };
}

function objectStorageCapability(): ServiceCapability {
  if (process.env.STORAGE_PROVIDER?.trim()) {
    return {
      configured: false,
      mode: "none",
      detail:
        "STORAGE_PROVIDER is set but no external object-storage transport is implemented; brand assets are still written to the local filesystem.",
    };
  }

  if (isProduction() || process.env.VERCEL) {
    return {
      configured: false,
      mode: "none",
      detail:
        "Private object storage is not configured. Assets are written to the local filesystem, which is ephemeral on serverless hosting, so uploads will not persist.",
    };
  }

  return {
    configured: false,
    mode: "development",
    detail:
      "Local filesystem storage under apps/web/uploads (development only; not private object storage).",
  };
}

function rateLimitCapability(): ServiceCapability {
  const hasUpstash = Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  );
  const hasRedis = Boolean(process.env.REDIS_URL?.trim());

  if (hasUpstash) {
    return {
      configured: true,
      mode: "production",
      detail: "Upstash REST rate-limit store configured.",
    };
  }
  if (hasRedis) {
    return {
      configured: true,
      mode: "production",
      detail: "Redis rate-limit store configured.",
    };
  }

  return isProduction()
    ? {
        configured: false,
        mode: "none",
        detail:
          "No REDIS_URL or UPSTASH_* configured — rate limiting uses an in-process store that does not hold across serverless instances.",
      }
    : {
        configured: false,
        mode: "development",
        detail: "In-process rate-limit store (development).",
      };
}

function pdfCapability(): ServiceCapability {
  return {
    configured: true,
    mode: isProduction() ? "production" : "development",
    detail:
      "PDFs are generated in-process by @amisibiz/documents; no external service is used.",
  };
}

/** The current capability set. Contains no secret values. */
export function getCapabilities(): Capabilities {
  return {
    database: databaseCapability(),
    email: emailCapability(),
    objectStorage: objectStorageCapability(),
    rateLimit: rateLimitCapability(),
    pdf: pdfCapability(),
  };
}

/**
 * True when every capability the production acceptance gate depends on is
 * configured. Intended for readiness checks and startup diagnostics, never for
 * authorization.
 */
export function hasAllProductionCapabilities(): boolean {
  const capabilities = getCapabilities();
  return (
    capabilities.database.configured &&
    capabilities.email.configured &&
    capabilities.objectStorage.configured &&
    capabilities.rateLimit.configured
  );
}
