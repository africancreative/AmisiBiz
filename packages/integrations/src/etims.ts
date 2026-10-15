import type { IntegrationOutcome } from "./verification";

/**
 * eTIMS boundary.
 *
 * eTIMS is the Kenya Revenue Authority's electronic Tax Invoice Management
 * System. It is a **separate system**, not a feature of AmisiBiz: an AmisiBiz
 * document is a commercial document, and it becomes a fiscally recognized tax
 * invoice only when KRA — through an accredited eTIMS integrator — confirms a
 * submission and assigns a fiscal invoice number. Until then it is not one, and
 * nothing here may label it as one.
 *
 * This package carries the *shape* of that exchange. It does not talk to eTIMS,
 * holds no credentials, and ships no live adapter; the only adapter that exists
 * is the explicitly-labelled mock in `./mock`. Wiring a real integrator is a
 * later, owner-gated decision with its own credentials and protocol review.
 */

/** One invoice line as the authority needs it: exact decimal strings, no floats. */
export type EtimsInvoiceLine = {
  readonly description: string;
  /** Decimal string (never a JS number — money never rides on a float). */
  readonly quantity: string;
  /** Decimal string. */
  readonly unitPrice: string;
  /** Tax rate as a decimal fraction string, e.g. `"0.16"` for 16%. */
  readonly taxRate: string;
};

export type EtimsInvoicePayload = {
  /** The AmisiBiz document that is being submitted. */
  readonly documentId: string;
  /** AmisiBiz's own number, carried for correlation only — never the fiscal number. */
  readonly documentNumber: string;
  /** ISO-8601 UTC. */
  readonly issuedAt: string;
  /** The seller's KRA PIN. Supplied by the caller; never read from env here. */
  readonly sellerPin: string;
  /** The buyer's KRA PIN when the customer is PIN-registered, else `null`. */
  readonly buyerPin: string | null;
  readonly currency: string;
  readonly lines: readonly EtimsInvoiceLine[];
  /** Decimal string. */
  readonly total: string;
  /** Decimal string. */
  readonly taxTotal: string;
};

/**
 * What a real integrator returns once it has accepted a submission. `signature`
 * is the integrator's own signed receipt; AmisiBiz stores it but never mints it.
 */
export type EtimsConfirmation = {
  /** The integrator's reference for this submission. */
  readonly submissionReference: string;
  /** The fiscal invoice number KRA assigned. Not an AmisiBiz number. */
  readonly fiscalInvoiceNumber: string;
  /** The integrator's signed receipt, opaque to AmisiBiz. */
  readonly signature: string;
};

export interface EtimsAdapter {
  /** Adapter id, e.g. `"mock-etims"`. */
  readonly name: string;
  /**
   * Whether this adapter speaks to the real service. `false` for every stand-in.
   * A mock that reported `true` would itself be a false claim, which is exactly
   * the class of mistake this package exists to prevent.
   */
  readonly isLive: boolean;
  submitInvoice(
    payload: EtimsInvoicePayload,
  ): Promise<IntegrationOutcome<EtimsConfirmation>>;
  querySubmission(
    submissionReference: string,
  ): Promise<IntegrationOutcome<EtimsConfirmation>>;
}

/**
 * How a document may be labelled on the strength of an outcome. A document is
 * `recognized` **only** for a verified provider confirmation; an unverified
 * result — a mock, a queued client submission — is `not_submitted`, never
 * `recognized`.
 */
export type EtimsValidationError = {
  /** Machine‑readable error code supplied by the integrator. */
  readonly code: string;
  /** Human‑readable description. */
  readonly message: string;
};

/** An event that enters the reconciliation ledger when a submission result arrives. */
export type EtimsReconciliationEvent = {
  /** The AmisiBiz document id. */
  readonly documentId: string;
  /** The integrator's submission reference. */
  readonly submissionReference: string;
  /** Outcome that entered the ledger. */
  readonly outcome: "verified" | "declined" | "failed" | "unverified";
  /** ISO-8601 UTC when the outcome was recorded. */
  readonly recordedAt: string;
};

export function etimsLabel(
  outcome: IntegrationOutcome<EtimsConfirmation>,
): EtimsLabel {
  switch (outcome.status) {
    case "verified":
      return "recognized";
    case "declined":
      return "rejected";
    case "failed":
      return "pending";
    case "unverified":
      return "not_submitted";
  }
}
