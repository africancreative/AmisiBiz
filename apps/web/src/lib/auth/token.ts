import { getAuthSecret } from "@/lib/env";

export const SESSION_COOKIE_NAME = "amisibiz_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type SessionPayload = {
  userId: string;
  sessionVersion: number;
  platformRole?: string | null | undefined;
};

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionToken(
  payload: SessionPayload,
  secret = getAuthSecret(),
): Promise<string> {
  const enc = new TextEncoder();
  const data = JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  });
  const dataB64 = Buffer.from(data, "utf8").toString("base64url");
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(dataB64));
  const sigB64 = Buffer.from(signature).toString("base64url");
  return `${dataB64}.${sigB64}`;
}

export async function verifySessionToken(
  token: string,
  secret = getAuthSecret(),
): Promise<SessionPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [dataB64, sigB64] = parts;
    if (!dataB64 || !sigB64) return null;

    const enc = new TextEncoder();
    const key = await getHmacKey(secret);
    const sigBytes = Buffer.from(sigB64, "base64url");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      enc.encode(dataB64),
    );
    if (!valid) return null;

    const json = Buffer.from(dataB64, "base64url").toString("utf8");
    const payload = JSON.parse(json) as {
      userId: string;
      sessionVersion: number;
      platformRole?: string | null;
      exp: number;
    };

    if (!payload.userId || typeof payload.sessionVersion !== "number") {
      return null;
    }
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      userId: payload.userId,
      sessionVersion: payload.sessionVersion,
      ...(payload.platformRole !== undefined
        ? { platformRole: payload.platformRole }
        : {}),
    };
  } catch {
    return null;
  }
}
