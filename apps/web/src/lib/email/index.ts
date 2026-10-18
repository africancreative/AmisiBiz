import { createLogger } from "@/lib/logger";

const log = createLogger("email");

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailResult = {
  /** True when delivered successfully via Mailtrap or real transport. */
  sent: boolean;
  reason?: string;
  /**
   * How the call was handled:
   *  - `development-console`: no provider configured outside production, message printed to log;
   *  - `mailtrap-sandbox`: delivered to Mailtrap Sandbox;
   *  - `mailtrap-live`: delivered to Mailtrap Production / Live stream;
   *  - `unavailable`: nothing was delivered.
   */
  mode?:
    | "development-console"
    | "mailtrap-sandbox"
    | "mailtrap-live"
    | "unavailable";
};

function parseSender(fromStr?: string): { name: string; email: string } {
  if (!fromStr) {
    return { name: "AmisiBiz", email: "noreply@amisibiz.com" };
  }
  const match = fromStr.match(/^(.+?)\s*<([^>]+)>$/);
  if (match && match[1] && match[2]) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: "AmisiBiz", email: fromStr.trim() };
}

async function sendViaMailtrap(
  message: EmailMessage,
  apiKey: string,
): Promise<EmailResult> {
  const useSandbox =
    process.env.USE_SANDBOX?.trim().toLowerCase() === "true" ||
    process.env.MAILTRAP_USE_SANDBOX?.trim().toLowerCase() === "true";
  const inboxId =
    process.env.INBOX_ID?.trim() || process.env.MAILTRAP_INBOX_ID?.trim();

  const endpoint =
    useSandbox && inboxId
      ? `https://sandbox.api.mailtrap.io/api/send/${inboxId}`
      : "https://send.api.mailtrap.io/api/send";

  const defaultFrom = useSandbox
    ? "hello@demomailtrap.co"
    : "noreply@amisibiz.com";
  const sender = parseSender(
    process.env.EMAIL_FROM?.trim() ||
      process.env.MAILTRAP_FROM_EMAIL?.trim() ||
      defaultFrom,
  );

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Api-Token": apiKey,
      },
      body: JSON.stringify({
        from: sender,
        to: [{ email: message.to }],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (res.ok) {
      log.info("Email delivered via Mailtrap", {
        to: message.to,
        subject: message.subject,
        sandbox: useSandbox,
      });
      return {
        sent: true,
        mode: useSandbox ? "mailtrap-sandbox" : "mailtrap-live",
      };
    }

    const errorBody = await res.text();
    log.error("Mailtrap API returned an error response", {
      status: res.status,
      body: errorBody,
      to: message.to,
    });
    return {
      sent: false,
      reason: `MAILTRAP_API_ERROR_${res.status}`,
      mode: "unavailable",
    };
  } catch (err) {
    log.error("Failed to connect to Mailtrap API", {
      error: err instanceof Error ? err.message : String(err),
      to: message.to,
    });
    return {
      sent: false,
      reason: "MAILTRAP_NETWORK_ERROR",
      mode: "unavailable",
    };
  }
}

/**
 * Email dispatch boundary.
 *
 * Supports Mailtrap transactional sending (Vercel integration) via HTTP API.
 * In development without Mailtrap configured, logs to the console adapter.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const provider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  const mailtrapKey =
    process.env.MAILTRAP_TOKEN?.trim() ||
    process.env.MAILTRAP_API_KEY?.trim() ||
    (provider === "mailtrap" ? process.env.API_KEY?.trim() : undefined) ||
    (!provider && process.env.API_KEY?.trim() ? process.env.API_KEY?.trim() : undefined);

  if (
    provider === "mailtrap" ||
    (mailtrapKey && (!provider || provider === "mailtrap"))
  ) {
    const key =
      mailtrapKey ||
      process.env.API_KEY?.trim() ||
      process.env.MAILTRAP_API_KEY?.trim() ||
      process.env.MAILTRAP_TOKEN?.trim();

    if (!key) {
      log.error(
        "EMAIL_PROVIDER=mailtrap is set but Mailtrap API key/token is missing",
      );
      return {
        sent: false,
        reason: "MAILTRAP_API_KEY_NOT_CONFIGURED",
        mode: "unavailable",
      };
    }

    return sendViaMailtrap(message, key);
  }

  if (!provider) {
    if (process.env.NODE_ENV !== "production") {
      // Development-only adapter: surface the message so a developer can act on
      // it, without pretending it was delivered.
      log.warn(
        "EMAIL_PROVIDER not configured — development console adapter (message NOT delivered)",
        { to: message.to, subject: message.subject, text: message.text },
      );
      return {
        sent: false,
        reason: "EMAIL_PROVIDER_NOT_CONFIGURED",
        mode: "development-console",
      };
    }

    log.error(
      "EMAIL_PROVIDER is not configured — account emails cannot be delivered in production",
      { to: message.to, subject: message.subject },
    );
    return {
      sent: false,
      reason: "EMAIL_PROVIDER_NOT_CONFIGURED",
      mode: "unavailable",
    };
  }

  log.error(
    "EMAIL_PROVIDER is set but no transport is implemented — nothing was delivered",
    { provider, to: message.to, subject: message.subject },
  );
  return {
    sent: false,
    reason: "EMAIL_TRANSPORT_NOT_IMPLEMENTED",
    mode: "unavailable",
  };
}
