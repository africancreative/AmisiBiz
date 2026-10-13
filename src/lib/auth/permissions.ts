import type { PlatformRole, TenantRole } from "@prisma/client";

/**
 * Central permission definitions for AmisiBiz.
 *
 * This is the single source of truth for authorization. Permissions are
 * explicit strings grouped into two disjoint security domains:
 *
 *   - `platform.*`  → Amisi Genuine internal staff (PlatformRole).
 *   - everything else → tenant business data (TenantRole).
 *
 * A tenant role must NEVER be granted a `platform.*` permission and a platform
 * role must NEVER be granted a tenant permission. Roles confer only the
 * permissions listed here — never authority implied by their name.
 */
export const PERMISSIONS = {
  // ── Platform domain ────────────────────────────────────────────
  PLATFORM_TENANTS_READ: "platform.tenants.read",
  PLATFORM_TENANTS_CREATE: "platform.tenants.create",
  PLATFORM_TENANTS_ACTIVATE: "platform.tenants.activate",
  PLATFORM_TENANTS_SUSPEND: "platform.tenants.suspend",

  // ── Business settings ──────────────────────────────────────────
  BUSINESS_SETTINGS_READ: "business.settings.read",
  BUSINESS_SETTINGS_UPDATE: "business.settings.update",

  // ── Business membership ────────────────────────────────────────
  BUSINESS_MEMBERS_READ: "business.members.read",
  BUSINESS_MEMBERS_MANAGE: "business.members.manage",

  // ── Contacts ───────────────────────────────────────────────────
  CONTACTS_READ: "contacts.read",
  CONTACTS_CREATE: "contacts.create",
  CONTACTS_UPDATE: "contacts.update",
  CONTACTS_DELETE: "contacts.delete",

  // ── Items (catalogue) ──────────────────────────────────────────
  ITEMS_READ: "items.read",
  ITEMS_CREATE: "items.create",
  ITEMS_UPDATE: "items.update",
  ITEMS_DELETE: "items.delete",

  // ── Documents ──────────────────────────────────────────────────
  DOCUMENTS_READ: "documents.read",
  DOCUMENTS_CREATE: "documents.create",
  DOCUMENTS_UPDATE_DRAFT: "documents.update_draft",
  DOCUMENTS_ISSUE: "documents.issue",
  DOCUMENTS_VOID: "documents.void",
  DOCUMENTS_DOWNLOAD: "documents.download",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] =
  Object.values(PERMISSIONS);

const PLATFORM_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.PLATFORM_TENANTS_READ,
  PERMISSIONS.PLATFORM_TENANTS_CREATE,
  PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
  PERMISSIONS.PLATFORM_TENANTS_SUSPEND,
];

/** Tenant-domain permissions (everything that is not `platform.*`). */
export const TENANT_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) => !PLATFORM_PERMISSIONS.includes(permission),
);

// ── Document permission bundles (shared across roles) ──────────────

const DOCUMENT_READ_DOWNLOAD: readonly Permission[] = [
  PERMISSIONS.DOCUMENTS_READ,
  PERMISSIONS.DOCUMENTS_DOWNLOAD,
];

const DOCUMENT_EDITOR: readonly Permission[] = [
  ...DOCUMENT_READ_DOWNLOAD,
  PERMISSIONS.DOCUMENTS_CREATE,
  PERMISSIONS.DOCUMENTS_UPDATE_DRAFT,
  PERMISSIONS.DOCUMENTS_ISSUE,
];

/**
 * Documented role → permission policy (tenant domain).
 *
 * BUSINESS_OWNER  : full control of the workspace, including members.
 * BUSINESS_ADMIN  : all routine operations; may NOT manage members
 *                   (only the owner manages who belongs to the workspace).
 * DOCUMENT_MANAGER: read the business context and manage documents end-to-end.
 * SALES_STAFF     : manage contacts and catalogue items, issue sales documents;
 *                   may NOT delete records or void documents.
 * VIEWER          : read-only access to explicitly permitted information.
 */
export const TENANT_ROLE_PERMISSIONS: Record<
  TenantRole,
  readonly Permission[]
> = {
  BUSINESS_OWNER: [
    PERMISSIONS.BUSINESS_SETTINGS_READ,
    PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    PERMISSIONS.BUSINESS_MEMBERS_READ,
    PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.CONTACTS_CREATE,
    PERMISSIONS.CONTACTS_UPDATE,
    PERMISSIONS.CONTACTS_DELETE,
    PERMISSIONS.ITEMS_READ,
    PERMISSIONS.ITEMS_CREATE,
    PERMISSIONS.ITEMS_UPDATE,
    PERMISSIONS.ITEMS_DELETE,
    PERMISSIONS.DOCUMENTS_READ,
    PERMISSIONS.DOCUMENTS_CREATE,
    PERMISSIONS.DOCUMENTS_UPDATE_DRAFT,
    PERMISSIONS.DOCUMENTS_ISSUE,
    PERMISSIONS.DOCUMENTS_VOID,
    PERMISSIONS.DOCUMENTS_DOWNLOAD,
  ],
  BUSINESS_ADMIN: [
    PERMISSIONS.BUSINESS_SETTINGS_READ,
    PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    PERMISSIONS.BUSINESS_MEMBERS_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.CONTACTS_CREATE,
    PERMISSIONS.CONTACTS_UPDATE,
    PERMISSIONS.CONTACTS_DELETE,
    PERMISSIONS.ITEMS_READ,
    PERMISSIONS.ITEMS_CREATE,
    PERMISSIONS.ITEMS_UPDATE,
    PERMISSIONS.ITEMS_DELETE,
    PERMISSIONS.DOCUMENTS_READ,
    PERMISSIONS.DOCUMENTS_CREATE,
    PERMISSIONS.DOCUMENTS_UPDATE_DRAFT,
    PERMISSIONS.DOCUMENTS_ISSUE,
    PERMISSIONS.DOCUMENTS_VOID,
    PERMISSIONS.DOCUMENTS_DOWNLOAD,
  ],
  DOCUMENT_MANAGER: [
    PERMISSIONS.BUSINESS_SETTINGS_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.ITEMS_READ,
    PERMISSIONS.DOCUMENTS_READ,
    PERMISSIONS.DOCUMENTS_CREATE,
    PERMISSIONS.DOCUMENTS_UPDATE_DRAFT,
    PERMISSIONS.DOCUMENTS_ISSUE,
    PERMISSIONS.DOCUMENTS_VOID,
    PERMISSIONS.DOCUMENTS_DOWNLOAD,
  ],
  SALES_STAFF: [
    PERMISSIONS.BUSINESS_SETTINGS_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.CONTACTS_CREATE,
    PERMISSIONS.CONTACTS_UPDATE,
    PERMISSIONS.ITEMS_READ,
    PERMISSIONS.ITEMS_CREATE,
    PERMISSIONS.ITEMS_UPDATE,
    ...DOCUMENT_EDITOR,
  ],
  VIEWER: [
    PERMISSIONS.BUSINESS_SETTINGS_READ,
    PERMISSIONS.BUSINESS_MEMBERS_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.ITEMS_READ,
    ...DOCUMENT_READ_DOWNLOAD,
  ],
};

/**
 * Documented role → permission policy (platform domain).
 *
 * PLATFORM_SUPPORT is intentionally granted no permissions. It is disabled
 * until a defined support permission set exists; any check against it denies.
 */
export const PLATFORM_ROLE_PERMISSIONS: Record<
  PlatformRole,
  readonly Permission[]
> = {
  USER: [],
  PLATFORM_ADMIN: [
    PERMISSIONS.PLATFORM_TENANTS_READ,
    PERMISSIONS.PLATFORM_TENANTS_CREATE,
    PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
    PERMISSIONS.PLATFORM_TENANTS_SUSPEND,
  ],
  PLATFORM_SUPPORT: [],
};

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/** Deny-by-default: an unknown/absent role or permission returns false. */
export function tenantRoleHasPermission(
  role: TenantRole | null | undefined,
  permission: Permission,
): boolean {
  if (!role) return false;
  return TENANT_ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Deny-by-default: an unknown/absent role or permission returns false. */
export function platformRoleHasPermission(
  role: PlatformRole | null | undefined,
  permission: Permission,
): boolean {
  if (!role) return false;
  return PLATFORM_ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsForTenantRole(
  role: TenantRole,
): readonly Permission[] {
  return TENANT_ROLE_PERMISSIONS[role];
}

export function permissionsForPlatformRole(
  role: PlatformRole,
): readonly Permission[] {
  return PLATFORM_ROLE_PERMISSIONS[role];
}

/** True when the permission belongs to the platform domain. */
export function isPlatformPermission(permission: Permission): boolean {
  return permission.startsWith("platform.");
}
