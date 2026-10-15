import { unverified, type IntegrationOutcome } from "./verification";
import type {
  EtimsAdapter,
  EtimsConfirmation,
  EtimsInvoicePayload,
} from "./etims";
import type {
  PaymentProvider,
  PaymentSession,
  PaymentSessionRequest,
  PaymentStatus,
} from "./payments";
import type {
  PosCatalogueItem,
  PosIntegration,
  PosSale,
  PosSaleExport,
} from "./pos";

/**
 * Explicitly-labelled stand-ins.
 *
 * These exist so the rest of the product can be built against the ports before a
 * real integrator is wired — and so that no one mistakes a stand-in for a live
 * integration. Every class is prefixed `Mock`, reports `isLive: false`, and
 * returns an `unverified("mock", …)` outcome from **every** method. None of them
 * performs I/O: no `fetch`, no credentials, no clock-dependent success.
 *
 * The rule they encode: a mock can *never* produce a `verified` outcome, so a
 * payment driven through a mock can never be recorded as settled and an eTIMS
 * submission driven through a mock can never be labelled recognised.
 */

const MOCK_REASON =
  "Mock adapter: no request left this process, so nothing can be confirmed.";

/** A one-line, UI-and-log-safe description that marks an adapter as a stand-in. */
export function adapterLabel(adapter: {
  name: string;
  isLive: boolean;
}): string {
  return adapter.isLive
    ? `LIVE (${adapter.name})`
    : `MOCK (${adapter.name}) — not a live integration`;
}

export class MockEtimsAdapter implements EtimsAdapter {
  readonly name = "mock-etims";
  readonly isLive = false;

  async submitInvoice(
    _payload: EtimsInvoicePayload,
  ): Promise<IntegrationOutcome<EtimsConfirmation>> {
    return unverified("mock", MOCK_REASON);
  }

  async querySubmission(
    _submissionReference: string,
  ): Promise<IntegrationOutcome<EtimsConfirmation>> {
    return unverified("mock", MOCK_REASON);
  }
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock-payments";
  readonly isLive = false;

  async createSession(
    _request: PaymentSessionRequest,
  ): Promise<IntegrationOutcome<PaymentSession>> {
    return unverified("mock", MOCK_REASON);
  }

  async queryStatus(
    _providerReference: string,
  ): Promise<IntegrationOutcome<PaymentStatus>> {
    return unverified("mock", MOCK_REASON);
  }
}

export class MockPosIntegration implements PosIntegration {
  readonly name = "mock-pos";
  readonly isLive = false;

  async listCatalogue(): Promise<
    IntegrationOutcome<readonly PosCatalogueItem[]>
  > {
    return unverified("mock", MOCK_REASON);
  }

  async exportSale(_sale: PosSale): Promise<IntegrationOutcome<PosSaleExport>> {
    return unverified("mock", MOCK_REASON);
  }
}

/** The stand-ins, for a health screen or a wiring test. All are `isLive: false`. */
export const MOCK_ADAPTERS = {
  etims: new MockEtimsAdapter(),
  payments: new MockPaymentProvider(),
  pos: new MockPosIntegration(),
} as const;
