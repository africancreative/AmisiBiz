import {
  readDocumentSnapshot,
  renderDocumentPdf,
  type DocumentPdfBranding,
} from "@amisibiz/documents";
import type { DocumentType } from "@prisma/client";
import { loadLogoImage } from "./logo";
import { DocumentServiceError } from "./errors";

/**
 * Renders an issued document to PDF bytes.
 *
 * Two rules from the constitution are enforced here and nowhere else:
 *
 *  1. **Print the snapshot, never the live rows.** The model handed to the
 *     writer is `readDocumentSnapshot(document.snapshot)` — the copy frozen at
 *     issuance. A contact renamed, a price changed or branding restyled after
 *     the fact cannot alter this file, because none of those rows are read.
 *  2. **A draft has nothing to print.** `readDocumentSnapshot` returns null for a
 *     document that was never issued, so the caller gets a `CONFLICT` rather
 *     than a blank page presented as a real invoice.
 *
 * The ONLY live read is the logo: the bytes are a platform concern and are not
 * inside the JSON snapshot. Everything else — colours, the display name, the
 * customer block, the totals — comes from the snapshot. Loading a logo cannot
 * rewrite a figure, so this one exception is safe.
 */

export interface RenderableDocument {
  type: DocumentType;
  number: string | null;
  snapshot: unknown;
}

export async function renderDocumentSnapshotPdf(
  document: RenderableDocument,
  locale: string,
): Promise<Uint8Array> {
  const snapshot = readDocumentSnapshot(document.snapshot);
  if (!snapshot) {
    throw new DocumentServiceError(
      "CONFLICT",
      "This document has not been issued yet, so there is nothing to download.",
    );
  }

  const branding: DocumentPdfBranding = {
    displayName: snapshot.branding.displayName,
    primaryColor: snapshot.branding.primaryColor,
    secondaryColor: snapshot.branding.secondaryColor,
    accentColor: snapshot.branding.accentColor,
    primaryForeground: snapshot.branding.primaryForeground,
    logo: await loadLogoImage(snapshot.branding.logoUrl),
  };

  return renderDocumentPdf({
    documentType: document.type,
    documentNumber: document.number ?? snapshot.number,
    model: snapshot,
    branding,
    locale,
  });
}

/**
 * A filesystem-safe download name, e.g. `invoice-INV-2026-0007.pdf`. A number
 * can contain `/` or spaces when a tenant configures a separator, so every
 * character outside `[A-Za-z0-9._-]` is replaced rather than trusted.
 */
export function documentPdfFilename(
  type: DocumentType,
  number: string | null,
): string {
  const kind = type.toLowerCase();
  const safe = (number ?? "draft").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${kind}-${safe}.pdf`;
}
