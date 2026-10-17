/**
 * Rate limiter with support for in-memory (development) and Redis/Upstash (production).
 *
 * Set REDIS_URL or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable
 * distributed rate limiting. Without these, falls back to in-memory store
 * (per-process, suitable for single-instance development only).
 */

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

/**
 * In-memory store (development fallback).
 * State is per-process — NOT suitable for multi-instance production deployments.
 */
const memoryStore = new Map<string, Bucket>();

/**
 * Redis store interface.
 * Uses a fixed-window algorithm with atomic INCR + EXPIRE.
 */
interface RedisStore {
  increment(
    key: string,
    windowMs: number,
    limit: number,
  ): Promise<RateLimitResult>;
  reset(key?: string): Promise<void>;
}

/**
 * Creates a Redis store using ioredis (standard Redis) or Upstash REST API.
 * Returns null if Redis is not configured.
 */
async function createRedisStore(): Promise<RedisStore | null> {
  const redisUrl = process.env.REDIS_URL;
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Upstash REST API
  if (upstashUrl && upstashToken) {
    return {
      async increment(key, windowMs, limit) {
        const now = Date.now();
        const windowSec = Math.ceil(windowMs / 1000);
        const redisKey = `ratelimit:${key}`;

        // Atomic increment with expiry
        const response = await fetch(
          `${upstashUrl}/incr/${encodeURIComponent(redisKey)}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${upstashToken}` },
          },
        );

        if (!response.ok) {
          throw new Error(`Upstash INCR failed: ${response.statusText}`);
        }

        const count = (await response.json()) as number;

        // Set expiry on first request
        if (count === 1) {
          await fetch(
            `${upstashUrl}/expire/${encodeURIComponent(redisKey)}/${windowSec}`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${upstashToken}` },
            },
          );
        }

        const resetAt = now + windowMs;
        const remaining = Math.max(0, limit - count);

        return {
          success: count <= limit,
          limit,
          remaining,
          resetAt,
        };
      },
      async reset(key) {
        if (key) {
          await fetch(
            `${upstashUrl}/del/${encodeURIComponent(`ratelimit:${key}`)}`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${upstashToken}` },
            },
          );
        } else {
          // Note: Upstash doesn't support pattern delete via REST easily
          // This is a test helper; production should use specific keys
        }
      },
    };
  }

  // Standard Redis via ioredis (if available)
  if (redisUrl) {
    let Redis: {
      new (url: string): {
        incr(key: string): Promise<number>;
        expire(key: string, seconds: number): Promise<number>;
        del(...keys: string[]): Promise<number>;
        keys(pattern: string): Promise<string[]>;
      };
    } | null = null;
    try {
      // Dynamic import to avoid bundling ioredis when not used
      const ioredis = await import("ioredis");
      Redis = ioredis.default;
    } catch {
      // ioredis not installed
    }

    if (Redis) {
      const client = new Redis(redisUrl);
      return {
        async increment(key, windowMs, limit) {
          const now = Date.now();
          const windowSec = Math.ceil(windowMs / 1000);
          const redisKey = `ratelimit:${key}`;

          const count = await client.incr(redisKey);
          if (count === 1) {
            await client.expire(redisKey, windowSec);
          }

          const resetAt = now + windowMs;
          const remaining = Math.max(0, limit - count);

          return {
            success: count <= limit,
            limit,
            remaining,
            resetAt,
          };
        },
        async reset(key) {
          if (key) {
            await client.del(`ratelimit:${key}`);
          } else {
            // Test helper: flush all ratelimit keys (not for production)
            const keys = await client.keys("ratelimit:*");
            if (keys.length > 0) {
              await client.del(...keys);
            }
          }
        },
      };
    }
  }

  return null;
}

// Lazy-initialized Redis store
let redisStore: RedisStore | null = null;
let redisStoreInitFailed = false;

async function getRedisStore(): Promise<RedisStore | null> {
  if (redisStore) return redisStore;
  if (redisStoreInitFailed) return null;

  try {
    redisStore = await createRedisStore();
    if (redisStore) {
      console.log("[rate-limit] Using Redis/Upstash store");
    }
  } catch (err) {
    console.warn(
      "[rate-limit] Failed to initialize Redis store, falling back to memory:",
      err,
    );
    redisStoreInitFailed = true;
  }
  return redisStore;
}

export type RateLimitBackend = "redis" | "upstash" | "memory";

/** Which backing store is currently configured (from env only). */
export function getRateLimitBackend(): RateLimitBackend {
  if (
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  ) {
    return "upstash";
  }
  if (process.env.REDIS_URL?.trim()) return "redis";
  return "memory";
}

let warnedUnbackedProduction = false;

/**
 * Emit a one-time setup error when production is running without a shared
 * store. The limiter still answers (the app must not brick), but the operator
 * is told plainly that the protection is per-instance and therefore weak.
 */
function warnIfUnbackedInProduction(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (getRateLimitBackend() !== "memory") return;
  if (warnedUnbackedProduction) return;
  warnedUnbackedProduction = true;
  console.warn(
    "[rate-limit] No REDIS_URL or UPSTASH_* configured: rate limiting uses an in-process store, which does not hold across serverless instances. Configure a shared store before production.",
  );
}

/**
 * Main rate limiting function.
 * Uses Redis/Upstash in production, in-memory in development.
 */
export async function rateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  // In development, do not lock out developers/administrators while testing
  if (
    process.env.NODE_ENV === "development" &&
    process.env.ENABLE_DEV_RATE_LIMIT !== "true"
  ) {
    return {
      success: true,
      limit: options.limit,
      remaining: options.limit,
      resetAt: Date.now() + options.windowMs,
    };
  }

  warnIfUnbackedInProduction();

  const store = await getRedisStore();

  if (store) {
    return store.increment(key, options.windowMs, options.limit);
  }

  // Fallback: in-memory fixed window
  const now = Date.now();
  const existing = memoryStore.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + options.windowMs;
    memoryStore.set(key, { count: 1, resetAt });
    return {
      success: true,
      limit: options.limit,
      remaining: options.limit - 1,
      resetAt,
    };
  }

  if (existing.count >= options.limit) {
    return {
      success: false,
      limit: options.limit,
      remaining: 0,
      resetAt: existing.resetAt,
    };
  }

  existing.count += 1;
  return {
    success: true,
    limit: options.limit,
    remaining: options.limit - existing.count,
    resetAt: existing.resetAt,
  };
}

/** Clears a single key, or the whole store when no key is given (test helper). */
export async function resetRateLimit(key?: string): Promise<void> {
  const store = await getRedisStore();
  if (store) {
    await store.reset(key);
  } else {
    if (key) {
      memoryStore.delete(key);
    } else {
      memoryStore.clear();
    }
  }
}

/** Extracts the client IP from a request's headers, best-effort. */
export function getClientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0];
    return first ? first.trim() : null;
  }
  return headers.get("x-real-ip");
}

/**
 * Reads the client IP inside a Server Action / Route Handler.
 * Returns null when called outside a request scope (e.g. unit tests).
 */
export async function getClientIp(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    return getClientIpFromHeaders(h);
  } catch {
    return null;
  }
}
