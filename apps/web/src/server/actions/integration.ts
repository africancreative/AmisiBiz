"use server";

import { requireAuth } from "@/lib/auth/helpers";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  authorizeTenant,
  AuthorizationError,
} from "@/server/auth/authorization";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  connectIntegrationSchema,
  connectionDetailSchema,
  disconnectIntegrationSchema,
  listConnectionsSchema,
  verifyIntegrationSchema,
} from "@/lib/validations/integration";
import {
  capabilitiesFor,
  connectIntegration,
  disconnectIntegration,
  listConnections,
  verifyIntegration,
  type ConnectionView,
} from "@/server/services/integrations/connections";
import {
  socialErrorActionCode,
  SocialServiceError,
} from "@/server/services/integrations/errors";

/**
 * Integration connection Server Actions (AGENT 03 module C).
 *
 * Shape mirrors `actions/lead.ts` exactly: authenticate → validate with the
 * schema (unknown/server-owned keys stripped: `status`, the ciphertext, the
 * routing `providerExternalId`, the webhook hash and every id never survive a
 * payload) → `authorizeTenant` with the verb-specific permission (this also
 * opens the RLS scope and refuses a suspended/support-read-only context for any
 * write) → delegate to the connection service, which takes the authorized
 * context and never a client `tenantId`. Actions never throw; every failure
 * lands as an `ActionResult` and never echoes a credential.
 *
 * Permission wiring:
 *  - list / detail / capabilities → INTEGRATIONS_READ
 *  - connect / verify / disconnect → INTEGRATIONS_MANAGE
 *
 * The bearer credential crosses this boundary exactly once (on connect) and is
 * immediately encrypted by the service; no action here ever returns, logs or
 * persists it in the clear.
 */

function socialActionFailure(
  error: unknown,
  context: string,
): ActionResult<never> {
  if (error instanceof SocialServiceError) {
    return fail(error.message, {
      code: socialErrorActionCode(error.code),
      ...(error.field
        ? { fieldErrors: { [error.field]: [error.message] } }
        : {}),
    });
  }
  if (error instanceof AuthorizationError) {
    return authorizationFailure(error, context);
  }
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again later.", {
    code: "INTERNAL",
  });
}

/* --------------------------------- writes ----------------------------------- */

export async function connectIntegrationAction(
  rawInput: unknown,
): Promise<ActionResult<{ connection: ConnectionView }>> {
  const session = await requireAuth();

  const parsed = connectIntegrationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid connection request.");
  }

  const { tenantId, ...data } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INTEGRATIONS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "connectIntegrationAction");
  }

  try {
    const connection = await connectIntegration(context, session.user.id, data);
    return { success: true, data: { connection } };
  } catch (err) {
    return socialActionFailure(err, "connectIntegrationAction");
  }
}

export async function verifyIntegrationAction(
  rawInput: unknown,
): Promise<ActionResult<{ connection: ConnectionView }>> {
  const session = await requireAuth();

  const parsed = verifyIntegrationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, provider } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INTEGRATIONS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "verifyIntegrationAction");
  }

  try {
    const connection = await verifyIntegration(
      context,
      session.user.id,
      provider,
    );
    return { success: true, data: { connection } };
  } catch (err) {
    return socialActionFailure(err, "verifyIntegrationAction");
  }
}

export async function disconnectIntegrationAction(
  rawInput: unknown,
): Promise<ActionResult<{ connection: ConnectionView }>> {
  const session = await requireAuth();

  const parsed = disconnectIntegrationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, provider } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INTEGRATIONS_MANAGE,
    );
  } catch (err) {
    return authorizationFailure(err, "disconnectIntegrationAction");
  }

  try {
    const connection = await disconnectIntegration(
      context,
      session.user.id,
      provider,
    );
    return { success: true, data: { connection } };
  } catch (err) {
    return socialActionFailure(err, "disconnectIntegrationAction");
  }
}

/* ---------------------------------- reads ----------------------------------- */

export async function listConnectionsAction(
  rawInput: unknown,
): Promise<ActionResult<{ connections: ConnectionView[] }>> {
  const session = await requireAuth();

  const parsed = listConnectionsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query.");
  }

  const { tenantId } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INTEGRATIONS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "listConnectionsAction");
  }

  try {
    const connections = await listConnections(context);
    return { success: true, data: { connections } };
  } catch (err) {
    return socialActionFailure(err, "listConnectionsAction");
  }
}

/**
 * Connection detail plus the provider's honest capability list. The capabilities
 * are computed from the mock (nothing is LIVE without a verified credential), so
 * the setup screen can never show a fabricated "connected feature works".
 */
export async function getConnectionDetailAction(rawInput: unknown): Promise<
  ActionResult<{
    connection: ConnectionView | null;
    capabilities: ReturnType<typeof capabilitiesFor>;
  }>
> {
  const session = await requireAuth();

  const parsed = connectionDetailSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  const { tenantId, provider } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.INTEGRATIONS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getConnectionDetailAction");
  }

  try {
    const connections = await listConnections(context);
    const connection =
      connections.find((row) => row.provider === provider) ?? null;
    return {
      success: true,
      data: { connection, capabilities: capabilitiesFor(provider) },
    };
  } catch (err) {
    return socialActionFailure(err, "getConnectionDetailAction");
  }
}
