import type { PlatformRole, TenantRole } from "./roles";

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
 *
 * The catalogue is mirrored into the database (`Permission` /
 * `RolePermission` tables) by a migration, and an integration test asserts the
 * two stay identical in both directions.
 */
export const PERMISSIONS = {
  // ── Platform domain ────────────────────────────────────────────
  DASHBOARD_READ: "platform.dashboard.read",
  TENANTS_READ: "tenants.read",
  TENANTS_CREATE: "tenants.create",
  TENANTS_ACTIVATE: "tenants.activate",
  TENANTS_SUSPEND: "tenants.suspend",
  TENANTS_REACTIVATE: "tenants.reactivate",
  SUBSCRIPTIONS_READ: "subscriptions.read",
  SUBSCRIPTIONS_MANAGE: "subscriptions.manage",
  BRANDING_READ: "branding.read",
  BRANDING_MANAGE: "branding.manage",
  PLATFORM_USERS_READ: "platform_users.read",
  PLATFORM_USERS_MANAGE: "platform_users.manage",
  AUDIT_LOGS_READ: "audit_logs.read",
  SECURITY_EVENTS_READ: "security_events.read",
  SUPPORT_ACCESS_REQUEST: "support.access_request",
  // Existing permissions (preserved for backward compatibility)
  PLATFORM_TENANTS_READ: "platform.tenants.read",
  PLATFORM_TENANTS_CREATE: "platform.tenants.create",
  PLATFORM_TENANTS_UPDATE: "platform.tenants.update",
  PLATFORM_TENANTS_ACTIVATE: "platform.tenants.activate",
  PLATFORM_TENANTS_SUSPEND: "platform.tenants.suspend",
  PLATFORM_TENANTS_PLAN_ASSIGN: "platform.tenants.plan.assign",
  PLATFORM_TENANTS_DOMAIN_MANAGE: "platform.tenants.domain.manage",
  PLATFORM_AUDIT_READ: "platform.audit.read",
  PLATFORM_SUPPORT_GRANT: "platform.support.grant",

  // ── Business settings / branding ───────────────────────────────
  BUSINESS_SETTINGS_READ: "business.settings.read",
  BUSINESS_SETTINGS_UPDATE: "business.settings.update",
  BUSINESS_BRANDING_READ: "business.branding.read",
  BUSINESS_BRANDING_UPDATE: "business.branding.update",

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

  // ── Documents (generic read) ───────────────────────────────────
  DOCUMENTS_READ: "documents.read",
  DOCUMENTS_DOWNLOAD: "documents.download",

  // ── Quotations ─────────────────────────────────────────────────
  QUOTATIONS_CREATE: "documents.quotation.create",
  QUOTATIONS_UPDATE_DRAFT: "documents.quotation.update_draft",
  QUOTATIONS_ISSUE: "documents.quotation.issue",
  QUOTATIONS_VOID: "documents.quotation.void",

  // ── Invoices ───────────────────────────────────────────────────
  INVOICES_CREATE: "documents.invoice.create",
  INVOICES_UPDATE_DRAFT: "documents.invoice.update_draft",
  INVOICES_ISSUE: "documents.invoice.issue",
  INVOICES_VOID: "documents.invoice.void",

  // ── Delivery notes ─────────────────────────────────────────────
  DELIVERY_NOTES_CREATE: "documents.delivery_note.create",
  DELIVERY_NOTES_UPDATE_DRAFT: "documents.delivery_note.update_draft",
  DELIVERY_NOTES_ISSUE: "documents.delivery_note.issue",
  DELIVERY_NOTES_VOID: "documents.delivery_note.void",

  // ── Orders (Document rows of type ORDER — AGENT 02) ────────────
  ORDERS_CREATE: "documents.order.create",
  ORDERS_UPDATE_DRAFT: "documents.order.update_draft",
  ORDERS_ISSUE: "documents.order.issue",
  ORDERS_VOID: "documents.order.void",

  // ── CRM / commerce (AGENT 02) ──────────────────────────────────
  LEADS_READ: "leads.read",
  LEADS_CREATE: "leads.create",
  LEADS_UPDATE: "leads.update",
  LEADS_DELETE: "leads.delete",
  LEADS_CONVERT: "leads.convert",
  PIPELINES_READ: "pipelines.read",
  PIPELINES_MANAGE: "pipelines.manage",
  TASKS_READ: "tasks.read",
  TASKS_MANAGE: "tasks.manage",
  ACTIVITIES_READ: "activities.read",
  SHARE_LINKS_READ: "share_links.read",
  SHARE_LINKS_MANAGE: "share_links.manage",
  DATA_IMPORT: "data.import",

  // ── Social commerce & marketing (AGENT 03) ─────────────────────
  INTEGRATIONS_READ: "integrations.read",
  INTEGRATIONS_MANAGE: "integrations.manage",
  INBOX_READ: "inbox.read",
  INBOX_MANAGE: "inbox.manage",
  INBOX_CONVERSE: "inbox.converse",
  MARKETING_READ: "marketing.read",
  MARKETING_MANAGE: "marketing.manage",
  MARKETING_PUBLISH: "marketing.publish",
  ANALYTICS_READ: "analytics.read",

  // ── Customer portal ────────────────────────────────────────────
  PORTAL_ACCESS_MANAGE: "portal.access.manage",
  PORTAL_DOCUMENTS_READ: "portal.documents.read",
  PORTAL_DOCUMENTS_DOWNLOAD: "portal.documents.download",

  // ── Exports / audit ────────────────────────────────────────────
  EXPORTS_CREATE: "exports.create",
  AUDIT_READ: "audit.read",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] =
  Object.values(PERMISSIONS);

export type PermissionDomain = "platform" | "tenant";

export type PermissionDefinition = {
  readonly key: Permission;
  readonly domain: PermissionDomain;
  readonly area: string;
  readonly description: string;
};

/**
 * Catalogue metadata (domain/area/description) for every permission. Seeded
 * into the `Permission` table by migration; a parity test asserts exact
 * equality with ALL_PERMISSIONS.
 */
export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  {
    key: PERMISSIONS.PLATFORM_TENANTS_READ,
    domain: "platform",
    area: "tenants",
    description: "View tenant list and details",
  },
  {
    key: PERMISSIONS.PLATFORM_TENANTS_CREATE,
    domain: "platform",
    area: "tenants",
    description: "Provision new tenants",
  },
  {
    key: PERMISSIONS.PLATFORM_TENANTS_UPDATE,
    domain: "platform",
    area: "tenants",
    description: "Edit a tenant's profile, branding and document settings",
  },
  {
    key: PERMISSIONS.PLATFORM_TENANTS_ACTIVATE,
    domain: "platform",
    area: "tenants",
    description: "Activate (or reactivate) a tenant",
  },
  {
    key: PERMISSIONS.PLATFORM_TENANTS_SUSPEND,
    domain: "platform",
    area: "tenants",
    description: "Suspend a tenant",
  },
  {
    key: PERMISSIONS.PLATFORM_TENANTS_PLAN_ASSIGN,
    domain: "platform",
    area: "tenants",
    description: "Assign a subscription plan to a tenant",
  },
  {
    key: PERMISSIONS.PLATFORM_TENANTS_DOMAIN_MANAGE,
    domain: "platform",
    area: "tenants",
    description: "Manage a tenant's workspace slug and hostnames",
  },
  {
    key: PERMISSIONS.PLATFORM_AUDIT_READ,
    domain: "platform",
    area: "audit",
    description: "View the provider audit trail for any tenant",
  },
  {
    key: PERMISSIONS.PLATFORM_SUPPORT_GRANT,
    domain: "platform",
    area: "support",
    description: "Grant and revoke support access to a tenant",
  },

  {
    key: PERMISSIONS.BUSINESS_SETTINGS_READ,
    domain: "tenant",
    area: "settings",
    description: "View workspace settings",
  },
  {
    key: PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    domain: "tenant",
    area: "settings",
    description: "Update workspace settings",
  },
  {
    key: PERMISSIONS.BUSINESS_BRANDING_READ,
    domain: "tenant",
    area: "branding",
    description: "View tenant branding",
  },
  {
    key: PERMISSIONS.BUSINESS_BRANDING_UPDATE,
    domain: "tenant",
    area: "branding",
    description: "Update tenant branding and logo",
  },
  {
    key: PERMISSIONS.BUSINESS_MEMBERS_READ,
    domain: "tenant",
    area: "members",
    description: "View team members and invitations",
  },
  {
    key: PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
    domain: "tenant",
    area: "members",
    description: "Invite, update and remove team members",
  },

  {
    key: PERMISSIONS.CONTACTS_READ,
    domain: "tenant",
    area: "contacts",
    description: "View contacts",
  },
  {
    key: PERMISSIONS.CONTACTS_CREATE,
    domain: "tenant",
    area: "contacts",
    description: "Create contacts",
  },
  {
    key: PERMISSIONS.CONTACTS_UPDATE,
    domain: "tenant",
    area: "contacts",
    description: "Update contacts",
  },
  {
    key: PERMISSIONS.CONTACTS_DELETE,
    domain: "tenant",
    area: "contacts",
    description: "Delete contacts",
  },

  {
    key: PERMISSIONS.ITEMS_READ,
    domain: "tenant",
    area: "items",
    description: "View catalogue items",
  },
  {
    key: PERMISSIONS.ITEMS_CREATE,
    domain: "tenant",
    area: "items",
    description: "Create catalogue items",
  },
  {
    key: PERMISSIONS.ITEMS_UPDATE,
    domain: "tenant",
    area: "items",
    description: "Update catalogue items",
  },
  {
    key: PERMISSIONS.ITEMS_DELETE,
    domain: "tenant",
    area: "items",
    description: "Delete catalogue items",
  },

  {
    key: PERMISSIONS.DOCUMENTS_READ,
    domain: "tenant",
    area: "documents",
    description: "View sales documents",
  },
  {
    key: PERMISSIONS.DOCUMENTS_DOWNLOAD,
    domain: "tenant",
    area: "documents",
    description: "Download sales document PDFs",
  },

  {
    key: PERMISSIONS.QUOTATIONS_CREATE,
    domain: "tenant",
    area: "documents.quotation",
    description: "Create quotations",
  },
  {
    key: PERMISSIONS.QUOTATIONS_UPDATE_DRAFT,
    domain: "tenant",
    area: "documents.quotation",
    description: "Edit draft quotations",
  },
  {
    key: PERMISSIONS.QUOTATIONS_ISSUE,
    domain: "tenant",
    area: "documents.quotation",
    description: "Issue quotations",
  },
  {
    key: PERMISSIONS.QUOTATIONS_VOID,
    domain: "tenant",
    area: "documents.quotation",
    description: "Void quotations",
  },

  {
    key: PERMISSIONS.INVOICES_CREATE,
    domain: "tenant",
    area: "documents.invoice",
    description: "Create invoices",
  },
  {
    key: PERMISSIONS.INVOICES_UPDATE_DRAFT,
    domain: "tenant",
    area: "documents.invoice",
    description: "Edit draft invoices",
  },
  {
    key: PERMISSIONS.INVOICES_ISSUE,
    domain: "tenant",
    area: "documents.invoice",
    description: "Issue invoices",
  },
  {
    key: PERMISSIONS.INVOICES_VOID,
    domain: "tenant",
    area: "documents.invoice",
    description: "Void invoices",
  },

  {
    key: PERMISSIONS.DELIVERY_NOTES_CREATE,
    domain: "tenant",
    area: "documents.delivery_note",
    description: "Create delivery notes",
  },
  {
    key: PERMISSIONS.DELIVERY_NOTES_UPDATE_DRAFT,
    domain: "tenant",
    area: "documents.delivery_note",
    description: "Edit draft delivery notes",
  },
  {
    key: PERMISSIONS.DELIVERY_NOTES_ISSUE,
    domain: "tenant",
    area: "documents.delivery_note",
    description: "Issue delivery notes",
  },
  {
    key: PERMISSIONS.DELIVERY_NOTES_VOID,
    domain: "tenant",
    area: "documents.delivery_note",
    description: "Void delivery notes",
  },

  {
    key: PERMISSIONS.ORDERS_CREATE,
    domain: "tenant",
    area: "documents.order",
    description: "Create orders",
  },
  {
    key: PERMISSIONS.ORDERS_UPDATE_DRAFT,
    domain: "tenant",
    area: "documents.order",
    description: "Edit draft orders",
  },
  {
    key: PERMISSIONS.ORDERS_ISSUE,
    domain: "tenant",
    area: "documents.order",
    description: "Issue orders",
  },
  {
    key: PERMISSIONS.ORDERS_VOID,
    domain: "tenant",
    area: "documents.order",
    description: "Void orders",
  },

  {
    key: PERMISSIONS.LEADS_READ,
    domain: "tenant",
    area: "leads",
    description: "View leads and the sales pipeline board",
  },
  {
    key: PERMISSIONS.LEADS_CREATE,
    domain: "tenant",
    area: "leads",
    description: "Create leads (including public-form capture attribution)",
  },
  {
    key: PERMISSIONS.LEADS_UPDATE,
    domain: "tenant",
    area: "leads",
    description: "Update leads: details, stage moves, assignment, loss",
  },
  {
    key: PERMISSIONS.LEADS_DELETE,
    domain: "tenant",
    area: "leads",
    description: "Delete leads",
  },
  {
    key: PERMISSIONS.LEADS_CONVERT,
    domain: "tenant",
    area: "leads",
    description: "Convert a lead to a contact and optional draft document",
  },
  {
    key: PERMISSIONS.PIPELINES_READ,
    domain: "tenant",
    area: "pipelines",
    description: "View pipeline and stage configuration",
  },
  {
    key: PERMISSIONS.PIPELINES_MANAGE,
    domain: "tenant",
    area: "pipelines",
    description: "Create and edit pipelines and their stages",
  },
  {
    key: PERMISSIONS.TASKS_READ,
    domain: "tenant",
    area: "tasks",
    description: "View tasks",
  },
  {
    key: PERMISSIONS.TASKS_MANAGE,
    domain: "tenant",
    area: "tasks",
    description: "Create, update, complete and reopen tasks",
  },
  {
    key: PERMISSIONS.ACTIVITIES_READ,
    domain: "tenant",
    area: "activities",
    description: "View the unified activity timeline",
  },
  {
    key: PERMISSIONS.SHARE_LINKS_READ,
    domain: "tenant",
    area: "share_links",
    description: "View share links and their stats",
  },
  {
    key: PERMISSIONS.SHARE_LINKS_MANAGE,
    domain: "tenant",
    area: "share_links",
    description: "Create and revoke share links",
  },
  {
    key: PERMISSIONS.DATA_IMPORT,
    domain: "tenant",
    area: "data",
    description: "Import business data from files (contacts and catalogue)",
  },

  {
    key: PERMISSIONS.INTEGRATIONS_READ,
    domain: "tenant",
    area: "integrations",
    description: "View integration connections, capability status and health",
  },
  {
    key: PERMISSIONS.INTEGRATIONS_MANAGE,
    domain: "tenant",
    area: "integrations",
    description: "Connect, verify and disconnect social-commerce integrations",
  },
  {
    key: PERMISSIONS.INBOX_READ,
    domain: "tenant",
    area: "inbox",
    description: "View conversations, messages and internal notes",
  },
  {
    key: PERMISSIONS.INBOX_MANAGE,
    domain: "tenant",
    area: "inbox",
    description: "Assign, label and close conversations across the inbox",
  },
  {
    key: PERMISSIONS.INBOX_CONVERSE,
    domain: "tenant",
    area: "inbox",
    description: "Send outbound messages and record notes in a conversation",
  },
  {
    key: PERMISSIONS.MARKETING_READ,
    domain: "tenant",
    area: "marketing",
    description: "View campaigns, content posts and the media library",
  },
  {
    key: PERMISSIONS.MARKETING_MANAGE,
    domain: "tenant",
    area: "marketing",
    description: "Create and edit campaigns, content drafts and media",
  },
  {
    key: PERMISSIONS.MARKETING_PUBLISH,
    domain: "tenant",
    area: "marketing",
    description: "Approve, schedule and publish content posts",
  },
  {
    key: PERMISSIONS.ANALYTICS_READ,
    domain: "tenant",
    area: "analytics",
    description: "View marketing event analytics and per-link counts",
  },

  {
    key: PERMISSIONS.PORTAL_ACCESS_MANAGE,
    domain: "tenant",
    area: "portal",
    description: "Grant and revoke customer portal access",
  },
  {
    key: PERMISSIONS.PORTAL_DOCUMENTS_READ,
    domain: "tenant",
    area: "portal",
    description: "View own documents in the customer portal",
  },
  {
    key: PERMISSIONS.PORTAL_DOCUMENTS_DOWNLOAD,
    domain: "tenant",
    area: "portal",
    description: "Download own documents in the customer portal",
  },

  {
    key: PERMISSIONS.EXPORTS_CREATE,
    domain: "tenant",
    area: "exports",
    description: "Export business data",
  },
  {
    key: PERMISSIONS.DASHBOARD_READ,
    domain: "platform",
    area: "dashboard",
    description: "View the platform administration dashboard",
  },
  {
    key: PERMISSIONS.TENANTS_READ,
    domain: "tenant",
    area: "tenants",
    description: "View tenant list and details",
  },
  {
    key: PERMISSIONS.TENANTS_CREATE,
    domain: "tenant",
    area: "tenants",
    description: "Provision new tenants",
  },
  {
    key: PERMISSIONS.TENANTS_ACTIVATE,
    domain: "tenant",
    area: "tenants",
    description: "Activate (or reactivate) a tenant",
  },
  {
    key: PERMISSIONS.TENANTS_SUSPEND,
    domain: "tenant",
    area: "tenants",
    description: "Suspend a tenant",
  },
  {
    key: PERMISSIONS.TENANTS_REACTIVATE,
    domain: "tenant",
    area: "tenants",
    description: "Reactivate a suspended tenant",
  },
  {
    key: PERMISSIONS.SUBSCRIPTIONS_READ,
    domain: "tenant",
    area: "subscriptions",
    description: "View subscription plans and tenant subscription status",
  },
  {
    key: PERMISSIONS.SUBSCRIPTIONS_MANAGE,
    domain: "tenant",
    area: "subscriptions",
    description: "Assign or modify subscription plans for tenants",
  },
  {
    key: PERMISSIONS.BRANDING_READ,
    domain: "tenant",
    area: "branding",
    description: "View tenant branding configuration",
  },
  {
    key: PERMISSIONS.BRANDING_MANAGE,
    domain: "tenant",
    area: "branding",
    description: "Update tenant branding and logo",
  },
  {
    key: PERMISSIONS.PLATFORM_USERS_READ,
    domain: "platform",
    area: "platform_users",
    description: "View platform administrator accounts and roles",
  },
  {
    key: PERMISSIONS.PLATFORM_USERS_MANAGE,
    domain: "platform",
    area: "platform_users",
    description: "Create, update and revoke platform administrator accounts",
  },
  {
    key: PERMISSIONS.AUDIT_LOGS_READ,
    domain: "platform",
    area: "audit_logs",
    description: "View the platform administration audit trail",
  },
  {
    key: PERMISSIONS.SECURITY_EVENTS_READ,
    domain: "platform",
    area: "security_events",
    description: "View security-relevant events and access control changes",
  },
  {
    key: PERMISSIONS.SUPPORT_ACCESS_REQUEST,
    domain: "platform",
    area: "support",
    description: "Submit and track support access grant requests",
  },
  {
    key: PERMISSIONS.AUDIT_READ,
    domain: "tenant",
    area: "audit",
    description: "View the audit trail",
  },
];

const PLATFORM_PERMISSION_SET: ReadonlySet<Permission> = new Set(
  PERMISSION_DEFINITIONS.filter((d) => d.domain === "platform").map(
    (d) => d.key,
  ),
);

/** Tenant-domain permissions (everything that is not `platform.*`). */
export const TENANT_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) => !PLATFORM_PERMISSION_SET.has(permission),
);

// ── Read / write classification ────────────────────────────────

/**
 * The tenant-domain permissions that MUTATE business data.
 *
 * Why this exists in code rather than as a `Permission` column: the database
 * already answers the same question independently — the RLS write policies
 * refuse a member of a non-ACTIVE tenant (`app_tenant_accepts_writes()`),
 * whatever the application does. This set is the application-layer half of the
 * same rule, so a suspended workspace fails closed with a readable error
 * instead of a policy violation, and so the denial can be audited before the
 * query is attempted. The parity test for the catalog (Phase 1 carry-over #37)
 * therefore compares key/domain/area/description only — never this set.
 *
 * Classification rule: a permission is a write if exercising it inserts,
 * updates or deletes a business row. The two judgement calls worth stating:
 *   - `documents.download` / `portal.documents.download` are READS — a
 *     suspended tenant's members and portal users keep downloading issued
 *     documents (owner decision, Phase 2).
 *   - `exports.create` is a READ: it extracts rows the caller may already
 *     read and mutates nothing but its own audit event. If exports ever start
 *     writing workspace artefacts, move it here.
 *
 * Platform-domain permissions are deliberately absent: provider authority over
 * a suspended tenant (activation, branding, domains) is exactly what the
 * lifecycle needs, and the tenant write gate must not reach it.
 */
export const WRITE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
  PERMISSIONS.BUSINESS_BRANDING_UPDATE,
  PERMISSIONS.BUSINESS_MEMBERS_MANAGE,
  PERMISSIONS.CONTACTS_CREATE,
  PERMISSIONS.CONTACTS_UPDATE,
  PERMISSIONS.CONTACTS_DELETE,
  PERMISSIONS.ITEMS_CREATE,
  PERMISSIONS.ITEMS_UPDATE,
  PERMISSIONS.ITEMS_DELETE,
  PERMISSIONS.QUOTATIONS_CREATE,
  PERMISSIONS.QUOTATIONS_UPDATE_DRAFT,
  PERMISSIONS.QUOTATIONS_ISSUE,
  PERMISSIONS.QUOTATIONS_VOID,
  PERMISSIONS.INVOICES_CREATE,
  PERMISSIONS.INVOICES_UPDATE_DRAFT,
  PERMISSIONS.INVOICES_ISSUE,
  PERMISSIONS.INVOICES_VOID,
  PERMISSIONS.DELIVERY_NOTES_CREATE,
  PERMISSIONS.DELIVERY_NOTES_UPDATE_DRAFT,
  PERMISSIONS.DELIVERY_NOTES_ISSUE,
  PERMISSIONS.DELIVERY_NOTES_VOID,
  PERMISSIONS.ORDERS_CREATE,
  PERMISSIONS.ORDERS_UPDATE_DRAFT,
  PERMISSIONS.ORDERS_ISSUE,
  PERMISSIONS.ORDERS_VOID,
  PERMISSIONS.LEADS_CREATE,
  PERMISSIONS.LEADS_UPDATE,
  PERMISSIONS.LEADS_DELETE,
  PERMISSIONS.LEADS_CONVERT,
  PERMISSIONS.PIPELINES_MANAGE,
  PERMISSIONS.TASKS_MANAGE,
  PERMISSIONS.SHARE_LINKS_MANAGE,
  PERMISSIONS.DATA_IMPORT,
  PERMISSIONS.PORTAL_ACCESS_MANAGE,
  // AGENT 03: the write-class keys of the new social-commerce surface. The
  // four `*.read` keys (integrations/inbox/marketing/analytics) are deliberately
  // absent — a suspended workspace keeps reading its conversations and event
  // counts. `inbox.converse` writes outbound messages/notes, `inbox.manage`
  // reassigns and labels, `integrations.manage` mutates credentials,
  // `marketing.manage`/`marketing.publish` write content and publish jobs.
  PERMISSIONS.INTEGRATIONS_MANAGE,
  PERMISSIONS.INBOX_MANAGE,
  PERMISSIONS.INBOX_CONVERSE,
  PERMISSIONS.MARKETING_MANAGE,
  PERMISSIONS.MARKETING_PUBLISH,
]);

/** True when exercising the permission writes business data. */
export function isWritePermission(permission: Permission): boolean {
  return WRITE_PERMISSIONS.has(permission);
}

// ── Shared bundles ─────────────────────────────────────────────

const DOCUMENT_READ_DOWNLOAD: readonly Permission[] = [
  PERMISSIONS.DOCUMENTS_READ,
  PERMISSIONS.DOCUMENTS_DOWNLOAD,
];

const QUOTATIONS_ALL: readonly Permission[] = [
  PERMISSIONS.QUOTATIONS_CREATE,
  PERMISSIONS.QUOTATIONS_UPDATE_DRAFT,
  PERMISSIONS.QUOTATIONS_ISSUE,
  PERMISSIONS.QUOTATIONS_VOID,
];

const INVOICES_ALL: readonly Permission[] = [
  PERMISSIONS.INVOICES_CREATE,
  PERMISSIONS.INVOICES_UPDATE_DRAFT,
  PERMISSIONS.INVOICES_ISSUE,
  PERMISSIONS.INVOICES_VOID,
];

const DELIVERY_NOTES_ALL: readonly Permission[] = [
  PERMISSIONS.DELIVERY_NOTES_CREATE,
  PERMISSIONS.DELIVERY_NOTES_UPDATE_DRAFT,
  PERMISSIONS.DELIVERY_NOTES_ISSUE,
  PERMISSIONS.DELIVERY_NOTES_VOID,
];

const ORDERS_ALL: readonly Permission[] = [
  PERMISSIONS.ORDERS_CREATE,
  PERMISSIONS.ORDERS_UPDATE_DRAFT,
  PERMISSIONS.ORDERS_ISSUE,
  PERMISSIONS.ORDERS_VOID,
];

const LEADS_ALL: readonly Permission[] = [
  PERMISSIONS.LEADS_READ,
  PERMISSIONS.LEADS_CREATE,
  PERMISSIONS.LEADS_UPDATE,
  PERMISSIONS.LEADS_DELETE,
  PERMISSIONS.LEADS_CONVERT,
];

const TASKS_ALL: readonly Permission[] = [
  PERMISSIONS.TASKS_READ,
  PERMISSIONS.TASKS_MANAGE,
];

const SHARE_LINKS_ALL: readonly Permission[] = [
  PERMISSIONS.SHARE_LINKS_READ,
  PERMISSIONS.SHARE_LINKS_MANAGE,
];

const SETTINGS_BRANDING_READ: readonly Permission[] = [
  PERMISSIONS.BUSINESS_SETTINGS_READ,
  PERMISSIONS.BUSINESS_BRANDING_READ,
];

// AGENT 03 bundles. Owner/Admin take all nine; the working roles take the
// documented subset (design spec §2). The three inbox keys a role needs to work
// the inbox are grouped so the matrix reads one line per capability family.
const INTEGRATIONS_READ_WRITE: readonly Permission[] = [
  PERMISSIONS.INTEGRATIONS_READ,
  PERMISSIONS.INTEGRATIONS_MANAGE,
];

const INBOX_ALL: readonly Permission[] = [
  PERMISSIONS.INBOX_READ,
  PERMISSIONS.INBOX_MANAGE,
  PERMISSIONS.INBOX_CONVERSE,
];

const MARKETING_ALL: readonly Permission[] = [
  PERMISSIONS.MARKETING_READ,
  PERMISSIONS.MARKETING_MANAGE,
  PERMISSIONS.MARKETING_PUBLISH,
];

// ── Tenant role → permission matrix ────────────────────────────

/**
 * Documented role → permission policy (tenant domain).
 *
 * TENANT_OWNER  : full control of the workspace.
 * TENANT_ADMIN  : all routine operations including member management, with
 *                 delegation guards (never self, never an owner's row, never a
 *                 role at or above its own).
 * SALES         : contacts and catalogue (no deletes), quotations end-to-end,
 *                 orders up to issue (never void), the full lead/pipeline/task
 *                 and share-link surface; invoices and delivery notes
 *                 read-only.
 * FINANCE       : invoices end-to-end (issue/void), orders create/issue/void,
 *                 exports; quotations, delivery notes, leads and tasks
 *                 read-only.
 * OPERATIONS    : catalogue create/update, delivery notes end-to-end, order
 *                 preparation (create/draft edits), tasks manage; quotations
 *                 and invoices read-only.
 * VIEWER        : read-only access to explicitly permitted information,
 *                 including the new leads/pipelines/tasks/timeline/share-link
 *                 reads.
 * CUSTOMER_PORTAL_USER: the customer portal only — never internal records.
 */
export const TENANT_ROLE_PERMISSIONS: Record<
  TenantRole,
  readonly Permission[]
> = {
  TENANT_OWNER: [
    PERMISSIONS.BUSINESS_SETTINGS_READ,
    PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    PERMISSIONS.BUSINESS_BRANDING_READ,
    PERMISSIONS.BUSINESS_BRANDING_UPDATE,
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
    ...DOCUMENT_READ_DOWNLOAD,
    ...QUOTATIONS_ALL,
    ...INVOICES_ALL,
    ...DELIVERY_NOTES_ALL,
    ...ORDERS_ALL,
    ...LEADS_ALL,
    PERMISSIONS.PIPELINES_READ,
    PERMISSIONS.PIPELINES_MANAGE,
    ...TASKS_ALL,
    PERMISSIONS.ACTIVITIES_READ,
    ...SHARE_LINKS_ALL,
    PERMISSIONS.DATA_IMPORT,
    PERMISSIONS.PORTAL_ACCESS_MANAGE,
    PERMISSIONS.EXPORTS_CREATE,
    PERMISSIONS.AUDIT_READ,
    // AGENT 03: full social-commerce surface (+9).
    ...INTEGRATIONS_READ_WRITE,
    ...INBOX_ALL,
    ...MARKETING_ALL,
    PERMISSIONS.ANALYTICS_READ,
  ],
  TENANT_ADMIN: [
    PERMISSIONS.BUSINESS_SETTINGS_READ,
    PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
    PERMISSIONS.BUSINESS_BRANDING_READ,
    PERMISSIONS.BUSINESS_BRANDING_UPDATE,
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
    ...DOCUMENT_READ_DOWNLOAD,
    ...QUOTATIONS_ALL,
    ...INVOICES_ALL,
    ...DELIVERY_NOTES_ALL,
    ...ORDERS_ALL,
    ...LEADS_ALL,
    PERMISSIONS.PIPELINES_READ,
    PERMISSIONS.PIPELINES_MANAGE,
    ...TASKS_ALL,
    PERMISSIONS.ACTIVITIES_READ,
    ...SHARE_LINKS_ALL,
    PERMISSIONS.DATA_IMPORT,
    PERMISSIONS.PORTAL_ACCESS_MANAGE,
    PERMISSIONS.EXPORTS_CREATE,
    PERMISSIONS.AUDIT_READ,
    // AGENT 03: full social-commerce surface (+9), identical to OWNER.
    ...INTEGRATIONS_READ_WRITE,
    ...INBOX_ALL,
    ...MARKETING_ALL,
    PERMISSIONS.ANALYTICS_READ,
  ],
  SALES: [
    ...SETTINGS_BRANDING_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.CONTACTS_CREATE,
    PERMISSIONS.CONTACTS_UPDATE,
    PERMISSIONS.ITEMS_READ,
    PERMISSIONS.ITEMS_CREATE,
    PERMISSIONS.ITEMS_UPDATE,
    ...DOCUMENT_READ_DOWNLOAD,
    PERMISSIONS.QUOTATIONS_CREATE,
    PERMISSIONS.QUOTATIONS_UPDATE_DRAFT,
    PERMISSIONS.QUOTATIONS_ISSUE,
    // CRM: full lead/pipeline/task surface, share links, and orders up to
    // issue — SALES may not void an order.
    ...LEADS_ALL,
    PERMISSIONS.PIPELINES_READ,
    ...TASKS_ALL,
    PERMISSIONS.ACTIVITIES_READ,
    ...SHARE_LINKS_ALL,
    PERMISSIONS.ORDERS_CREATE,
    PERMISSIONS.ORDERS_UPDATE_DRAFT,
    PERMISSIONS.ORDERS_ISSUE,
    // AGENT 03 (+5): read integrations, run the whole inbox, read marketing.
    // No integrations.manage and no marketing publish — selling is not operating
    // the connection or publishing brand content.
    PERMISSIONS.INTEGRATIONS_READ,
    ...INBOX_ALL,
    PERMISSIONS.MARKETING_READ,
  ],
  FINANCE: [
    ...SETTINGS_BRANDING_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.ITEMS_READ,
    ...DOCUMENT_READ_DOWNLOAD,
    ...INVOICES_ALL,
    PERMISSIONS.EXPORTS_CREATE,
    // CRM: read-only lead/task/timeline context, plus the order money path
    // (create/issue/void); order drafts are edited by their creators.
    PERMISSIONS.LEADS_READ,
    PERMISSIONS.TASKS_READ,
    PERMISSIONS.ACTIVITIES_READ,
    PERMISSIONS.ORDERS_CREATE,
    PERMISSIONS.ORDERS_ISSUE,
    PERMISSIONS.ORDERS_VOID,
  ],
  OPERATIONS: [
    ...SETTINGS_BRANDING_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.ITEMS_READ,
    PERMISSIONS.ITEMS_CREATE,
    PERMISSIONS.ITEMS_UPDATE,
    ...DOCUMENT_READ_DOWNLOAD,
    ...DELIVERY_NOTES_ALL,
    // CRM: fulfilment context — read leads and the timeline, run tasks,
    // share links, and prepare orders (no issue/void).
    PERMISSIONS.LEADS_READ,
    ...TASKS_ALL,
    PERMISSIONS.ACTIVITIES_READ,
    PERMISSIONS.SHARE_LINKS_READ,
    PERMISSIONS.ORDERS_CREATE,
    PERMISSIONS.ORDERS_UPDATE_DRAFT,
    // AGENT 03 (+4): answer conversations and read integration/analytics
    // context. No inbox.manage (assignment/labels are a sales/owner duty) and
    // no marketing surface.
    PERMISSIONS.INTEGRATIONS_READ,
    PERMISSIONS.INBOX_READ,
    PERMISSIONS.INBOX_CONVERSE,
    PERMISSIONS.ANALYTICS_READ,
  ],
  VIEWER: [
    ...SETTINGS_BRANDING_READ,
    PERMISSIONS.BUSINESS_MEMBERS_READ,
    PERMISSIONS.CONTACTS_READ,
    PERMISSIONS.ITEMS_READ,
    ...DOCUMENT_READ_DOWNLOAD,
    // CRM: read-only across the new surfaces.
    PERMISSIONS.LEADS_READ,
    PERMISSIONS.PIPELINES_READ,
    PERMISSIONS.TASKS_READ,
    PERMISSIONS.ACTIVITIES_READ,
    PERMISSIONS.SHARE_LINKS_READ,
    // AGENT 03 (+3): read-only inbox, marketing and analytics. No integration
    // view (connection metadata is operator-facing), no converse, no publish.
    PERMISSIONS.INBOX_READ,
    PERMISSIONS.MARKETING_READ,
    PERMISSIONS.ANALYTICS_READ,
  ],
  CUSTOMER_PORTAL_USER: [
    PERMISSIONS.PORTAL_DOCUMENTS_READ,
    PERMISSIONS.PORTAL_DOCUMENTS_DOWNLOAD,
  ],
};

// ── Platform role → permission matrix ──────────────────────────

/**
 * Documented role → permission policy (platform domain).
 *
 * SUPER_ADMIN holds every platform permission. SUPPORT holds NONE: support
 * staff reach tenant data only through an active, audited SupportAccessGrant,
 * and even then only the read-only set in SUPPORT_TENANT_PERMISSIONS.
 */
export const PLATFORM_ROLE_PERMISSIONS: Record<
  PlatformRole,
  readonly Permission[]
> = {
  SUPER_ADMIN: PERMISSION_DEFINITIONS.filter(
    (d) => d.domain === "platform",
  ).map((d) => d.key),
  SUPPORT: [],
};

/**
 * The explicit, read-only permission set an active support grant confers.
 * Deliberately excludes every write permission, membership management and
 * portal management.
 */
export const SUPPORT_TENANT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.BUSINESS_SETTINGS_READ,
  PERMISSIONS.BUSINESS_BRANDING_READ,
  PERMISSIONS.BUSINESS_MEMBERS_READ,
  PERMISSIONS.CONTACTS_READ,
  PERMISSIONS.ITEMS_READ,
  PERMISSIONS.DOCUMENTS_READ,
  PERMISSIONS.DOCUMENTS_DOWNLOAD,
  PERMISSIONS.AUDIT_READ,
];

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
  return PLATFORM_PERMISSION_SET.has(permission);
}
