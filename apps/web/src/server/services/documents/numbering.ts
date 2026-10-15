import type { ScopedTx } from "@amisibiz/database";
import type { DocumentType } from "@prisma/client";
import { DocumentServiceError } from "./errors";

/**
 * Authoritative document numbering.
 *
 * The number is allocated by `allocate_document_number()` inside the database,
 * in the SAME transaction that writes the document and freezes its snapshot.
 * That is not an implementation detail to be moved for convenience later:
 *
 *  - the function takes `SELECT … FOR UPDATE` on the counter row, which is what
 *    serialises two people issuing invoices at the same instant;
 *  - the unique index on `(tenantId, type, number)` is the backstop if the lock
 *    is ever bypassed;
 *  - "series exhausted" (`program_limit_exceeded`) is surfaced as its own code,
 *    because the right response is to reconfigure the padding, never to silently
 *    widen the number and risk a collision with a differently formatted series.
 *
 * Application code never composes the issued number itself. `previewDocumentNumber`
 * in `@amisibiz/documents` mirrors the composition rule for the settings screen,
 * and `peek_document_number()` (below) mirrors it in SQL for the same reason:
 * the preview must never disagree with what issuance will produce.
 */

async function callNumberFunction(
  tx: ScopedTx,
  function_: "allocate_document_number" | "peek_document_number",
  input: { tenantId: string; type: DocumentType; date: string },
): Promise<string> {
  try {
    const rows = await tx.$queryRaw<Array<{ number: string | null }>>`
      SELECT public.${function_}(
        ${input.tenantId}::text,
        ${input.type}::"DocumentType",
        ${input.date}::date
      ) AS number
    `;

    const number = rows[0]?.number;
    if (!number) {
      throw new DocumentServiceError(
        "NUMBERING",
        "The numbering function returned no value.",
      );
    }
    return number;
  } catch (error) {
    if (error instanceof DocumentServiceError) throw error;
    // A `program_limit_exceeded` from an exhausted series, a missing tenant, or
    // any other database refusal: the caller gets a numbering failure, not a
    // raw driver error, and never a partially written document.
    throw new DocumentServiceError(
      "NUMBERING",
      "A document number could not be allocated. The series may need reconfiguring.",
    );
  }
}

/** Allocates and consumes the next number for `(tenantId, type, periodOfDate)`. */
export function allocateDocumentNumber(
  tx: ScopedTx,
  input: { tenantId: string; type: DocumentType; date: string },
): Promise<string> {
  return callNumberFunction(tx, "allocate_document_number", input);
}

/** The number issuance would produce next, without consuming it. */
export function peekDocumentNumber(
  tx: ScopedTx,
  input: { tenantId: string; type: DocumentType; date: string },
): Promise<string> {
  return callNumberFunction(tx, "peek_document_number", input);
}
