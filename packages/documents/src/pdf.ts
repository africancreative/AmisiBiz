import type { DocumentType } from "./series";

/**
 * PDF rendering contracts (interface only — the renderer ships in Phase 05).
 *
 * Every surface that will print a document — the web download route, mobile
 * share sheet, desktop export — agrees on ONE request shape. The
 * constitution's document-integrity rules are restated here so an
 * implementation cannot miss them:
 *
 * 1. An issued document renders from its frozen `snapshot` (captured at
 *    issuance), never from live contact/catalogue/branding rows — later edits
 *    must not rewrite an issued document.
 * 2. A rendered commercial document (quotation / invoice / delivery note) is
 *    NEVER presented as a KRA/eTIMS tax invoice.
 *
 * The concrete snapshot model is defined with the Phase 05 calculation
 * engine; the renderer input stays generic until then so this seam does not
 * pin a shape that the real engine has not produced.
 */

/** Branding block a renderer may paint. Hex colours, already contrast-checked upstream. */
export type DocumentPdfBranding = {
  displayName: string;
  primaryColor: string;
  accentColor: string;
  primaryForeground: string;
  /** Raster logo as a data URI, or null when the tenant has none. */
  logoDataUri: string | null;
};

export type DocumentPdfRenderRequest<TModel = unknown> = {
  documentType: DocumentType;
  documentNumber: string;
  /** Frozen document data captured at issuance — never assembled from live rows. */
  model: TModel;
  branding: DocumentPdfBranding;
  /** BCP-47 locale for date and number presentation (en, fr, sw). */
  locale: string;
};

export interface DocumentPdfRenderer<TModel = unknown> {
  render(request: DocumentPdfRenderRequest<TModel>): Promise<Uint8Array>;
}
