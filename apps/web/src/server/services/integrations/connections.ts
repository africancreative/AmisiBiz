import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import {
  buildChannelAdapter,
  type ChannelCredential,
  type ConnectionFacts,
  type ProviderCapability,
  type SocialChannelAdapter,
} from "@amisibiz/integrations";
import { recordAudit } from "@/lib/audit";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import type {
  ConnectIntegrationInput,
  IntegrationProviderValue,
} from "@/lib/validations/integration";
import {
  hashWebhookVerifyString,
  serverCredentialCipher,
} from "@/server/services/integrations/crypto";
import { GRAPH_API_VERSION, GRAPH_BASE_URL, graphTransport } from "./transport";
import {
  SOCIAL_AUDIT_ACTIONS,
  SocialServiceError,
} from "@/server/services/integrations/errors";

/**
 * Integration connection service (AGENT 03 module B — `connections.ts`).
 *
 * The whole point of this file is credential HONESTY:
 *
 *  - The bearer credential is encrypted AT REST and never leaves the server:
 *    `connect` encrypts the plaintext the trusted staff input supplies, stores
 *    only the ciphertext (`bytea`), and drops the plaintext immediately. No
 *    read path here — the list/detail projections — ever carries the
 *    ciphertext, the bearer or a decrypted value.
 *  - The webhook verify string is stored only as a SHA-256 hash
 *    (`webhookVerifyTokenHash`), mirroring `Invitation.tokenHash`; the raw
 *    value is never persisted.
 *  - FAIL-CLOSED on the cipher: without `INTEGRATION_SECRET` keyed, `connect`
 *    refuses outright (`PROVIDER_UNAVAILABLE`) rather than storing a plaintext
 *    fallback or a fake envelope.
 *  - Status never lies. A connection starts UNVERIFIED and only
 *    `verifyIntegration` — which actually reaches the Graph API through the
 *    injected transport — can move it to CONNECTED, and only when the adapter
 *    returns a VERIFIED, provider-sourced outcome. A mock (no bearer) can never
 *    settle it, so nothing is ever labelled connected without a real provider
 *    reference. A failed verify records a SANITISED `lastError` (no bearer).
 *  - `disconnect` is a STATUS change, not a delete: routing keys are released
 *    and the ciphertext is cleared, but the row and its publish history survive
 *    (the `PublishJob`→connection FK RESTRICTs, so the audit trail cannot be
 *    deleted out from under).
 *
 * The tenant is never trusted from the payload: the Server Action re-authorizes
 * `tenantId` and only `authz.tenantId` is ever written.
 */

/** The routing external id a provider uses, and its non-secret credential meta. */
function routingExternalId(
  provider: IntegrationProviderValue,
  data: {
    phoneNumberId?: string | undefined;
    pageId?: string | undefined;
    instagramUserId?: string | undefined;
  },
): string | null {
  switch (provider) {
    case "META_WHATSAPP":
      return data.phoneNumberId?.trim() || null;
    case "META_FB_PAGE":
      return data.pageId?.trim() || null;
    case "META_INSTAGRAM":
      return data.instagramUserId?.trim() || null;
  }
}

function nonSecretMeta(
  provider: IntegrationProviderValue,
  data: {
    phoneNumberId?: string | undefined;
    pageId?: string | undefined;
    instagramUserId?: string | undefined;
  },
): Prisma.InputJsonValue {
  const meta: Record<string, string> = {};
  if (data.phoneNumberId) meta.phoneNumberId = data.phoneNumberId.trim();
  if (data.pageId) meta.pageId = data.pageId.trim();
  if (data.instagramUserId) meta.instagramUserId = data.instagramUserId.trim();
  meta.apiVersion = GRAPH_API_VERSION;
  // `provider` is echoed for the setup screen's own clarity; harmless and non-secret.
  meta.provider = provider;
  return meta as Prisma.InputJsonValue;
}

/**
 * Sanitized connection view — the ONLY shape any read path returns. It exposes
 * status, health, the routing id and non-secret meta; it never exposes the
 * ciphertext, the bearer, the webhook hash or a decrypted credential.
 */
export interface ConnectionView {
  readonly id: string;
  readonly provider: IntegrationProviderValue;
  readonly status: string;
  readonly providerExternalId: string | null;
  readonly credentialMeta: unknown;
  readonly lastHealthAt: Date | null;
  readonly lastError: { class: string; at: string } | null;
  readonly health: "HEALTHY" | "DEGRADED" | "OFFLINE" | "UNVERIFIED";
  readonly updatedAt: Date;
}

/** Computed health, derived from status + last-known-good + last error. */
function computeHealth(
  status: string,
  lastHealthAt: Date | null,
  // The status-driven mapping below does not consume the redacted last-error
  // projection; the prefix marks the deliberate non-use.
  _lastError: unknown,
): ConnectionView["health"] {
  if (status === "CONNECTED") {
    if (!lastHealthAt) return "UNVERIFIED";
    const ageMs = Date.now() - lastHealthAt.getTime();
    return ageMs > 24 * 60 * 60 * 1000 ? "DEGRADED" : "HEALTHY";
  }
  if (status === "ERROR") return "OFFLINE";
  if (status === "DISCONNECTED") return "OFFLINE";
  return "UNVERIFIED";
}

/** Redacted last-error projection: class + timestamp only, never the raw detail. */
function projectLastError(lastError: unknown): ConnectionView["lastError"] {
  if (!lastError || typeof lastError !== "object") return null;
  const record = lastError as Record<string, unknown>;
  const cls = typeof record.class === "string" ? record.class : "UNKNOWN";
  const at = typeof record.at === "string" ? record.at : "";
  return { class: cls, at };
}

function toView(row: {
  id: string;
  provider: IntegrationProviderValue;
  status: string;
  providerExternalId: string | null;
  credentialMeta: Prisma.JsonValue;
  lastHealthAt: Date | null;
  lastError: Prisma.JsonValue;
  updatedAt: Date;
}): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    providerExternalId: row.providerExternalId,
    credentialMeta: row.credentialMeta,
    lastHealthAt: row.lastHealthAt,
    lastError: projectLastError(row.lastError),
    health: computeHealth(row.status, row.lastHealthAt, row.lastError),
    updatedAt: row.updatedAt,
  };
}

/* --------------------------------- connect ---------------------------------- */

export async function connectIntegration(
  authz: TenantAuthzContext,
  actorId: string,
  input: Omit<ConnectIntegrationInput, "tenantId">,
): Promise<ConnectionView> {
  // FAIL-CLOSED: no cipher key means no safe place to put the credential.
  const cipher = serverCredentialCipher();
  if (!cipher.ready) {
    throw new SocialServiceError(
      "PROVIDER_UNAVAILABLE",
      "Credential storage is not configured on this deployment, so a connection " +
        "cannot be saved safely. Set the integration key environment variable first.",
    );
  }

  // Prisma's bytea input is `Uint8Array<ArrayBuffer>`; the cipher returns a
  // plain `Uint8Array` (ArrayBufferLike). Rebuild it over a fresh ArrayBuffer —
  // a byte-for-byte copy of the same ciphertext — so the store needs no cast.
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    ciphertext = new Uint8Array(cipher.encrypt(input.bearer));
  } catch {
    // Never echo the underlying crypto message (it could name the key variable).
    throw new SocialServiceError(
      "PROVIDER_UNAVAILABLE",
      "The credential could not be encrypted for storage.",
    );
  }

  const externalId = routingExternalId(input.provider, input);
  if (!externalId) {
    throw new SocialServiceError(
      "VALIDATION",
      "This connection is missing its routing identifier.",
    );
  }

  // (provider, providerExternalId) is a PLATFORM-WIDE unique (migration §5): the
  // same phone number / page / IG account cannot bind to two tenants without
  // forking webhook routing. Proven here so the operator gets a clear message
  // rather than an opaque P2002.
  const fork = await prisma.integrationConnection.findFirst({
    where: { provider: input.provider, providerExternalId: externalId },
    select: { tenantId: true },
  });
  if (fork && fork.tenantId !== authz.tenantId) {
    throw new SocialServiceError(
      "CONFLICT",
      "That account is already connected to a different business.",
    );
  }

  const webhookHash = input.webhookVerifyString
    ? hashWebhookVerifyString(input.webhookVerifyString)
    : null;

  try {
    const row = await prisma.integrationConnection.upsert({
      where: {
        tenantId_provider: {
          tenantId: authz.tenantId,
          provider: input.provider,
        },
      },
      create: {
        tenantId: authz.tenantId,
        provider: input.provider,
        // UNVERIFIED by column default; only `verify` moves it. Never client-set.
        status: "UNVERIFIED",
        credentialCiphertext: ciphertext,
        credentialMeta: nonSecretMeta(input.provider, input),
        providerExternalId: externalId,
        webhookVerifyTokenHash: webhookHash,
        connectedById: actorId,
      },
      update: {
        credentialCiphertext: ciphertext,
        credentialMeta: nonSecretMeta(input.provider, input),
        providerExternalId: externalId,
        webhookVerifyTokenHash: webhookHash,
        connectedById: actorId,
        // Re-keying a connection invalidates its verified state: it must be
        // re-verified before it can send/publish again.
        status: "UNVERIFIED",
        lastError: Prisma.DbNull,
      },
    });

    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.CONNECTION_CONNECTED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "IntegrationConnection",
      resourceId: row.id,
      // Non-secret: provider + status only. Never the bearer or ciphertext.
      metadata: { provider: row.provider, status: row.status },
    });

    return toView(row);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new SocialServiceError(
        "CONFLICT",
        "That account is already connected to a different business.",
      );
    }
    throw error;
  }
}

/* ---------------------------------- verify ---------------------------------- */

/**
 * Actually reaches the provider (through the injected transport) and moves the
 * connection to CONNECTED ONLY on a verified, provider-sourced outcome.
 * A missing/failed credential never fabricates a connection.
 */
export async function verifyIntegration(
  authz: TenantAuthzContext,
  actorId: string,
  provider: IntegrationProviderValue,
): Promise<ConnectionView> {
  const row = await prisma.integrationConnection.findFirst({
    where: { tenantId: authz.tenantId, provider },
  });
  if (!row) {
    throw new SocialServiceError(
      "NOT_FOUND",
      "No such connection for this business.",
    );
  }

  const { adapter, configured } = buildAdapterForRow(row);
  if (!configured) {
    // No stored credential (or the cipher is unkeyed): honest refusal, never
    // a simulated pass.
    const updated = await prisma.integrationConnection.update({
      where: { id: row.id },
      data: {
        status: "PENDING_VERIFICATION",
        lastError: { class: "AUTH", at: new Date().toISOString() },
      },
    });
    return toView(updated);
  }

  const outcome = await adapter.verifyConnection(
    credentialForAdapter(row, adapter),
  );

  if (outcome.status === "verified") {
    const facts = outcome.value as ConnectionFacts;
    const updated = await prisma.integrationConnection.update({
      where: { id: row.id },
      data: {
        status: "CONNECTED",
        lastHealthAt: new Date(),
        lastError: Prisma.DbNull,
        credentialMeta: mergeFacts(row.credentialMeta, facts),
      },
    });
    await recordAudit({
      action: SOCIAL_AUDIT_ACTIONS.CONNECTION_VERIFIED,
      userId: actorId,
      tenantId: authz.tenantId,
      resource: "IntegrationConnection",
      resourceId: row.id,
      metadata: { provider: row.provider, status: "CONNECTED" },
    });
    return toView(updated);
  }

  // Unverified / declined / failed: record the refusal with a SANITISED class
  // only. A mock or an absent provider answer can never set CONNECTED.
  const errorClass = classifyOutcome(outcome.status);
  const updated = await prisma.integrationConnection.update({
    where: { id: row.id },
    data: {
      status: outcome.status === "failed" ? "ERROR" : "PENDING_VERIFICATION",
      lastError: { class: errorClass, at: new Date().toISOString() },
    },
  });
  return toView(updated);
}

function classifyOutcome(status: string): "AUTH" | "NETWORK" | "UNKNOWN" {
  if (status === "failed") return "AUTH";
  if (status === "declined") return "AUTH";
  return "UNKNOWN";
}

function mergeFacts(
  existing: Prisma.JsonValue,
  facts: ConnectionFacts,
): Prisma.InputJsonValue {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...base,
    grantedScopes: facts.grantedScopes,
    ...(facts.expiresAt ? { expiresAt: facts.expiresAt } : {}),
  } as Prisma.InputJsonValue;
}

/* -------------------------------- disconnect -------------------------------- */

export async function disconnectIntegration(
  authz: TenantAuthzContext,
  actorId: string,
  provider: IntegrationProviderValue,
): Promise<ConnectionView> {
  const row = await prisma.integrationConnection.findFirst({
    where: { tenantId: authz.tenantId, provider },
    select: { id: true },
  });
  if (!row) {
    throw new SocialServiceError(
      "NOT_FOUND",
      "No such connection for this business.",
    );
  }

  // Status change, not deletion: the routing key is released and the credential
  // is destroyed, but the row (and its publish history) survives.
  const updated = await prisma.integrationConnection.update({
    where: { id: row.id },
    data: {
      status: "DISCONNECTED",
      credentialCiphertext: null,
      providerExternalId: null,
      webhookVerifyTokenHash: null,
      lastError: Prisma.DbNull,
    },
  });

  await recordAudit({
    action: SOCIAL_AUDIT_ACTIONS.CONNECTION_DISCONNECTED,
    userId: actorId,
    tenantId: authz.tenantId,
    resource: "IntegrationConnection",
    resourceId: row.id,
    metadata: { provider },
  });

  return toView(updated);
}

/* ---------------------------------- reads ----------------------------------- */

export async function listConnections(
  authz: TenantAuthzContext,
): Promise<ConnectionView[]> {
  const rows = await prisma.integrationConnection.findMany({
    where: { tenantId: authz.tenantId },
    orderBy: { provider: "asc" },
  });
  return rows.map(toView);
}

/** The capability list a provider exposes, rendered honestly per build. */
export function capabilitiesFor(
  provider: IntegrationProviderValue,
): readonly ProviderCapability[] {
  // The mock documents the honest ceiling (nothing is LIVE without a credential).
  return buildChannelAdapter(provider, {
    graphBaseUrl: GRAPH_BASE_URL,
    apiVersion: GRAPH_API_VERSION,
    transport: graphTransport,
    bearer: "",
  }).capabilities();
}

/* --------------------------- adapter build helpers --------------------------- */

/**
 * Reconstruct a channel adapter for a stored connection, decrypting the bearer
 * server-side. `configured: false` when there is no ciphertext, no key or the
 * envelope fails to open — callers then refuse rather than fake a provider fact.
 * This is the seam the webhook fan-out and the publish runner both use.
 */
export function buildAdapterForRow(row: {
  provider: IntegrationProviderValue;
  credentialCiphertext: Uint8Array | null;
  credentialMeta: Prisma.JsonValue;
}): { adapter: SocialChannelAdapter; configured: boolean } {
  const bearer = decryptBearer(row);
  // buildChannelAdapter returns the MOCK (isLive:false) when bearer is empty,
  // so an unconfigured connection physically cannot confirm anything.
  const adapter = buildChannelAdapter(row.provider, {
    graphBaseUrl: GRAPH_BASE_URL,
    apiVersion: GRAPH_API_VERSION,
    transport: graphTransport,
    bearer,
    ...routingFromMeta(row.credentialMeta),
  });
  return { adapter, configured: adapter.isLive };
}

/** The full credential (bearer included) an adapter call needs; server-only. */
export function credentialForAdapter(
  row: {
    provider: IntegrationProviderValue;
    credentialCiphertext: Uint8Array | null;
    credentialMeta: Prisma.JsonValue;
  },
  adapter: SocialChannelAdapter,
): ChannelCredential {
  void adapter;
  return {
    graphBaseUrl: GRAPH_BASE_URL,
    apiVersion: GRAPH_API_VERSION,
    transport: graphTransport,
    bearer: decryptBearer(row),
    ...routingFromMeta(row.credentialMeta),
  };
}

/** Decrypt the stored credential to its plaintext bearer, or "" (unconfigured). */
export function decryptBearer(row: {
  credentialCiphertext: Uint8Array | null;
}): string {
  if (!row.credentialCiphertext) return "";
  const cipher = serverCredentialCipher();
  if (!cipher.ready) return "";
  try {
    const bytes =
      row.credentialCiphertext instanceof Uint8Array
        ? row.credentialCiphertext
        : new Uint8Array(row.credentialCiphertext as unknown as ArrayBuffer);
    return cipher.decrypt(bytes);
  } catch {
    // A malformed envelope or a key rotation is an unconfigured state, not a
    // crash: never echo the underlying crypto error text.
    return "";
  }
}

function routingFromMeta(meta: Prisma.JsonValue): {
  phoneNumberId?: string;
  pageId?: string;
  instagramUserId?: string;
} {
  const record =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const out: {
    phoneNumberId?: string;
    pageId?: string;
    instagramUserId?: string;
  } = {};
  if (typeof record.phoneNumberId === "string")
    out.phoneNumberId = record.phoneNumberId;
  if (typeof record.pageId === "string") out.pageId = record.pageId;
  if (typeof record.instagramUserId === "string") {
    out.instagramUserId = record.instagramUserId;
  }
  return out;
}
