# AmisiBiz — integration boundaries (eTIMS, DPO Group, POS)

- **Written:** 2026-10-15, as the design half of the owner's **Phase 7:
  integration boundaries**, which is the checklist's **04.5e — DPO Group / eTIMS
  interface design** widened to include a provider-neutral POS boundary.
- **Status:** **design + contracts + explicitly-labelled stand-ins only.** No
  provider is contacted, no credential exists, and no part of this is wired into a
  runtime path. There is no completion claim against a live provider.
- **Code:** `packages/integrations` (`@amisibiz/integrations`). Rule tests:
  `apps/web/tests/phase045e-integration-boundaries.test.ts`.
- **Supersedes:** the 04.5e placeholder line in
  `../implementation/phase-checklist.md`.

---

## 1. Why this exists

Three outside systems are on the roadmap and each has a cheap way to _look_
successful without being real: a mock that always answers "ok", a browser that
lands back on a return URL, a POS terminal that reports a sale it made offline.
The constitution forbids treating any of those as proof. This phase makes that a
**property of the types** instead of a rule someone has to remember, and lays the
ports a real integrator will implement later.

It deliberately does **not** build an integration. Wiring a live provider needs a
credential and a protocol review — an owner-gated decision — and the project's
rule is that no integration is claimed until both are verified.

---

## 2. The honesty model

Every port returns an `IntegrationOutcome<T>`
(`packages/integrations/src/verification.ts`) with four shapes, and only one is
`verified`:

| Shape        | `source`                                     | Meaning                                                            |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| `verified`   | `"provider"` (literal)                       | The provider's own server-to-server answer. The only confirmation. |
| `unverified` | `mock`/`client`/`redirect`/`device`/`manual` | A value may exist, but it proves nothing.                          |
| `declined`   | `"provider"`                                 | The provider answered and refused. A real, final provider fact.    |
| `failed`     | any                                          | Something broke; a failure is not a confirmation.                  |

`Verified<T>` hard-codes `source: "provider"`, so a stand-in cannot construct a
verified result without first lying about where it came from. Callers record a
settled fact only through `isVerified(...)`.

The named consequences, enforced by tests:

- a **mock** can never settle a payment or mark an invoice recognised;
- a **redirect** back to a return URL is not a payment;
- a **device's** report of a sale is not a confirmed sale.

---

## 3. eTIMS boundary (`src/etims.ts`)

eTIMS is KRA's electronic Tax Invoice Management System — a **separate system**.
An AmisiBiz document is a commercial document; it becomes a fiscally recognized
tax invoice only when an accredited eTIMS integrator confirms a submission and
assigns a **fiscal invoice number**. AmisiBiz never mints that number or the
integrator's signature; it stores what the provider returned.

`etimsLabel(outcome)` maps an outcome to a display label and can return
`recognized` **only** for a verified provider confirmation. A mock, or a client
submission queued locally, is `not_submitted`.

The payload carries exact decimal **strings** (quantity, unit price, tax rate,
total, tax total) so no money rides on a float, and the seller/buyer PINs are
supplied by the caller — this package never reads a credential.

---

## 4. Payments boundary (`src/payments.ts`) — DPO Group and any future gateway

- **No card handling.** There is no field for a card number, CVV or full PAN,
  because AmisiBiz never touches one; the provider hosts the payment page.
- **`createSession` returns a `redirectUrl`**, named for the action, not a
  result. Sending the browser there proves nothing.
- **`queryStatus` is the authoritative call** — the only one that can produce a
  `verified` outcome, because it is the only one the provider answers directly.
  A signature-verified webhook resolves to the same `provider` source.
- `paymentIsSettled(outcome)` is true **only** for a provider-verified `paid`
  state. A mock, a redirect, or a verified-but-`pending` answer are all `false`.

---

## 5. POS boundary (`src/pos.ts`) — extension points only

A POS terminal is a **device**, so its report is never verified. The port is
deliberately narrow:

- **read** the sellable catalogue (so the terminal's screen shows current prices);
- **export** a completed sale, which AmisiBiz accepts as a **draft document
  request** — never a posted document, never an inventory event.

There is intentionally **no** method to adjust, reserve, deduct or commit stock,
and no method that closes a sale. Stock movements belong to the inventory module
where they are authorised and audited; letting a terminal drive them would turn a
lost or replayed device message into a silent inventory loss. The **absence** of
such a method is the boundary, and the rule test asserts the exact method set so
adding one fails the suite.

---

## 6. What is explicitly NOT built

- **No live adapter** for eTIMS, DPO Group or any POS provider.
- **No credentials**, no environment variables, no secret of any kind (the rule
  test reads the package source and fails on `process.env`, `fetch(`, any URL, or
  any credential-shaped identifier).
- **No network call** anywhere in the package.
- **No payment processing** and **no settlement** — the boundary can describe a
  settlement, never perform one.
- **No stock deduction** and **no stock-affecting POS method**.
- **No wiring into a runtime path**: nothing in `apps/web` calls a provider.

---

## 7. Wiring a real provider later (the intended path)

1. Owner decision + credentials + protocol review for that provider.
2. Implement the relevant port (`EtimsAdapter`, `PaymentProvider`,
   `PosIntegration`) in a **new** module that is clearly _not_ this package, so a
   reader can always tell a live adapter from a stand-in.
3. Report `isLive: true`, and return `verifiedByProvider(...)` **only** from the
   provider's own server-to-server answer. Never from a redirect, a device or a
   client payload.
4. Keep the rule test: a new adapter must not weaken the "only `provider`
   verifies" invariant.

---

## 8. Change-control rules

- Do not add a field for card data to any payment type.
- Do not add a stock-affecting method to the POS port; the extension-point set is
  a tested contract.
- Do not allow a non-`provider` source to construct a `verified` outcome; the
  literal `source: "provider"` in `Verified<T>` is the enforcement.
- Do not let this package import the database, read the environment, or perform
  network I/O.
- Do not present an AmisiBiz document as a KRA/eTIMS tax invoice on the strength
  of anything other than a verified provider confirmation.
