# @amisibiz/documents

Document-domain models shared across surfaces. Platform-neutral — no React,
no Next.js, no database access. Pure TypeScript so the same code runs in the
web app, a Capacitor app and the Tauri shell.

- `src/series.ts` — `DocumentType` vocabulary and the default series
  (`QUO` / `INV` / `DN`) a new tenant is provisioned with.
- `src/money.ts` — exact decimal-string display formatting. Amounts are never
  routed through a JS `number`; float parsing can silently change a figure a
  customer reads on a quote or invoice.
- `src/pdf.ts` — interfaces only for the Phase 05 PDF renderer
  (`DocumentPdfRenderer`, request/branding contracts). The calculation engine
  and renderer implementations ship in Phase 05.
