# @amisibiz/integrations

Provider-neutral integration **boundaries** for the three outside systems
AmisiBiz will eventually talk to: KRA **eTIMS** (tax invoicing), **DPO Group**
(payments) and **POS** terminals.

**Contracts and stand-ins only.** Nothing in this package performs I/O, holds a
credential, or contacts a real provider. The only adapters that exist are the
explicitly-labelled mocks in `src/mock.ts`, and every one of them reports
`isLive: false`. Wiring a live integrator is a later, owner-gated decision with
its own credential and protocol review.

## The honesty model (`src/verification.ts`)

Every call returns an `IntegrationOutcome<T>`, and only one of its four shapes is
`verified` — and its `source` is literally `"provider"`. The type system makes it
impossible to build a verified outcome from a `mock`, a `client`, a `redirect`, a
`device` or a `manual` source without first lying about where it came from. In
particular:

- a **mock** can never settle a payment or mark an invoice recognised;
- a **redirect** back to a return URL is not a payment;
- a **device's** report of a sale is not a confirmed sale.

Callers must use `isVerified(...)` before recording anything settled.

## The three ports

- `src/etims.ts` — eTIMS stays a **separate system**: an AmisiBiz document only
  becomes a fiscally recognized tax invoice when the integrator confirms it and
  assigns a fiscal number. `etimsLabel()` maps an outcome to a label and can only
  return `recognized` for a verified confirmation.
- `src/payments.ts` — DPO Group (and any future gateway) behind one port. No card
  data field exists; the provider hosts the page. Only a verified status answer
  settles, via `paymentIsSettled()`, and only for a `paid` state.
- `src/pos.ts` — **extension points only**: a terminal may read the catalogue and
  export a completed sale as a **draft document request**. There is deliberately
  no method to adjust, reserve or deduct stock, and no method that closes a sale.

## Where this is used

The web app consumes the contracts to type its future integration service and its
wiring tests; no runtime path calls a provider today. See
`docs/architecture/integration-boundaries.md` for the full rule set and what is
explicitly **not** built.
