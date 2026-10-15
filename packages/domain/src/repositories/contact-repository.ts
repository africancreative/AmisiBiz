import type {
  ContactQuery,
  ContactRecord,
  ContactStatus,
  ContactType,
  Page,
} from "./types";

/**
 * Persistence port for CRM contacts.
 *
 * Contract only — see `./types.ts` for the rules every implementation must
 * honour. The server implements this over Prisma under the request's RLS scope;
 * the future offline client implements it over SQLite. Neither adapter is
 * referenced here, so callers depend only on the behaviour.
 *
 * Archive is a SOFT delete: `archive` sets status ARCHIVED and records
 * `archivedAt`, and `restore` reverses it. Nothing deletes a contact that a
 * historical document may point at.
 */
export interface ContactRepository {
  findById(tenantId: string, contactId: string): Promise<ContactRecord | null>;

  /** Case-insensitive search across name, company, email and phone. */
  list(tenantId: string, query: ContactQuery): Promise<Page<ContactRecord>>;

  create(
    tenantId: string,
    input: {
      type: ContactType;
      firstName?: string | null;
      lastName?: string | null;
      companyName?: string | null;
      email?: string | null;
      phone?: string | null;
      mobile?: string | null;
      taxPin?: string | null;
      notes?: string | null;
      addresses?: Omit<ContactRecord["addresses"][number], "id">[];
    },
  ): Promise<ContactRecord>;

  update(
    tenantId: string,
    contactId: string,
    input: Partial<{
      type: ContactType;
      status: ContactStatus;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      email: string | null;
      phone: string | null;
      mobile: string | null;
      taxPin: string | null;
      notes: string | null;
    }>,
  ): Promise<ContactRecord | null>;

  /** Returns false when the contact is not in the tenant or already archived. */
  archive(tenantId: string, contactId: string): Promise<boolean>;

  /** Returns false when the contact is not in the tenant or already active. */
  restore(tenantId: string, contactId: string): Promise<boolean>;
}
