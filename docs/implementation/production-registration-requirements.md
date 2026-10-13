# Production Registration Requirements

## Overview
This document specifies the requirements that must be met before enabling public user registration in production.

## Required Infrastructure

### 1. Email Transport (MANDATORY)
**Status: NOT IMPLEMENTED**

The `lib/email/index.ts` currently has no transport implementation. Before enabling registration:

- **Choose a provider**: SMTP (Postmark, SendGrid, Mailgun, SES) or transactional API
- **Configure environment variables**:
  ```
  EMAIL_PROVIDER="smtp"
  SMTP_HOST="smtp.example.com"
  SMTP_PORT="587"
  SMTP_USER="noreply@amisibiz.com"
  SMTP_PASSWORD="your-smtp-password"
  EMAIL_FROM="AmisiBiz <noreply@amisibiz.com>"
  ```
- **Implement transport** in `src/lib/email/index.ts`:
  - SMTP: use `nodemailer`
  - API: use provider SDK
- **Test delivery** to major providers (Gmail, Outlook, Yahoo)
- **Configure SPF/DKIM/DMARC** for the sending domain

### 2. Email Verification Enforcement (MANDATORY)
**Status: CODE READY, REQUIRES EMAIL TRANSPORT**

- Set `REQUIRE_EMAIL_VERIFICATION="true"` in production
- This enforces email verification at sign-in (see `lib/auth/config.ts:22`)
- Without verification, users cannot sign in

### 3. Rate Limiting - Distributed Store (MANDATORY)
**Status: IMPLEMENTED - REQUIRES CONFIGURATION**

The rate limiter supports Redis/Upstash. Configure one of:

**Upstash (recommended for serverless):**
```
UPSTASH_REDIS_REST_URL="https://your-instance.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-token"
```

**Standard Redis:**
```
REDIS_URL="redis://user:pass@host:port"
```
- Install `ioredis` (already added)
- Test under load to verify limits hold across instances

### 4. Database Security (MANDATORY)
**Status: MIGRATION READY - REQUIRES DEPLOYMENT**

Apply the following to production database:

1. **Run RLS migration**: `prisma/migrations/20261013000001_rls_policies_and_constraints`
2. **Create app role**: Execute `prisma/scripts/setup-app-role.sql`
   - Generate strong password: `openssl rand -base64 32`
   - Update `DATABASE_URL` to use `amisibiz_app` role
3. **Apply RLS policies**: Execute `prisma/scripts/rls-policies.sql`
4. **Verify**:
   - RLS enabled on all protected tables
   - App role has NO `BYPASSRLS`
   - Policies enforce tenant isolation

### 5. Least-Privileged Database Role (MANDATORY)
**Status: SCRIPT READY**

- Do NOT use `postgres` superuser in production
- Use `amisibiz_app` role created by setup script
- Verify role cannot:
  - `CREATE DATABASE`, `CREATE ROLE`
  - `TRUNCATE`, `DROP`, `ALTER` schema objects
  - Bypass RLS

### 6. Secure Session Configuration
**Status: IMPLEMENTED**

- `AUTH_SECRET` ≥ 32 bytes (generate: `openssl rand -base64 32`)
- Cookies: HttpOnly, Secure, SameSite=Lax (Auth.js defaults)
- Session: 8h max age, 15m rotation
- Session revocation on password change/role change

### 7. Hostname Routing Configuration
**Status: CODE READY - REQUIRES CONFIGURATION**

Set base domain for tenant subdomains:
```
APP_BASE_DOMAIN="amisigenuine.com"
NEXT_PUBLIC_APP_BASE_DOMAIN="amisigenuine.com"
```
- Configure DNS wildcard: `*.amisigenuine.com → Vercel/load balancer`
- Set `TRUST_PROXY="true"` behind known proxy/load balancer

### 8. Audit Log Protection
**Status: IMPLEMENTED**

- Audit logs are append-only (no DELETE/UPDATE paths exposed)
- Metadata sanitized of secrets (passwords, tokens)
- Platform admin access controlled via RLS

### 9. Error Monitoring & Alerting
**Status: NOT CONFIGURED**

Before production:
- Configure error tracking (Sentry, Datadog, etc.)
- Alert on:
  - Repeated auth failures (brute force)
  - Authorization denials (potential attacks)
  - Rate limit saturation
  - Database errors

### 10. Backup & Disaster Recovery
**Status: NOT CONFIGURED**

- Automated daily PostgreSQL backups (Supabase/Vercel Postgres provides this)
- Point-in-time recovery tested
- RLS policies included in backup

## Deployment Checklist

| Item | Required | Status |
|------|----------|--------|
| Email transport implemented | ✅ | ❌ |
| `REQUIRE_EMAIL_VERIFICATION=true` | ✅ | ⏳ |
| Upstash/Redis configured for rate limiting | ✅ | ⏳ |
| RLS migration applied | ✅ | ⏳ |
| App role created with strong password | ✅ | ⏳ |
| `DATABASE_URL` uses app role | ✅ | ⏳ |
| RLS policies active | ✅ | ⏳ |
| `AUTH_SECRET` ≥ 32 bytes | ✅ | ⏳ |
| `APP_BASE_DOMAIN` configured | ✅ | ⏳ |
| DNS wildcard configured | ✅ | ⏳ |
| Error tracking configured | ✅ | ⏳ |
| Backup/DR verified | ✅ | ⏳ |

## Enabling Registration

Once ALL ✅ items are complete:

1. Deploy with all environment variables set
2. Run migrations: `prisma migrate deploy`
3. Verify health endpoint: `GET /api/health`
4. Test registration flow end-to-end:
   - Register → receive email → verify → sign in → create tenant
5. Monitor logs for 24h before announcing

## Security Notes

- **Never** enable registration without email transport
- **Never** use superuser database role in production
- **Never** disable RLS or grant `BYPASSRLS`
- **Always** audit denied authorization attempts
- **Rotate** `AUTH_SECRET` annually
- **Monitor** for credential stuffing attacks