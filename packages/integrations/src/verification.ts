/**
 * The one thing an integration result must never be: a lie about who confirmed it.
 *
 * AmisiBiz talks to three kinds of outside system — a tax authority (eTIMS), a
 * payment gateway (DPO Group) and point-of-sale terminals — and each of them has
 * a cheap way to *look* successful without being confirmed:
 *
 *   - a **mock** adapter that always says "ok";
 *   - a **redirect** that brings the browser back to a "thank you" page;
 *   - a **device** (a POS terminal) that reports a sale it made offline;
 *   - a **client** call that posts whatever the app felt like posting.
 *
 * None of those is a confirmation, and the constitution is explicit that none may
 * be *treated* as one. This module makes that a property of the type system rather
 * than a rule someone has to remember: an outcome is `verified` only when its
 * `source` is literally `"provider"`, so a stand-in physically cannot build a
 * verified result without first lying about where it came from.
 */

/** Every origin that can never confirm anything on its own. */
export type UnverifiedSource =
  "mock" | "client" | "redirect" | "device" | "manual";

/** The origins plus the one that can confirm: the provider itself. */
export type VerificationSource = UnverifiedSource | "provider";

/**
 * Whether an origin is allowed to confirm. Kept as a runtime helper as well as a
 * type, because logs and UI need to explain a refusal (\"this came back via
 * redirect, so it is not a payment\") without re-deriving the rule.
 */
export function sourceCanVerify(source: VerificationSource): boolean {
  return source === "provider";
}

/** The provider's own server-to-server answer. The only verified shape. */
export type Verified<T> = {
  readonly status: "verified";
  readonly source: "provider";
  /** The provider's reference for the fact — never an AmisiBiz identifier. */
  readonly reference: string;
  readonly value: T;
};

/** A stand-in or an unconfirmed origin: a value may exist, but it proves nothing. */
export type Unverified = {
  readonly status: "unverified";
  readonly source: UnverifiedSource;
  readonly reason: string;
};

/** The provider answered and refused. A real, final provider fact. */
export type Declined = {
  readonly status: "declined";
  readonly source: "provider";
  readonly detail: string;
};

/**
 * Something went wrong. `source` records where the failure was observed, which is
 * not the same as confirmation: a transport error from an unconfigured stand-in
 * is still not a provider answer.
 */
export type Failed = {
  readonly status: "failed";
  readonly source: VerificationSource;
  readonly detail: string;
};

/** The result of every integration call. Only `Verified` may settle anything. */
export type IntegrationOutcome<T> =
  Verified<T> | Unverified | Declined | Failed;

/** The single predicate callers must use before recording a settled fact. */
export function isVerified<T>(
  outcome: IntegrationOutcome<T>,
): outcome is Verified<T> {
  return outcome.status === "verified";
}

/**
 * A result from an origin that cannot confirm. Note the parameter type: passing
 * `"provider"` here is a compile error, so this cannot be used to fake confidence.
 */
export function unverified(
  source: UnverifiedSource,
  reason: string,
): Unverified {
  return { status: "unverified", source, reason };
}

/** The only constructor of a verified outcome, and it demands a provider reference. */
export function verifiedByProvider<T>(
  reference: string,
  value: T,
): Verified<T> {
  return { status: "verified", source: "provider", reference, value };
}

/** The provider answered and refused. */
export function declinedByProvider(detail: string): Declined {
  return { status: "declined", source: "provider", detail };
}

/** A failure, tagged with where it was seen. */
export function failed(source: VerificationSource, detail: string): Failed {
  return { status: "failed", source, detail };
}
