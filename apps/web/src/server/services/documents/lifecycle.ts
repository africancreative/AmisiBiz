import {
  allowedTransitions,
  assertTransition,
  canTransition,
  deriveDeliveryStatus,
  deriveInvoiceStatus,
  isConvertibleQuotation,
  isEditable,
  isIssued,
  DocumentLifecycleError,
  type DocumentStatus,
} from "@amisibiz/documents";
import type { DocumentType } from "@prisma/client";
import { DocumentServiceError } from "./errors";

/**
 * Server-side view of the document lifecycle.
 *
 * The state machine lives in `@amisibiz/documents` so the same rule governs the
 * server and the offline client. This wrapper translates a lifecycle violation
 * into the engine's error type — with the fields a form needs — and exposes the
 * two derived-status helpers.
 *
 * The derived helpers are the part that matters for payments: `PAID`,
 * `PARTIALLY_PAID` and `OVERDUE` are never set directly. They are the answer to
 * "given the recorded payments and the due date, what is this invoice?", which is
 * why a manual status change or a browser redirect can never mark an invoice
 * paid.
 */

export {
  allowedTransitions,
  canTransition,
  deriveDeliveryStatus,
  deriveInvoiceStatus,
  isConvertibleQuotation,
  isEditable,
  isIssued,
};

export type { DocumentStatus };

/** Fails with a service error rather than a bare domain error. */
export function assertDocumentTransition(
  type: DocumentType,
  from: DocumentStatus,
  to: DocumentStatus,
): void {
  try {
    assertTransition(type, from, to);
  } catch (error) {
    if (error instanceof DocumentLifecycleError) {
      throw new DocumentServiceError("ILLEGAL_TRANSITION", error.message);
    }
    throw error;
  }
}
