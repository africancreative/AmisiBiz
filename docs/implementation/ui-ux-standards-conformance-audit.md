# UI/UX Standards Conformance Audit

Date: 2026-10-18
Scope: read-only inspection of all 25 routes under `apps/web/src/app`, the
layout/shell components, navigation, forms, the error boundary, and the
client-side halves of the security-sensitive flows (invitation, portal access,
logo upload, document lifecycle). No UI file was modified.

The directive's shared standards were used as the rubric. Result: **the UI
substantially conforms — the deviations found are consistency and honesty
defects, none of them security-class.** Every denial, hidden control, or
write-gate observed is backed by a server-side authorization path already
verified in the AGENT 7 audit.

---

## 1. What conforms (evidence)

| Standard                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side enforcement behind every UI gate          | Workspace nav entries are filtered by the same permission the page guard checks (`app/[locale]/app/layout.tsx:59–74`); the document detail client states "every action is authorized again where it is executed" (`document-detail-client.tsx:385–386`); server actions all run `authorizeTenant`/`authorizePlatform` (AGENT 7 §4)                                                                                                                  |
| Separation of platform / business / customer surfaces | Three shells with distinct chrome: `WorkspaceShell` (`/app`), `AdminShell` (`/admin`), portal (`/portal`); role-based forwarding at login and from `/dashboard` (`middleware.ts:129–135`, `dashboard/page.tsx:21–43`); workspace nav contains no administrative links at all                                                                                                                                                                        |
| Suspended / inactive states are visible               | Suspended workspace gets an amber read-only banner with `role="status"`, explicitly documented as "an explanation, not the enforcement" (`app/layout.tsx:222–238`); PENDING is a distinct screen from no-access (`app/layout.tsx:202–214`); admin console surfaces suspended counts and badges (`admin/page.tsx:69`, `tenant-status-badge.tsx:8`); portal settings shows a suspended warning instead of fetching (`settings/portal/page.tsx:51–55`) |
| No dead navigation                                    | Permission-filtered nav so no link leads to "access denied" (`app/layout.tsx:59–74`, audit link hidden per `150–160`); zero `href="#"` in the tree; dashboard quick links all target real routes                                                                                                                                                                                                                                                    |
| No fake metrics                                       | Dashboard is a Server Component fed entirely by `getDashboardOverviewAction` (tenant-scoped, server-computed); zero-data renders `EmptyState`, not a zero (`dashboard-overview.tsx:25–32, 199–205`); consistent status→tone badge map (`dashboard-overview.tsx:50–69`)                                                                                                                                                                              |
| Confirmation + warnings for irreversible actions      | Voiding is a dedicated section with a reason dialog and an explicit consequence statement — "Keeps the row, its number and its history" (`document-detail-client.tsx:1192–1200`); post-void metadata and reason are displayed afterwards (`699–746`); `ConfirmDialog` guards portal-access grant/revoke (`portal-access-client.tsx`) and customer-agreement changes (`contact-items-client.tsx`)                                                    |
| Issued records distinguished from drafts              | Drafts render "draft" where a number would be and cannot be downloaded (`canDownload && !isDraft && hasSnapshot`, `document-detail-client.tsx:440`); dashboard lists show `number ?? draft` (`dashboard-overview.tsx:215, 277`)                                                                                                                                                                                                                     |
| No secret or token display                            | The invitation form reports generic success and never renders the raw token (`invite-member-form.tsx:85–87`); only the SHA-256 hash is stored (`tenant.ts:165–171`)                                                                                                                                                                                                                                                                                 |
| Error handling without information disclosure         | The locale error boundary deliberately never renders `error.message`, logs a redacted report, correlates via the Next.js digest (`app/[locale]/error.tsx:15–36`)                                                                                                                                                                                                                                                                                    |
| Validated uploads                                     | Client validates size, dimensions and MIME against the same shared constants the server contract uses (`branding-form.tsx:194–213, 296–308`); the serving route re-checks auth, path shape, and content type (AGENT 7 §4)                                                                                                                                                                                                                           |
| Consistent financial calculation                      | The document editor preview calls the same `resolveCatalogueLineFacts` the server's write transaction uses, and "the server overwrites all of it on submit: a price typed into this form has no authority over a catalogue item" (`new-document-client.tsx:148–157`)                                                                                                                                                                                |
| Clear loading / empty / success / error states        | `EmptyState` in all six list/detail clients; forms disable on pending and print success/error lines (`invite-member-form.tsx:80–90`); route-level `loading.tsx` at the locale root                                                                                                                                                                                                                                                                  |
| Accessibility basics                                  | `aria-label="Primary"` nav with `aria-current` and focus-visible rings (`nav-links.tsx:28–44`), labelled inputs (`invite-member-form.tsx:50–61`), `role="status"` banners, `tabular-nums` on all money figures; responsive sidebar→drawer shell (`workspace-shell.tsx`)                                                                                                                                                                             |

## 2. Violations and gaps

- **V1 — Orphaned duplicate platform console (`/platform`).**
  `/platform/page.tsx` renders `TenantLifecycleActions` (the same
  activate/suspend controls as `/admin/tenants/[id]`, which renders the full
  panel set) and `/platform/audit` duplicates audit viewing — but nothing
  links to `/platform`: login and the dashboard router both forward platform
  admins to `/admin` (`middleware.ts:132`, `login-form.tsx:44`). It is also
  only partially localized (hardcoded English denial at
  `platform/page.tsx:38`). Two mutation surfaces for the same lifecycle
  operations is exactly the inconsistency the standards forbid. Server-side
  authorization is intact on both, so this is a consistency defect, not a
  security one. **Remediation:** retire `/platform/*` in favor of the
  `/admin` console (or fold its audit view into `/admin`); needs an owner
  nod since it deletes routes.
- **V2 — Workspace invitation reports success for an undeliverable action.**
  `inviteMemberAction` persists the Invitation row but "invitation delivery
  is not implemented (no email transport)" (`tenant.ts:186`), and the form
  prints a plain success message (`invite-member-form.tsx:85–87`). The
  operator is left believing the invitee was notified. This collides with
  "every visible action must either work or be explicitly identified as
  unavailable." **Remediation options:** implement delivery, or state the
  limitation in the success copy — which then forces the raw-token-display
  decision. Belongs with the invitation-delivery decision already open from
  AGENT 6 §3.2.
- **V3 — Partial i18n in user-facing copy.** The document detail client
  imports `useTranslations` but renders many hardcoded English strings
  ("Void this invoice", "Void reason", "Voided", "Documents", "Preview",
  section headers — `document-detail-client.tsx:426–746, 1192–1200`); the
  branding form carries ~34 (already tracked as task #71); the portal pages
  are English-only with two dead status strings (AGENT 6 §3.5); the
  dashboard account card renders the raw `tenant.status` enum
  (`dashboard-overview.tsx:315`). The product ships en/fr/sw, so these are
  functional gaps, not polish. Document-detail localization is new here;
  note the caveat that its sibling server files are under the peer's
  reservation and `messages/*/index.json` is shared — additive edits only.
- **V4 — Dead code that invites misuse.** `module-placeholder.tsx` is
  defined but rendered nowhere — no placeholder UI exists (good), but the
  component should be deleted so a future "coming soon" screen can't creep
  back in. Trivial.
- **V5 — Single error/loading boundary for 25 routes.** `loading.tsx`/
  `error.tsx` exist only at the locale root. A render failure anywhere falls
  back to the same full-area error card. Acceptable, but per-section
  boundaries on the two densest screens (document detail, tenant detail)
  would localize failures. Low priority.

## 3. Classification

| Class                             | Items                                                                               | Blocking?                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Fix now (no reservation conflict) | V4 dead component; V5 boundaries; V2 copy clarification (stop implying delivery)    | No                                                                 |
| Fix after coordination            | V3 i18n (document detail borders the reserved surface; message catalogs are shared) | Peer all-clear for document-adjacent files; additive catalog edits |
| Owner decision                    | V1 retire `/platform`; V2 full invitation delivery                                  | Yes                                                                |

## 4. Verdict

No standard is violated in its security dimension: authorization is
server-side everywhere observed, no admin controls leak into tenant or portal
surfaces, no secret or token is displayed, confidential documents have no
public URL, and uploads are validated on both sides. The production-quality
violations that do exist are an orphaned duplicate console (V1), a success
message that overstates what just happened (V2), and incomplete localization
(V3). None of these changes the AGENT 7 release verdict; they join its
known-limitations list.

## 5. Verification notes

Findings come from: glob of all `page.tsx`/`loading.tsx`/`error.tsx` under
`apps/web/src/app`; greps for `href="#"`, `coming soon|not implemented|TODO`,
confirm-dialog usage, `platformRole` UI checks, `SUSPENDED` UI handling, and
logo-upload validation; full reads of `nav-links.tsx`, `workspace-shell.tsx`,
`app/[locale]/app/layout.tsx`, `dashboard-overview.tsx`,
`invite-member-form.tsx`, `app/[locale]/error.tsx`, `middleware.ts`, and
targeted sections of `document-detail-client.tsx`, `new-document-client.tsx`,
`branding-form.tsx`, `platform/page.tsx`, and both admin pages. No running
browser session was used — behavioral rendering (visual layout, actual
responsive breakpoints) was not exercised and is not claimed.
