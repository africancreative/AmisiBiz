export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailResult = {
  sent: boolean;
  reason?: string;
};

/**
 * Minimal email dispatch abstraction.
 *
 * IMPORTANT: no email transport is implemented yet. When no provider is
 * configured this function does NOT send anything and clearly reports that.
 * Production registration / password reset MUST NOT be enabled until a real
 * transport (SMTP or transactional API) is wired up here. See
 * docs/architecture/security-model.md.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const provider = process.env.EMAIL_PROVIDER;
  if (!provider) {
    console.warn(
      `[email] EMAIL_PROVIDER not configured — no email sent to ${message.to}.`,
    );
    return { sent: false, reason: "EMAIL_PROVIDER_NOT_CONFIGURED" };
  }

  console.warn(
    `[email] EMAIL_PROVIDER="${provider}" is set but no transport is implemented; email to ${message.to} was not sent.`,
  );
  return { sent: false, reason: "EMAIL_TRANSPORT_NOT_IMPLEMENTED" };
}
