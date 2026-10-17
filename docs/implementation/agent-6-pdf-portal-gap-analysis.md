# AGENT 6 — Private PDF generation and customer portal: inventory and gap analysis

Date: 2026-10-18 · Status: **inventory complete, no code modified.** Most of the
directive is already delivered (Phase 05 rendering/downloads + the AGENT 4
portal-access work committed as `9dd479d`); the one large unbuilt area is
private object storage (§3.1), which the directive itself says must not be
claimed operational until a real provider is configured and integration-tested.

## 1. What already holds, per directive section

| Section                     | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A — PDF generation          | **Holds**                 | `services/documents/render.ts` renders ONLY `readDocumentSnapshot(document.snapshot)`; a draft (no snapshot) is a 409, never a blank page. The snapshot carries issuer/business contact details, logo URL, brand colours, customer block, number, all dates, lines with quantities/prices/discounts, currency, per-rate tax breakdown, totals, terms, footer, payment instructions (`packages/documents/src/snapshot.ts`). Totals are never recomputed from current settings — the snapshot is self-contained and the PDF writer re-derives totals from the snapshot's own copied lines only. Verified the writer prints display fields only (`pdf-writer.ts:573–977`: names, addresses, phone/email, website, PIN) — no tenantId, contactId or other internal identifiers in the rendered file. |
| C — Authorized downloads    | **Holds**                 | Two centralized routes. Staff: `GET /api/documents/[documentId]/pdf` (permission `documents.download`). Portal: `GET /api/portal/documents/[documentId]/pdf` (session → `resolvePortalContext` → the contact link is IN the query's WHERE, so another customer's document is a 404 indistinguishable from a bad id). Both stream with `Cache-Control: private, no-store`; there are no permanent or pre-signed URLs to leak, and the audit rows record number/type only. Callers cannot supply an object key: the routes accept a document id and resolve storage server-side.                                                                                                                                                                                                                   |
| D — Portal identity         | **Holds structurally**    | `CUSTOMER_PORTAL_USER` is a distinct role holding only `portal.*` permissions and no staff document permissions; access = role + the explicit `Contact.portalUserId` link in that tenant (links-never-promotes; grant and revoke are audited ids-only — `actions/portal-access.ts:478,564`). Login/logout run through the native credential stack with rate limiting on both IP and email buckets (`lib/security/rate-limit.ts`, Redis/Upstash with in-memory dev fallback). Every portal surface re-resolves the link per request, so revocation takes effect on the next request.                                                                                                                                                                                                              |
| E — Document sharing        | **Holds as a model**      | The explicit, auditable authorization relationship is the admin-created portal link: server verifies document.tenantId (WHERE), the customer belongs to the same tenant (the link query is tenant-scoped), the portal identity is authorized for exactly that customer, availability is intentional (granting portal access is the audited act), and revocation is enforced. Drafts are excluded from the portal list (`status: { not: "DRAFT" }`) and refused by download. **Design note for the technical lead:** visibility is "all issued documents of the linked customer", not per-document share flags — see §3.4.                                                                                                                                                                        |
| F — Failure recovery        | **Holds by construction** | Rendering is synchronous and strictly decoupled from issuance: a PDF is rendered on demand after issuance, so a failed render can never leave a falsely completed issuance state. Storage outage / missing object: only the logo read can fail, and `loadLogoImage` degrades to printing the business name rather than failing the download. Revoked access / expired session: per-request link re-check and the portal guard redirect; unauthenticated API calls get 401. Retry rule for sync rendering is "the user retries the request"; nothing is queued.                                                                                                                                                                                                                                   |
| Gate — no compliance claims | **Holds**                 | No eTIMS/KRA text exists in any UI or PDF surface; the writer's own contract forbids presenting a document as a KRA/eTIMS tax invoice (`pdf.ts:15–17`, `pdf-writer.ts:23`, verified by grep).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 2. Acceptance gate mapping

| Gate item                                             | Verdict                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDFs use issued snapshots                             | Holds (tested: `phase05-documents.test.ts` snapshot freezing, deterministic bytes, draft 409).                                                                                                                                                                          |
| Storage is private                                    | Holds in the access sense: `uploads/tenants/[...path]/route.ts` serves uploads only to authenticated members (or platform admin), with fixed path shape, traversal-proof resolution, `no-store`, sandboxed CSP. **PDFs are not stored at all** — they stream on demand. |
| Unauthorized users cannot generate download links     | Holds trivially: no links exist to generate; both routes require session + role + (portal) link.                                                                                                                                                                        |
| Expired links stop working                            | N/A in the streaming model — there are no links. Becomes live the day signed URLs are introduced (§3.1).                                                                                                                                                                |
| Portal users cannot access other customers' documents | Holds (contact id inside the WHERE; tested cross-customer 404).                                                                                                                                                                                                         |
| Revoked access is enforced                            | Holds (per-request link resolution; tested).                                                                                                                                                                                                                            |
| Storage failures handled safely                       | Holds (logo degradation; render failures surface as errors, never as false success).                                                                                                                                                                                    |
| No eTIMS receipt/certification claims                 | Holds (verified by grep).                                                                                                                                                                                                                                               |

## 3. Real gaps

### 3.1 (B) Private object storage does not exist — provider decision required

Reality after the Supabase removal (`2fff426`): tenant logos are files on the
server's local disk under `uploads/`, written by `POST /api/branding/logo` and
served through the authenticated route above. Generated PDFs are never
persisted anywhere. There is no object-storage provider, no bucket, no signed
URLs, and no retention/deletion behavior for uploaded files.

Consequences the owner should weigh:

- Local disk is deployment-bound: on serverless or multi-instance hosting,
  `uploads/` is ephemeral or split-brain. Where the app actually runs decides
  whether the current design survives production at all.
- The directive requires a real provider, integration-tested, before private
  storage may be called operational. That standard is currently unmet, and task
  `#36` (storage adoption, written against the since-removed Supabase) is stale
  and needs rewriting against the chosen provider.
- Provider candidates compatible with the stack: an S3-compatible store
  (R2/MinIO/AWS) or Vercel Blob — the choice depends on the deployment target
  and is an owner decision, not an agent's.
- If PDFs later become persisted objects, the design gains signed short-lived
  URLs, expiry semantics, retention and deletion duties, and async-render
  recovery rules — none of which exist today because nothing is stored. The
  on-demand streaming model satisfies the directive's security requirements
  today with a strictly smaller surface; adopting storage should be justified
  by a need (e.g. email delivery, offline portal, very large documents), not by
  the directive's wording alone.

### 3.2 (D) Session and invitation gaps

- Session lifetime is 7 days for every user, staff and portal alike
  (`lib/auth/token.ts:4`). "Appropriate session expiry" for a customer-facing
  surface is a policy decision; today there is no portal-specific policy.
- **Invitation delivery is not implemented** — there is no email transport
  (`actions/tenant.ts:186` states this). An invitee cannot receive their
  invitation token through the system; an operator must convey it out-of-band.
  Tokens themselves are handled correctly: 32 random bytes, only the SHA-256
  hash stored, 7-day expiry, never written to audit or logs.
- Portal rate limiting is the shared login limiter (IP + email buckets); there
  is no portal-specific rule. Acceptable to document, or tighten later.

### 3.3 (E) Draft-download response leaks existence

`GET /api/portal/documents/<id>/pdf` returns **409** ("not issued yet") for a
draft, which confirms to the caller that the id exists and is a draft. The ids
are UUIDs and drafts are not enumerable from the portal list, so the leak is
narrow — but returning 404 for `status: "DRAFT"` in the portal route would not
confirm anything. This edit lands in `services/documents/*` and/or the portal
route, which are reserved (§4).

### 3.4 (E) Sharing model needs technical-lead sign-off

Per-document share flags do not exist. The model is: a granted portal link makes
**every issued, non-draft document of that one customer** visible until revoked.
The directive allows "an equally robust model approved by the technical lead" —
this is that candidate: simpler, no per-document state to forget, the audited
grant/revoke pair is the whole story. The alternative (per-document sharing)
adds a share table, share UI, and a second revocation path. Owner/lead call;
if per-document sharing is wanted it also touches reserved files.

### 3.5 (A/D) Portal UI quality debts (non-blocking)

- `/portal/page.tsx` is hardcoded English (no `useTranslations`) — same i18n
  debt class as the branding form (`#71`).
- Two dead status strings in the page's tone map (`"SENT"`, `"VOIDED"` are not
  `DocumentStatus` values — the enum has `VOID`). Cosmetic.
- The portal page is not localized and neither are the PDF's labels beyond the
  locale parameter it already accepts.

## 4. The blocker: reserved files

The concurrent agent's reservation covers `apps/web/src/server/services/documents/*.ts`
(which includes `render.ts` and `portal.ts`) and `apps/web/src/server/actions/document*.ts`.
The staff PDF route, the portal PDF route, and `getPortalState` all sit on top of
those. Mapping:

| Gap                        | Files it needs                                                                             | Reserved?                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| §3.1 object storage        | New storage adapter + env config + `logo.ts` + upload route + migrations for file metadata | Partially — `logo.ts` is reserved; the rest is new surface needing the provider decision first |
| §3.2 session/expiry policy | `lib/auth/token.ts`, login actions (unreserved)                                            | No — but a policy decision first                                                               |
| §3.3 draft 404 hardening   | `api/portal/documents/[documentId]/pdf/route.ts` (+ possibly `render.ts` error shape)      | Partially — the route is not reserved; `render.ts` is                                          |
| §3.4 sharing model         | Either nothing (keep link model) or schema + `portal.ts` + portal-access actions           | Yes, if changed                                                                                |
| §3.5 portal i18n           | `[locale]/portal/page.tsx` + messages files (unreserved)                                   | No                                                                                             |

## 5. Recommendation

1. **Do not build storage speculatively.** Get the deployment target and
   provider decision from the owner; only then implement §3.1 against that
   provider with integration tests, and retire/rewrite stale task `#36`.
2. Safe, unreserved improvements available now: §3.2 session policy (once the
   owner picks a portal expiry), §3.3 route-only 404 hardening (it does not
   touch `render.ts` if the DRAFT check happens in the route before rendering —
   verify with the reserving agent, since the route imports from the reserved
   service), §3.5 portal localization.
3. Present §3.4 to the technical lead as-is; the link model is defensible and
   audited, and changing it is the most expensive option on the board.
4. Everything here remains claim-free: private storage is NOT operational, and
   no eTIMS or certification claim appears anywhere.

Per standing rule, nothing was committed. Uncommitted on offer: this report,
the AGENT 5 gap analysis, and the two AGENT 4 record documents.
