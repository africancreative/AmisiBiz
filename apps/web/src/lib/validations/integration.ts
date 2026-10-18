import { z } from "zod";

/**
 * Integration connection validation (AGENT 03).
 *
 * Security posture:
 *  - `tenantId` is only ever a LOCATOR here — the Server Action re-authorizes
 *    it and the service writes the authorized tenant, never this value.
 *  - The connection `status` is never client-set: it starts at UNVERIFIED and
 *    moves only through the verify / disconnect operations.
 *  - Server-owned fields (id, providerExternalId, credentialCiphertext,
 *    lastHealthAt, lastError, webhookVerifyTokenHash) are ABSENT from every
 *    payload: an object schema strips unknown keys, so a forged one never
 *    reaches the service.
 *  - The bearer credential is accepted ONLY on connect (a trusted staff
 *    input) and is immediately encrypted server-side; it is never echoed,
 *    logged or returned. `webhookVerifyString` is likewise hashed at rest.
 */

export const INTEGRATION_PROVIDERS = [
  "META_WHATSAPP",
  "META_FB_PAGE",
  "META_INSTAGRAM",
] as const;
export const integrationProviderSchema = z.enum(INTEGRATION_PROVIDERS);
export type IntegrationProviderValue = z.infer<
  typeof integrationProviderSchema
>;

const uuid = z.string().uuid("Invalid ID");
const bearer = z.string().trim().min(1, "A credential is required").max(4096);
const externalId = z.string().trim().min(1).max(200);

/** Non-secret routing ids a Meta connection may carry, depending on provider. */
const nonSecretMeta = {
  phoneNumberId: externalId.optional(),
  pageId: externalId.optional(),
  instagramUserId: externalId.optional(),
};

export const connectIntegrationSchema = z
  .object({
    tenantId: uuid,
    provider: integrationProviderSchema,
    /** The access credential; encrypted immediately, never stored plaintext. */
    bearer,
    ...nonSecretMeta,
    /** The webhook verify string; stored only as a hash. Optional. */
    webhookVerifyString: z.string().trim().min(8).max(200).optional(),
  })
  .superRefine((data, ctx) => {
    // Each provider needs its own routing key present to be routable.
    if (data.provider === "META_WHATSAPP" && !data.phoneNumberId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phoneNumberId"],
        message: "A WhatsApp connection needs a phone number id",
      });
    }
    if (data.provider === "META_FB_PAGE" && !data.pageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pageId"],
        message: "A Facebook Page connection needs a page id",
      });
    }
    if (data.provider === "META_INSTAGRAM" && !data.instagramUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instagramUserId"],
        message: "An Instagram connection needs an account id",
      });
    }
  });
export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;

export const verifyIntegrationSchema = z.object({
  tenantId: uuid,
  provider: integrationProviderSchema,
});
export type VerifyIntegrationInput = z.infer<typeof verifyIntegrationSchema>;

export const disconnectIntegrationSchema = z.object({
  tenantId: uuid,
  provider: integrationProviderSchema,
});
export type DisconnectIntegrationInput = z.infer<
  typeof disconnectIntegrationSchema
>;

export const listConnectionsSchema = z.object({ tenantId: uuid });
export type ListConnectionsInput = z.infer<typeof listConnectionsSchema>;

export const connectionDetailSchema = z.object({
  tenantId: uuid,
  provider: integrationProviderSchema,
});
export type ConnectionDetailInput = z.infer<typeof connectionDetailSchema>;
