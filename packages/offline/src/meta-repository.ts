import type { SqlDriver } from "./driver";
import { META_KEYS, type MetaKey } from "./constants";
import { newClientId } from "./ids";

/**
 * Device-local facts: the installation id, the session this data belongs to,
 * the cached authorization and its expiry, and the schema version.
 *
 * Nothing in here is authority for the server. It is (a) the identity the sync
 * protocol reports for idempotency, (b) the record of *when the server last
 * said yes*, which is the only thing an offline client may use to decide what
 * it is allowed to create while dark, and (c) the marker that binds the whole
 * database to one account — the reason a different user signing in must
 * re-provision rather than read this data.
 */
export class MetaRepository {
  private readonly driver: SqlDriver;
  private readonly now: () => Date;

  constructor(driver: SqlDriver, options: { now?: () => Date } = {}) {
    this.driver = driver;
    this.now = options.now ?? (() => new Date());
  }

  async get(key: MetaKey): Promise<string | null> {
    const row = await this.driver.get<{ value: string | null }>(
      `SELECT value FROM local_meta WHERE key = ?`,
      [key],
    );
    return row?.value ?? null;
  }

  async set(key: MetaKey, value: string): Promise<void> {
    await this.driver.run(
      `INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      updated_at = excluded.updated_at`,
      [key, value, this.now().toISOString()],
    );
  }

  async remove(key: MetaKey): Promise<void> {
    await this.driver.run(`DELETE FROM local_meta WHERE key = ?`, [key]);
  }

  /** The stable per-install id used as the server's idempotency partition. */
  async clientId(): Promise<string> {
    const existing = await this.get("client_id");
    if (existing) return existing;
    const created = newClientId();
    await this.set("client_id", created);
    return created;
  }

  /**
   * Binds the database to one verified session. The client id survives, so
   * re-authenticating as the same user does not look like a new install to the
   * server's receipt store.
   *
   * `offlineExpiresAt` is the cached expiry of the *creation* window (design
   * §8): the last authorized exchange plus the configured limit. An empty
   * string means "no offline creation allowed" rather than "no limit" — the
   * fail-closed reading of a missing value.
   */
  async bindSession(input: {
    userId: string;
    sessionVersion: number;
    tokenExpiresAt: string;
    lastAuthorizedAt: string;
    offlineExpiresAt: string;
    tenantId: string;
    tenantStatus: string;
    grantedPermissions: readonly string[];
  }): Promise<void> {
    await this.set("session_user_id", input.userId);
    await this.set("session_version", String(input.sessionVersion));
    await this.set("token_expires_at", input.tokenExpiresAt);
    await this.set("last_authorized_at", input.lastAuthorizedAt);
    await this.set("offline_expires_at", input.offlineExpiresAt);
    await this.set("tenant_id", input.tenantId);
    await this.set("tenant_status", input.tenantStatus);
    await this.set("granted_permissions", input.grantedPermissions.join(","));
  }

  /** The tenant this device holds data for, or null when never provisioned. */
  async tenantId(): Promise<string | null> {
    return this.get("tenant_id");
  }

  async grantedPermissions(): Promise<string[]> {
    const raw = await this.get("granted_permissions");
    if (raw === null || raw.length === 0) return [];
    return raw.split(",").filter((permission) => permission.length > 0);
  }

  /**
   * Whether this device may still create local records while disconnected.
   *
   * Advisory by design (design §8): the server re-derives authorization on the
   * next push and rejects whatever it no longer allows. This only stops the UI
   * from inviting work that cannot be accepted. A session that has expired
   * ends offline creation immediately — the token cannot be refreshed while
   * dark, so an expired session is not an offline-capable one.
   */
  async offlineCreation(): Promise<{
    allowed: boolean;
    reason: OfflineBlockReason;
    offlineExpiresAt: string | null;
    tenantStatus: string | null;
  }> {
    const at = this.now();
    const [userId, tenantId, tokenExpiresAt, offlineExpiresAt, tenantStatus] =
      await Promise.all([
        this.get("session_user_id"),
        this.get("tenant_id"),
        this.get("token_expires_at"),
        this.get("offline_expires_at"),
        this.get("tenant_status"),
      ]);

    const window =
      offlineExpiresAt === null || offlineExpiresAt.length === 0
        ? null
        : offlineExpiresAt;

    const reason: OfflineBlockReason = !userId
      ? "no_session"
      : !tenantId
        ? "no_tenant"
        : tokenExpiresAt !== null && Date.parse(tokenExpiresAt) <= at.getTime()
          ? "session_expired"
          : window === null || Date.parse(window) <= at.getTime()
            ? "offline_window_elapsed"
            : tenantStatus === "SUSPENDED"
              ? "tenant_suspended"
              : null;

    return {
      allowed: reason === null,
      reason,
      offlineExpiresAt: window,
      tenantStatus,
    };
  }

  /**
   * Clears the session and the cached authorization, leaving only the
   * installation id. Emptying the data is `wipe()`; this is the sign-out half,
   * so a later bind cannot inherit a stale permission set.
   */
  async clearSession(): Promise<void> {
    for (const key of META_KEYS) {
      if (key === "client_id" || key === "schema_version") continue;
      await this.remove(key);
    }
  }
}

export type OfflineBlockReason =
  | "no_session"
  | "no_tenant"
  | "session_expired"
  | "offline_window_elapsed"
  | "tenant_suspended"
  | null;
