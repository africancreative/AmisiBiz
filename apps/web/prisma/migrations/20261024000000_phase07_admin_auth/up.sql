-- Migration: Phase 07 – Admin authentication and RBAC foundation
--
-- Adds the platform administration permission catalogue and maps them to
-- platform roles (SUPER_ADMIN, SUPPORT). These permissions power the
-- AmisiBiz Control Centre: dashboard, tenant management, subscriptions,
-- branding, platform users, audit logs, security events, and support access.
--
-- Permissions added (domain = "platform"):
--   platform.dashboard.read, tenants.read/create/activate/suspend/reactivate,
--   subscriptions.read/manage, branding.read/manage,
--   platform_users.read/manage, audit_logs.read, security_events.read,
--   support.access_request.
--
-- RolePermission entries map these to SUPER_ADMIN (all platform perms) and
-- SUPPORT (read-only subset via SUPPORT_TENANT_PERMISSIONS).
--
-- The Permission table is idempotent: INSERT ... ON CONFLICT DO NOTHING.
-- RolePermission entries use ON CONFLICT DO NOTHING as well.

-- 1. Insert new platform permissions into the Permission table
INSERT INTO "Permission" ("key", "domain", "area", "description")
VALUES
  ('platform.dashboard.read', 'platform', 'dashboard', 'View the platform administration dashboard'),
  ('tenants.read', 'tenant', 'tenants', 'View tenant list and details'),
  ('tenants.create', 'tenant', 'tenants', 'Provision new tenants'),
  ('tenants.activate', 'tenant', 'tenants', 'Activate (or reactivate) a tenant'),
  ('tenants.suspend', 'tenant', 'tenants', 'Suspend a tenant'),
  ('tenants.reactivate', 'tenant', 'tenants', 'Reactivate a suspended tenant'),
  ('subscriptions.read', 'tenant', 'subscriptions', 'View subscription plans and tenant subscription status'),
  ('subscriptions.manage', 'tenant', 'subscriptions', 'Assign or modify subscription plans for tenants'),
  ('branding.read', 'tenant', 'branding', 'View tenant branding configuration'),
  ('branding.manage', 'tenant', 'branding', 'Update tenant branding and logo'),
  ('platform_users.read', 'platform', 'platform_users', 'View platform administrator accounts and roles'),
  ('platform_users.manage', 'platform', 'platform_users', 'Create, update and revoke platform administrator accounts'),
  ('audit_logs.read', 'platform', 'audit_logs', 'View the platform administration audit trail'),
  ('security_events.read', 'platform', 'security_events', 'View security-relevant events and access control changes'),
  ('support.access_request', 'platform', 'support', 'Submit and track support access grant requests')
ON CONFLICT ("key") DO NOTHING;

-- 2. Map permissions to platform roles.
-- SUPER_ADMIN receives every platform permission.
-- SUPPORT receives only the read-only subset that the support grant confers.
INSERT INTO "RolePermission" ("roleKey", "domain", "permissionId")
SELECT 'SUPER_ADMIN'::text, d.domain, p.id
FROM "Permission" p
WHERE p.domain = 'platform'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

INSERT INTO "RolePermission" ("roleKey", "domain", "permissionId")
SELECT 'SUPPORT'::text, d.domain, p.id
FROM "Permission" p
WHERE p.domain = 'platform'
  AND p.key IN (
    'platform.dashboard.read',
    'tenants.read',
    'branding.read',
    'audit_logs.read',
    'security_events.read',
    'support.access_request'
  )
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;