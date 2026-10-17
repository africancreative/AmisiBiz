import { createLogger } from "@/lib/logger";

const log = createLogger("email");

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailResult = {
  /** Always false until a real transport is wired up. Never over-claimed. */
  sent: boolean;
  reason?: string;
  /**
   * How the call was handled:
   *  - `development-console`: no provider configured outside production, so the
   *    message was printed to the log instead of delivered (dev adapter);
   *  - `unavailable`: nothing was delivered.
   */
  mode?: "development-console" | "unavailable";
};

/**
 * Email dispatch boundary.
 *
 * NO email transport is implemented yet. This function never reports
 * `sent: true`; it either uses the documented development console adapter
 * (outside production, when no provider is configured) or reports a clear
 * setup error. Production invitation / verification / password-reset flows must
 * not be enabled until a real transport (SMTP or a transactional API) replaces
 * the body of this function. See docs/architecture/security-model.md §15 and
 * docs/implementation/agent-work-plan.md (P0-2).
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const provider = process.env.EMAIL_PROVIDER?.trim();

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
