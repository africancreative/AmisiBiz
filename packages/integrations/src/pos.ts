import type { IntegrationOutcome } from "./verification";

/**
 * Point-of-sale boundary — provider-neutral **extension points only**.
 *
 * A POS terminal is a *device*, and the constitution's rule is that a device is
 * never treated as verified. So this port is deliberately narrow:
 *
 *  - a POS may **read** the sellable catalogue (so its own screen shows current
 *    prices), and
 *  - a POS may **export** a sale it already completed, which AmisiBiz accepts as a
 *    **draft document request** — never a posted document, never an inventory
 *    event.
 *
 * There is intentionally **no** method here to adjust, reserve, deduct or commit
 * stock, and no method that closes a sale in AmisiBiz. Stock movements belong to
 * the inventory module where they are authorised and audited; letting a terminal
 * drive them would make a lost or replayed device message a silent inventory loss.
 * The absence of such a method is the boundary, not an oversight.
 *
 * The outcome of `exportSale` is a draft request tagged with the device as its
 * source, and it is therefore never `verified`: it becomes real only when a
 * signed-in user reviews and issues it.
 */

export type PosCatalogueItem = {
  /** The AmisiBiz item id, so the terminal can reference it back. */
  readonly itemId: string;
  readonly sku: string | null;
  readonly name: string;
  readonly unitPrice: string;
  readonly currency: string;
  /** Tax rate as a decimal fraction string, e.g. `"0.16"`. */
  readonly taxRate: string;
};

export type PosSaleLine = {
  readonly itemId: string;
  /** Decimal string. */
  readonly quantity: string;
  /** The price the terminal actually charged. Decimal string. */
  readonly unitPrice: string;
};

export type PosSale = {
  /** The terminal's own sale/receipt id — a device identifier, echoed for dedup. */
  readonly deviceSaleId: string;
  /** ISO-8601 UTC as observed on the device. Debug/dedup only; not authoritative. */
  readonly occurredAt: string;
  readonly lines: readonly PosSaleLine[];
  /** Decimal string. */
  readonly total: string;
  readonly currency: string;
};

/**
 * What AmisiBiz accepts from a device: a **draft** request for a document, or an
 * explicit acknowledgement that the sale was already imported (a retry). It is
 * not a receipt of a completed document and carries no stock effect.
 */
export type PosSaleExport = {
  readonly kind: "draft_document_request" | "already_imported";
  /** The device sale id this concerns, echoed for idempotent matching. */
  readonly deviceSaleId: string;
  /** Present for `draft_document_request`; absent for `already_imported`. */
  readonly draftDocumentId?: string;
};

export interface PosIntegration {
  readonly name: string;
  /** Whether this adapter talks to a real terminal/back-office. `false` for stand-ins. */
  readonly isLive: boolean;
  /** Read-only: the sellable catalogue for the terminal's screen. */
  listCatalogue(): Promise<IntegrationOutcome<readonly PosCatalogueItem[]>>;
  /** Accept a device's completed sale as a draft request (never a stock move). */
  exportSale(sale: PosSale): Promise<IntegrationOutcome<PosSaleExport>>;
}
