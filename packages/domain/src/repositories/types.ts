/**
 * Repository ports for the CRM and catalogue.
 *
 * These are CONTRACTS ONLY. They describe the operations the application needs
 * from a store of contacts, addresses, catalogue items and customer-specific
 * catalogue entries, in terms that do not mention Prisma, PostgreSQL or SQLite.
 *
 * Why this seam exists: AmisiBiz is designed to keep working on a device with no
 * connectivity. That client keeps its own local store (SQLite) and records user
 * actions as an operation queue (`@amisibiz/sync`); when it is online the same
 * operations are replayed against the server. If the application code talks to
 * an interface, the server adapter (Prisma) and the offline adapter (SQLite) can
 * implement the same contract without the calling code knowing which it holds.
 *
 * Two rules every implementation must honour, because the rest of the product
 * relies on them:
 *
 *   1. Every method is TENANT-SCOPED. `tenantId` is a required argument and a
 *      query must never return or mutate a row belonging to another tenant. The
 *      server adapter additionally relies on the RLS scope opened by
 *      `authorizeTenant`; the offline adapter relies on its own partition.
 *   2. Money and quantities are decimal STRINGS (see `@amisibiz/documents`).
 *      They are never binary floating point.
 */

/** Roles a repository may take on to read; write authorization stays outside. */
export type TenantRef = { tenantId: string };

export const CONTACT_TYPES = ["INDIVIDUAL", "BUSINESS"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const CONTACT_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_ADDRESS_TYPES = ["POSTAL", "PHYSICAL"] as const;
export type ContactAddressType = (typeof CONTACT_ADDRESS_TYPES)[number];

export const ITEM_TYPES = ["PRODUCT", "SERVICE"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** A page of results plus the counters a list screen needs to page through. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SortDirection {
  direction: "asc" | "desc";
}

export interface ContactAddressRecord {
  id: string;
  /** "POSTAL" | "PHYSICAL" — a free-text column in the schema. */
  type: string;
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  isDefault: boolean;
}

export interface ContactRecord {
  id: string;
  tenantId: string;
  type: ContactType;
  status: ContactStatus;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  taxPin: string | null;
  /** Internal note. Never rendered in the customer portal. */
  notes: string | null;
  /** ISO-8601 UTC, or null while active. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  addresses: ContactAddressRecord[];
}

export interface ItemRecord {
  id: string;
  tenantId: string;
  type: ItemType;
  status: ItemStatus;
  name: string;
  sku: string | null;
  description: string | null;
  unitOfMeasure: string;
  unitPrice: string;
  currency: string;
  taxRateId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactItemRecord {
  id: string;
  tenantId: string;
  contactId: string;
  itemId: string;
  customCode: string | null;
  customName: string | null;
  customUnitOfMeasure: string | null;
  agreedPrice: string;
  discountPercent: string;
  isAvailable: boolean;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactQuery {
  search?: string;
  type?: ContactType;
  status?: ContactStatus;
  page?: number;
  pageSize?: number;
  sortBy?: "createdAt" | "updatedAt" | "companyName" | "email";
  sortOrder?: "asc" | "desc";
}

export interface ItemQuery {
  search?: string;
  type?: ItemType;
  status?: ItemStatus;
  page?: number;
  pageSize?: number;
  sortBy?: "createdAt" | "updatedAt" | "name" | "sku" | "unitPrice";
  sortOrder?: "asc" | "desc";
}

export interface ContactItemQuery {
  contactId?: string;
  itemId?: string;
  page?: number;
  pageSize?: number;
}
