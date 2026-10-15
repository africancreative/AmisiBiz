import type { DocumentType } from "./series";
import type { DocumentSnapshot } from "./snapshot";

/**
 * PDF rendering contracts.
 *
 * Every surface that prints a document — the web download route, the customer
 * portal, the mobile share sheet, the desktop export — agrees on ONE request
 * shape. The constitution's document-integrity rules are restated here so an
 * implementation cannot miss them:
 *
 * 1. An issued document renders from its frozen `snapshot` (captured at
 *    issuance), never from live contact/catalogue/branding rows — later edits
 *    must not rewrite an issued document.
 * 2. A rendered commercial document (quotation / invoice / delivery note) is
 *    NEVER presented as a KRA/eTIMS tax invoice. The template says what the
 *    document is and nothing more.
 *
 * The renderer itself is `renderDocumentPdf()` in `./pdf-writer`, a
 * dependency-free writer that emits real PDF bytes (so the same input produces
 * the same file on the server, in a test, or on a device with no native PDF
 * library).
 */

/**
 * A raster image the writer can embed. The writer understands two encodings:
 * JPEG (embedded as-is with `/DCTDecode`, no decoding) and raw 8-bit RGB
 * samples (embedded uncompressed). A caller that holds a PNG decodes it to RGB
 * before calling; that decode needs a zlib inflate, which is a platform
 * concern and deliberately lives outside this package.
 */
export type PdfImage =
  | { kind: "jpeg"; data: Uint8Array }
  | { kind: "rgb"; width: number; height: number; data: Uint8Array };

/** Branding block a renderer may paint. Hex colours, already contrast-checked. */
export type DocumentPdfBranding = {
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  primaryForeground: string;
  /** Decoded logo, or null when the tenant has none. */
  logo: PdfImage | null;
};

export type DocumentPdfRenderRequest = {
  documentType: DocumentType;
  documentNumber: string;
  /** Frozen document data captured at issuance — never assembled from live rows. */
  model: DocumentSnapshot;
  branding: DocumentPdfBranding;
  /** BCP-47 locale for date and number presentation (en, fr, sw). */
  locale: string;
};

export interface DocumentPdfRenderer<TModel = DocumentSnapshot> {
  render(
    request: DocumentPdfRenderRequest & { model: TModel },
  ): Promise<Uint8Array>;
}
