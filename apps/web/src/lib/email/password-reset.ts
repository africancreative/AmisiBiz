import { sendEmail } from "./index";

export type PasswordResetEmailOptions = {
  to: string;
  userName?: string | null;
  resetUrl: string;
  locale?: string;
};

type EmailCopy = {
  subject: string;
  greeting: (name?: string | null) => string;
  body: string;
  buttonText: string;
  ignoreNote: string;
  signOff: string;
};

const DEFAULT_COPY: EmailCopy = {
  subject: "Reset your AmisiBiz password",
  greeting: (name) => (name ? `Hello ${name},` : "Hello,"),
  body: "We received a request to reset the password for your AmisiBiz account. Click the button below to choose a new password:",
  buttonText: "Reset Password",
  ignoreNote:
    "This link is valid for 1 hour. If you did not request a password reset, you can safely ignore this email — your password will remain unchanged.",
  signOff: "The AmisiBiz Team",
};

const COPY: Record<string, EmailCopy> = {
  en: DEFAULT_COPY,
  sw: {
    subject: "Badilisha nenosiri lako la AmisiBiz",
    greeting: (name) => (name ? `Hujambo ${name},` : "Hujambo,"),
    body: "Tulipokea ombi la kubadilisha nenosiri la akaunti yako ya AmisiBiz. Bofya kitufe hapa chini ili kuweka nenosiri jipya:",
    buttonText: "Badilisha Nenosiri",
    ignoreNote:
      "Kiungo hiki ni halali kwa saa 1. Ikiwa hukuomba kubadilisha nenosiri, unaweza kupuuza barua pepe hii — nenosiri lako halitabadilishwa.",
    signOff: "Timu ya AmisiBiz",
  },
  fr: {
    subject: "Réinitialisez votre mot de passe AmisiBiz",
    greeting: (name) => (name ? `Bonjour ${name},` : "Bonjour,"),
    body: "Nous avons reçu une demande de réinitialisation de votre mot de passe pour votre compte AmisiBiz. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe :",
    buttonText: "Réinitialiser le mot de passe",
    ignoreNote:
      "Ce lien est valable pendant 1 heure. Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet e-mail en toute sécurité — votre mot de passe restera inchangé.",
    signOff: "L'équipe AmisiBiz",
  },
};

export async function sendPasswordResetEmail({
  to,
  userName,
  resetUrl,
  locale = "en",
}: PasswordResetEmailOptions) {
  const lang: EmailCopy = COPY[locale] ?? DEFAULT_COPY;

  const text = `${lang.greeting(userName)}

${lang.body}

${resetUrl}

${lang.ignoreNote}

${lang.signOff}`;

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${lang.subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden;">
    <tr>
      <td style="padding: 32px 32px 24px; text-align: center; border-bottom: 1px solid #f1f5f9;">
        <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #0f172a; letter-spacing: -0.5px;">AmisiBiz</h1>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px;">
        <p style="margin: 0 0 16px; font-size: 16px; line-height: 24px; font-weight: 600; color: #0f172a;">${lang.greeting(userName)}</p>
        <p style="margin: 0 0 24px; font-size: 15px; line-height: 24px; color: #475569;">${lang.body}</p>
        <table border="0" cellspacing="0" cellpadding="0" style="margin: 28px 0;">
          <tr>
            <td align="center" style="border-radius: 6px; background-color: #0f172a;">
              <a href="${resetUrl}" target="_blank" style="display: inline-block; padding: 12px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 6px;">${lang.buttonText}</a>
            </td>
          </tr>
        </table>
        <p style="margin: 24px 0 0; font-size: 13px; line-height: 20px; color: #64748b;">
          ${lang.ignoreNote}
        </p>
        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #f1f5f9; font-size: 12px; color: #94a3b8; word-break: break-all;">
          If the button above does not work, copy and paste this link into your browser:<br>
          <a href="${resetUrl}" style="color: #2563eb; text-decoration: underline;">${resetUrl}</a>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding: 16px 32px; background-color: #f8fafc; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
        &copy; ${new Date().getFullYear()} AmisiBiz. All rights reserved.
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendEmail({
    to,
    subject: lang.subject,
    text,
    html,
  });
}
