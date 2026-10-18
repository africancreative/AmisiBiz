# AGENT 01 — Platform Foundation & Security Report

**Date:** 2026-10-18 · **Baseline commit:** `d79c520` + in-flight tree · **Scope:** directive sections A–F · **Out of scope:** marketing/AI modules (not started, per directive).

**Attribution note:** while this audit ran, a peer agent delivered sections A and D in the same tree (middleware `x-tenant-subdomain` set/strip hardening, `src/lib/security/headers.ts` + `next.config.mjs` `headers()`, and `tests/agent01-security-hardening.test.ts`). The owner's password-recovery and Vercel-Blob logo work is likewise in-flight and was not modified. This report verifies that work by execution rather than duplicating it.

## Per-section evidence

**A. Tenant identity and routing — VERIFIED.** Middleware is the sole Host reader; `resolveRequestHost` honors `X-Forwarded-Host` only under `TRUST_PROXY="true"`; reserved subdomains 404; the verified subdomain is propagated server-side via `x-tenant-subdomain` and **stripped** when absent, so clients cannot select a tenant (acceptance criterion "tenant identity not trusted from client input" holds). Custom domains resolve through `TenantDomain` (`lib/tenancy/host.ts`). Tests: `middleware-host.test.ts` + 5 hostname-manipulation cases in the new suite.

**B. Authentication and RBAC — VERIFIED.** bcrypt(12), HMAC sessions, `sessionVersion` revocation, recovery flow (in flight, 19 peer tests + owner suite green), rate limiting. Server-side `authorizeTenant`/`authorizePlatform` on every action; permission-denied paths audited (3 forged-tenantId tests). The 42→57 DB catalog gap (H1) is **closed offline**: migration `20261030000000_h1_permission_catalog_reseed` brings any DB to 57 keys / 122 matrix rows idempotently; harness now **33/33** on a throwaway cluster. RBAC matrix: `packages/auth/src/permissions.ts` (authoritative) mirrored by the migration; SUPPORT deliberately holds no direct grants.

**C. Database security — VERIFIED.** RLS live, scoped contexts (`runInScope`), least-privilege `amisibiz_app` grants, cross-tenant isolation harness 33/33. Two flagged dependencies: runtime RLS binding needs `APP_DATABASE_URL` + `STRICT_APP_ROLE` (owner env), and live application of migration 23 needs the owner's explicit go-ahead.

**D. Audit and operational security — MOSTLY CLOSED.** Audit trails (incl. denial audits), secret hygiene (bundle scan clean, 248 files), Zod validation, cookie flags (HttpOnly/Secure/Lax), dependency audit at accepted baseline, redacted logging. Headers now in force (nosniff, DENY framing, referrer policy, HSTS, DNS-prefetch off, permissions policy). **CSP intentionally deferred** — App Router nonce inline scripts make a static CSP either breaking or unsafe-inline; needs middleware-generated CSP (owner decision). **Retention/deletion:** suspension never deletes data; no deletion runbook exists yet — documented, needs owner-approved procedure. CSRF: server actions are same-origin + session-cookie gated (Lax); no separate token layer — noted for the CSP decision window.

**E. Business lifecycle controls — VERIFIED.** Register/invite/plan-assign/activate/suspend with status history and audit; suspension write-denial enforced by `app_tenant_accepts_writes()` and authorization gates; reads and portal downloads preserved by owner decision; 4 suspension tests green (existing sessions continue read-only by design). Scheduled jobs/webhooks do not exist yet — revocation semantics must be specified when those subsystems land (recorded in the gap list).

**F. Currency, taxation, documents — VERIFIED (reserved surfaces untouched).** KES default with explicit ISO codes; fixed-decimal math; issuance snapshots freeze price/tax values (`Document.snapshot`). Private PDF storage remains the owner's pending decision (logos have a Blob path in flight; documents still filesystem fallback, downloads authorization-checked — short-lived signed URLs are part of the provider decision). A5 behavioral closures (#75) stay sequenced behind the peer all-clear; no contact/item/document code or tests were added or revalidated here.

## Test and gate results (executed, this tree)

- `tests/agent01-security-hardening.test.ts` — **19/19**; RLS harness — **33/33** (fresh 23-migration chain, throwaway cluster); `pnpm test:run` — **577 passed / 33 skipped** (25 files); `pnpm type-check` — 10/10; `pnpm build` — green with the new headers wiring (fresh, 61s); `pnpm check:bundles` — clean; `pnpm audit --prod` — exit 0 at accepted baseline. `pnpm lint` — verified green earlier this session (pre-H1); re-run recommended after owner commits in-flight work. `format:check` fails only on 4 owner in-flight files (left untouched).

## Acceptance criteria verdict

Met: unauthorized access denied; cross-tenant isolation proven; client-tenant identity impossible; platform-admin actions restricted + audited; existing features functional (full suite green). Remaining baseline caveat documented: `format:check` on owner in-flight files.

## Actions for the owner

1. Go-ahead to apply migration 23 to live Neon (additive, idempotent; live is at 42 keys). 2. Raise CI's hardcoded `Permission` count 42→57 (`.github/workflows/ci.yml` ~line 196) in the same window. 3. CSP strategy decision. 4. Tenant data-retention/deletion policy. 5. Document/PDF private-storage provider confirmation. 6. Production env items from the AGENT 00 baseline report (AUTH_SECRET, APP_DATABASE_URL/STRICT_APP_ROLE, rotation).
