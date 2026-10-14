# @amisibiz/domain

Platform-neutral domain rules shared by the web app and every future client
(mobile, desktop). No React, no Next.js, no database access.

- `src/validation/common.ts` — Zod primitives reused across every form,
  Server Action and API route (email normalisation, password policy, slugs,
  pagination, currency, decimal-string money).
- `src/branding/contrast.ts` — WCAG 2.1 contrast maths shared by the branding
  form (live warning) and the branding Server Action (authoritative
  rejection).

Browser-side validation is a convenience; the server re-validates with these
same schemas — a client-submitted value is never trusted.
