"use client";

import * as React from "react";
import { Button } from "@amisibiz/ui/button";
import { Input } from "@amisibiz/ui/input";
import { Select } from "@amisibiz/ui/select";
import { Textarea } from "@amisibiz/ui/textarea";
import { Field } from "@amisibiz/ui/field";
import { Alert } from "@amisibiz/ui/alert";
import { Loader2 } from "lucide-react";
import {
  LEAD_FIELD_MAX,
  buildPayload,
  newIdempotencyKey,
  rejectionMessage,
  submitPublicLead,
  type PublicLeadAttribution,
  type PublicLeadFormValues,
} from "@/lib/public/lead-capture";

/**
 * Public capture form — the "Request a quote" form on a product page and the
 * enquiry form on a LEAD_FORM page are the same accessible surface.
 *
 * Accessibility: every control is a labelled `Field` (real `<label>`,
 * `aria-invalid`, `aria-describedby`), the error summary is a focusable
 * `role="alert"` region announced on failure and its items link to the fields,
 * the success panel is a `role="status"` region, and the layout is one column
 * for a phone.
 *
 * Honesty: the retry identity (`crypto.randomUUID()`) is minted once per mount
 * so an error-retry re-sends the SAME key and the server returns the original
 * enquiry instead of a second one; the form only claims success when the API
 * answered 201 with a `leadId`, and a transport failure says plainly that
 * nothing was sent.
 */

const CURRENCY_OPTIONS = [
  "KES",
  "UGX",
  "TZS",
  "RWF",
  "ETB",
  "USD",
  "EUR",
  "GBP",
] as const;

const EMPTY: PublicLeadFormValues = {
  firstName: "",
  lastName: "",
  companyName: "",
  email: "",
  phone: "",
  enquiry: "",
  currency: "KES",
};

type FieldKey = keyof PublicLeadFormValues;
type FieldErrors = Partial<Record<FieldKey, string>>;

const FIELD_IDS: Record<FieldKey, string> = {
  firstName: "lead-first-name",
  lastName: "lead-last-name",
  companyName: "lead-company",
  email: "lead-email",
  phone: "lead-phone",
  enquiry: "lead-enquiry",
  currency: "lead-currency",
};

const FIELD_LABELS: Record<FieldKey, string> = {
  firstName: "First name",
  lastName: "Last name",
  companyName: "Company (optional)",
  email: "Email",
  phone: "Phone",
  enquiry: "How can we help?",
  currency: "Currency for this enquiry",
};

function validate(values: PublicLeadFormValues): FieldErrors {
  const errors: FieldErrors = {};

  if (!values.firstName.trim() && !values.companyName.trim()) {
    errors.firstName =
      "Please give a first name or a company name so we know who to reply to.";
  }
  if (values.firstName.trim().length > LEAD_FIELD_MAX.firstName) {
    errors.firstName = `First name must be ${LEAD_FIELD_MAX.firstName} characters or fewer.`;
  }
  if (values.lastName.trim().length > LEAD_FIELD_MAX.lastName) {
    errors.lastName = `Last name must be ${LEAD_FIELD_MAX.lastName} characters or fewer.`;
  }
  if (values.companyName.trim().length > LEAD_FIELD_MAX.companyName) {
    errors.companyName = `Company must be ${LEAD_FIELD_MAX.companyName} characters or fewer.`;
  }

  if (!values.email.trim() && !values.phone.trim()) {
    errors.email = "Please add an email or a phone number so we can reply.";
  }
  if (
    values.email.trim() &&
    values.email.trim().length > LEAD_FIELD_MAX.email
  ) {
    errors.email = `Email must be ${LEAD_FIELD_MAX.email} characters or fewer.`;
  } else if (
    values.email.trim() &&
    // Same shape the API's schema accepts (a single address, no spaces).
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())
  ) {
    errors.email = "Enter a valid email address.";
  }
  if (values.phone.trim().length > LEAD_FIELD_MAX.phone) {
    errors.phone = `Phone must be ${LEAD_FIELD_MAX.phone} characters or fewer.`;
  }
  if (values.enquiry.trim().length > LEAD_FIELD_MAX.enquiry) {
    errors.enquiry = `Your message must be ${LEAD_FIELD_MAX.enquiry} characters or fewer.`;
  }

  return errors;
}

export interface LeadCaptureFormProps {
  /**
   * Exactly one of `shareToken` / `tenantId`; both are values the page was
   * given. `null` (with a `disabledReason`) renders the form read-only and
   * sends nothing — used when the server offers no route for this page's
   * enquiries.
   */
  target: { shareToken: string } | { tenantId: string } | null;
  /** Query-string attribution carried through to the lead (`?utm_*`). */
  attribution?: PublicLeadAttribution | undefined;
  /** Currency shown as the explicit default (never a hidden assumption). */
  defaultCurrency: string;
  submitLabel: string;
  heading: string;
  description?: string | undefined;
  /** Prefills the message box for a product enquiry. */
  enquiryLabel?: string | undefined;
  enquiryPlaceholder?: string | undefined;
  successTitle: string;
  successBody: string;
  disabledReason?: string | undefined;
}

export function LeadCaptureForm({
  target,
  attribution,
  defaultCurrency,
  submitLabel,
  heading,
  description,
  enquiryLabel,
  enquiryPlaceholder,
  successTitle,
  successBody,
  disabledReason,
}: LeadCaptureFormProps) {
  // One retry identity for this mount: a submit that fails and is retried is
  // the SAME enquiry to the server, never a duplicate row.
  const [idempotencyKey] = React.useState(newIdempotencyKey);
  const [values, setValues] = React.useState<PublicLeadFormValues>({
    ...EMPTY,
    // The page's own currency is shown explicitly and is selectable even when
    // it is outside the common list (the capture accepts any ISO-3 code).
    currency: defaultCurrency,
  });
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [sent, setSent] = React.useState<{ duplicateSuspect: boolean } | null>(
    null,
  );

  const summaryRef = React.useRef<HTMLDivElement | null>(null);
  const statusRef = React.useRef<HTMLDivElement | null>(null);

  /** A form with no capture target is presented disabled, never as a sender. */
  const blockedReason =
    disabledReason ??
    (target ? undefined : "Online enquiries aren't available for this page.");

  const errorList = Object.entries(errors) as [FieldKey, string][];

  React.useEffect(() => {
    if (errorList.length > 0 || formError) summaryRef.current?.focus();
  }, [errorList.length, formError]);

  React.useEffect(() => {
    if (sent) statusRef.current?.focus();
  }, [sent]);

  const set = (key: FieldKey, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key]) return current;
      const next: FieldErrors = { ...current };
      delete next[key];
      return next;
    });
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target || blockedReason) return;

    const found = validate(values);
    setErrors(found);
    setFormError(null);

    if (Object.keys(found).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const outcome = await submitPublicLead(
        buildPayload(target, values, idempotencyKey),
        attribution,
      );
      if (outcome.status === "sent") {
        setSent({ duplicateSuspect: outcome.duplicateSuspect });
        return;
      }
      setFormError(rejectionMessage(outcome.reason));
    } catch {
      // No claim is made about the server: the copy says it was not recorded.
      setFormError(rejectionMessage("offline"));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (sent) {
    return (
      <section
        ref={statusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="rounded-lg border border-success/30 bg-success/5 p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <h2 className="text-base font-semibold text-success-foreground">
          {successTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{successBody}</p>
        {sent.duplicateSuspect ? (
          <p className="mt-3 text-sm text-muted-foreground">
            It looks like we may already have a similar enquiry from this
            contact. The business will review it before replying — enquiries are
            never merged automatically.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelledby="lead-capture-heading" className="space-y-4">
      <div>
        <h2
          id="lead-capture-heading"
          className="text-lg font-semibold text-foreground"
        >
          {heading}
        </h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      {blockedReason ? (
        <Alert tone="warning" title="This form is unavailable">
          {blockedReason}
        </Alert>
      ) : null}

      {(errorList.length > 0 || formError) && (
        <div
          ref={summaryRef}
          role="alert"
          aria-live="assertive"
          tabIndex={-1}
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="font-medium text-destructive">
            We couldn&apos;t send your enquiry yet
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {formError ? <li>{formError}</li> : null}
            {errorList.map(([key, message]) => (
              <li key={key}>
                <a
                  href={`#${FIELD_IDS[key]}`}
                  className="underline text-destructive"
                >
                  {FIELD_LABELS[key]}: {message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={FIELD_LABELS.firstName}
            htmlFor={FIELD_IDS.firstName}
            error={errors.firstName}
          >
            <Input
              value={values.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              maxLength={LEAD_FIELD_MAX.firstName}
              autoComplete="given-name"
              disabled={Boolean(blockedReason) || isSubmitting}
            />
          </Field>
          <Field
            label={FIELD_LABELS.lastName}
            htmlFor={FIELD_IDS.lastName}
            error={errors.lastName}
          >
            <Input
              value={values.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              maxLength={LEAD_FIELD_MAX.lastName}
              autoComplete="family-name"
              disabled={Boolean(blockedReason) || isSubmitting}
            />
          </Field>
        </div>

        <Field
          label={FIELD_LABELS.companyName}
          htmlFor={FIELD_IDS.companyName}
          error={errors.companyName}
        >
          <Input
            value={values.companyName}
            onChange={(e) => set("companyName", e.target.value)}
            maxLength={LEAD_FIELD_MAX.companyName}
            autoComplete="organization"
            disabled={Boolean(blockedReason) || isSubmitting}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={FIELD_LABELS.email}
            htmlFor={FIELD_IDS.email}
            description="An email or a phone number is enough — we only use it to reply."
            error={errors.email}
          >
            <Input
              type="email"
              inputMode="email"
              value={values.email}
              onChange={(e) => set("email", e.target.value)}
              maxLength={LEAD_FIELD_MAX.email}
              autoComplete="email"
              disabled={Boolean(blockedReason) || isSubmitting}
            />
          </Field>
          <Field
            label={FIELD_LABELS.phone}
            htmlFor={FIELD_IDS.phone}
            error={errors.phone}
          >
            <Input
              type="tel"
              inputMode="tel"
              value={values.phone}
              onChange={(e) => set("phone", e.target.value)}
              maxLength={LEAD_FIELD_MAX.phone}
              autoComplete="tel"
              disabled={Boolean(blockedReason) || isSubmitting}
            />
          </Field>
        </div>

        <Field
          label={enquiryLabel ?? FIELD_LABELS.enquiry}
          htmlFor={FIELD_IDS.enquiry}
          description={`Up to ${LEAD_FIELD_MAX.enquiry} characters. What you need, quantities and timing if you know them.`}
          error={errors.enquiry}
        >
          <Textarea
            id={FIELD_IDS.enquiry}
            value={values.enquiry}
            onChange={(e) => set("enquiry", e.target.value)}
            maxLength={LEAD_FIELD_MAX.enquiry}
            rows={4}
            placeholder={enquiryPlaceholder}
            disabled={Boolean(blockedReason) || isSubmitting}
          />
        </Field>

        <Field
          label={FIELD_LABELS.currency}
          htmlFor={FIELD_IDS.currency}
          description="The currency you expect a quote in. It is never assumed for you."
        >
          <Select
            value={values.currency}
            onChange={(e) => set("currency", e.target.value)}
            disabled={Boolean(blockedReason) || isSubmitting}
          >
            {CURRENCY_OPTIONS.includes(
              values.currency as (typeof CURRENCY_OPTIONS)[number],
            ) ? null : (
              <option value={values.currency}>{values.currency}</option>
            )}
            {CURRENCY_OPTIONS.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </Field>

        <Button type="submit" disabled={isSubmitting || Boolean(blockedReason)}>
          {isSubmitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {isSubmitting ? "Sending…" : submitLabel}
        </Button>
      </form>
    </section>
  );
}
