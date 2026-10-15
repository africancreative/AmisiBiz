import { isVerified, type IntegrationOutcome } from "./verification";

/**
 * Payment boundary (DPO Group today; any future gateway behind the same port).
 *
 * What this boundary refuses to do, because a payment is the one fact in the
 * product that must never be guessed:
 *
 *  - **No card handling.** AmisiBiz never touches a card number, CVV or full PAN;
 *    the provider hosts the payment page. There is deliberately no field here for
 *    card data, so there is nothing for a future caller to accidentally collect.
 *  - **A redirect is not a payment.** Coming back to a return URL only proves a
 *    browser navigated; it is tagged `redirect` and can never settle anything.
 *  - **Only the provider settles.** A verified, server-to-server status answer —
 *    or a signature-verified webhook, which resolves to the same `provider`
 *    source — is the single way a payment becomes settled.
 *
 * As with eTIMS, this package holds the contract, no credentials and no live
 * adapter; wiring DPO is a later, owner-gated decision.
 */

export type PaymentSessionRequest = {
  /** Our own order reference, carried for correlation. */
  readonly orderReference: string;
  /** Decimal string. */
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  /** Where the provider returns the browser. A landing here proves nothing. */
  readonly returnUrl: string;
  /** Optional customer email for the provider's receipt, else `null`. */
  readonly customerEmail: string | null;
};

export type PaymentSession = {
  /** The provider's reference for the attempt. */
  readonly providerReference: string;
  /**
   * Where the browser is sent to pay. Its presence is not evidence of payment,
   * and the field is named for the action (`redirectUrl`), not a result.
   */
  readonly redirectUrl: string;
};

/** The states a gateway can report for an attempt. */
export type PaymentState = "pending" | "paid" | "cancelled" | "failed";

export type PaymentStatus = {
  readonly providerReference: string;
  readonly state: PaymentState;
  /** Decimal string, echoed by the provider for reconciliation. */
  readonly amount: string;
  readonly currency: string;
};

export interface PaymentProvider {
  readonly name: string;
  /** Whether this adapter talks to a real gateway. `false` for every stand-in. */
  readonly isLive: boolean;
  createSession(
    request: PaymentSessionRequest,
  ): Promise<IntegrationOutcome<PaymentSession>>;
  /**
   * The authoritative status check. This is the only call that can produce a
   * `verified` outcome, because it is the only one the provider answers directly.
   */
  queryStatus(
    providerReference: string,
  ): Promise<IntegrationOutcome<PaymentStatus>>;
}

/**
 * Whether an outcome may be recorded as a settled payment. True only for a
 * provider-verified `paid` status: a mock, a redirect, or a verified-but-pending
 * answer are all `false`.
 */
export function paymentIsSettled(
  outcome: IntegrationOutcome<PaymentStatus>,
): boolean {
  return isVerified(outcome) && outcome.value.state === "paid";
}
