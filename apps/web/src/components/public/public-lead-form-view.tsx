import * as React from "react";
import { PublicShell } from "./public-shell";
import { LeadCaptureForm } from "./lead-capture-form";
import type { PublicLeadAttribution } from "@/lib/public/lead-capture";

/**
 * Public LEAD_FORM page (`/s/<token>` whose link kind is `LEAD_FORM`).
 *
 * The share resolver answers with the link's kind only: there is no content
 * endpoint for a lead-form link, so this page carries no business name, no
 * branding and no catalogue data — nothing the token did not release. The
 * capture itself is addressed by the token, and the tenant is resolved
 * server-side inside `app_public_lead_capture`, so no tenant identifier ever
 * appears in the URL or the markup.
 */
export function PublicLeadFormView({
  token,
  attribution,
}: {
  token: string;
  attribution?: PublicLeadAttribution | undefined;
}) {
  return (
    <PublicShell>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Send an enquiry
        </h1>
        <p className="text-sm text-muted-foreground">
          Fill this in and the business receives your request. It does not place
          an order, book anything or start a payment.
        </p>
      </div>

      <LeadCaptureForm
        target={{ shareToken: token }}
        attribution={attribution}
        defaultCurrency="KES"
        heading="How can we help?"
        description="Tell us what you need and how to reach you. The currency you pick is recorded with the enquiry — it is never assumed."
        submitLabel="Send enquiry"
        enquiryPlaceholder="What are you looking for? Quantities and timing help us reply faster."
        successTitle="Thanks — your enquiry has been sent"
        successBody="The business will reply using the contact details you gave. No order has been placed."
      />
    </PublicShell>
  );
}
