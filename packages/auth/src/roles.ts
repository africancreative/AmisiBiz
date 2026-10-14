/**
 * Role and status unions shared by every AmisiBiz surface.
 *
 * These are declared locally — mirroring the Prisma enums of the same name —
 * so the shared packages never depend on the generated Prisma client (which
 * belongs to the server application). The unions are structurally identical
 * to the database enums, so Prisma-typed values assign directly and vice
 * versa. The database remains the source of truth; this file mirrors it.
 */

export const UserStatus = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  INVITED: "INVITED",
  SUSPENDED: "SUSPENDED",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/**
 * Platform domain — Amisi Genuine internal staff (directive names
 * platform_super_admin / platform_support). Kept strictly separate from
 * tenant roles: a platform role NEVER grants tenant business data access on
 * its own. Support staff only ever reach tenant data through an explicit,
 * expiring, audited SupportAccessGrant. A `null` platform role (the default)
 * means "no platform privileges".
 */
export const PlatformRole = {
  /** platform_super_admin — Amisi Genuine internal administration. */
  SUPER_ADMIN: "SUPER_ADMIN",
  /** platform_support — customer support; no permissions without a grant. */
  SUPPORT: "SUPPORT",
} as const;
export type PlatformRole = (typeof PlatformRole)[keyof typeof PlatformRole];

/**
 * Tenant domain — roles within a customer's business workspace (the 9-role
 * model of the Phase 1 directive: tenant_owner, tenant_admin, sales, finance,
 * operations, viewer, customer_portal_user).
 */
export const TenantRole = {
  /** tenant_owner — owns the workspace; full control. */
  TENANT_OWNER: "TENANT_OWNER",
  /** tenant_admin — routine operations incl. guarded member management. */
  TENANT_ADMIN: "TENANT_ADMIN",
  /** sales — contacts, catalogue and quotations. */
  SALES: "SALES",
  /** finance — invoices, payments and financial exports. */
  FINANCE: "FINANCE",
  /** operations — catalogue operations and delivery notes. */
  OPERATIONS: "OPERATIONS",
  /** viewer — read-only access to explicitly permitted information. */
  VIEWER: "VIEWER",
  /** customer_portal_user — portal only; never internal records. */
  CUSTOMER_PORTAL_USER: "CUSTOMER_PORTAL_USER",
} as const;
export type TenantRole = (typeof TenantRole)[keyof typeof TenantRole];

/** Every platform role key (used by catalog/parity checks). */
export const PLATFORM_ROLE_KEYS = ["SUPER_ADMIN", "SUPPORT"] as const;

/** Every tenant role key, least-to-most privileged order except as marked. */
export const TENANT_ROLE_KEYS = [
  "CUSTOMER_PORTAL_USER",
  "VIEWER",
  "OPERATIONS",
  "FINANCE",
  "SALES",
  "TENANT_ADMIN",
  "TENANT_OWNER",
] as const;
