-- Migration: Phase 07 rollback
--
-- Removes the platform administration permission catalogue entries added by
-- the up migration. Uses ON CONFLICT DO NOTHING for idempotency.
--
-- 1. Remove RolePermission entries for the new platform permissions.
DELETE FROM "RolePermission"
WHERE ("roleKey" = 'SUPER_ADMIN'::text OR "roleKey" = 'SUPPORT'::text)
  AND "permissionId" IN (
    SELECT id FROM "Permission" WHERE "domain" = 'platform'
      AND "key" IN (
        'platform.dashboard.read', 'tenants.read', 'tenants.create',
        'tenants.activate', 'tenants.suspend', 'tenants.reactivate',
        'subscriptions.read', 'subscriptions.manage',
        'branding.read', 'branding.manage',
        'platform_users.read', 'platform_users.manage',
        'audit_logs.read', 'security_events.read', 'support.access_request'
  );

-- 2. Remove the new platform permissions from the Permission table.
DELETE FROM "Permission"
WHERE "domain" = 'platform'
  AND "key" IN (
    'platform.dashboard.read', 'tenants.read', 'tenants.create',
    'tenants.activate', 'tenants.suspend', 'tenants.reactivate',
    'subscriptions.read', 'subscriptions.manage',
    'branding.read', 'branding.manage',
    'platform_users.read', 'platform_users.manage',
    'audit_logs.read', 'security_events.read', 'support.access_request'
  );