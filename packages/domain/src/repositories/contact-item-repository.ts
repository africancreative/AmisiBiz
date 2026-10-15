import type { ContactItemQuery, ContactItemRecord, Page } from "./types";

/**
 * Persistence port for the customer-specific catalogue (`contact_items`).
 *
 * Contract only — see `./types.ts`.
 *
 * The integrity rule this port exists to protect: a `ContactItem` links one
 * contact and one item that belong to the SAME tenant as the link itself. On the
 * server that is enforced twice — by the foreign keys plus the
 * `catalogue_assignment_is_single_tenant()` database trigger, and by an
 * authorization check before the write. An offline adapter must apply the same
 * rule locally, and the operation that creates a link must carry `tenantId` so
 * the server can re-check it on replay.
 */
export interface ContactItemRepository {
  findById(
    tenantId: string,
    contactItemId: string,
  ): Promise<ContactItemRecord | null>;

  /** Finds the override for one (contact, item) pair, if any. */
  findForPair(
    tenantId: string,
    contactId: string,
    itemId: string,
  ): Promise<ContactItemRecord | null>;

  list(
    tenantId: string,
    query: ContactItemQuery,
  ): Promise<Page<ContactItemRecord>>;

  /**
   * Creates or replaces the override for a (contact, item) pair. Both the
   * contact and the item must belong to `tenantId`; an implementation must refuse
   * the write otherwise rather than create a cross-tenant relationship.
   */
  upsert(
    tenantId: string,
    input: {
      contactId: string;
      itemId: string;
      customCode?: string | null;
      customName?: string | null;
      customUnitOfMeasure?: string | null;
      agreedPrice: string;
      discountPercent: string;
      isAvailable?: boolean;
      validFrom?: string | null;
      validUntil?: string | null;
    },
  ): Promise<ContactItemRecord>;

  /** Returns false when the link is not in the tenant. */
  remove(tenantId: string, contactItemId: string): Promise<boolean>;
}
