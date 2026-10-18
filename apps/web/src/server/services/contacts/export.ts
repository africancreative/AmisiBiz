import { Prisma } from "@prisma/client";
import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Contact CSV export (AGENT 02, Phase 2B).
 *
 * The CSV is built SERVER-side: an export must never be assembled from rows a
 * browser already holds, because that would let a page export columns the
 * session's permission never covered. The filter mirrors `getContactsAction`
 * (search/type/status) minus pagination — an export page IS the whole result.
 *
 * Column order is FIXED (header included even for an empty result) so an
 * import file can be produced from a template. The exported columns are exactly
 * the ones `importContactsPreview` understands; addresses and tags are
 * relational and deliberately stay out of the flat file. Dates are ISO
 * instants; there is no money column on a contact, and document exports
 * already render money as plain decimal STRINGS from the database.
 */

const EXPORT_SELECT = {
  id: true,
  type: true,
  status: true,
  firstName: true,
  lastName: true,
  companyName: true,
  email: true,
  phone: true,
  mobile: true,
  taxPin: true,
  notes: true,
  source: true,
  sourceDetail: true,
  sourceCampaign: true,
  preferredChannel: true,
  marketingConsent: true,
  marketingConsentAt: true,
  createdAt: true,
} satisfies Prisma.ContactSelect;

type ExportRow = Prisma.ContactGetPayload<{ select: typeof EXPORT_SELECT }>;

/** Documented export contract — header order must match `rowToCells`. */
export const CONTACT_EXPORT_HEADERS: readonly string[] = [
  "id",
  "type",
  "status",
  "firstName",
  "lastName",
  "companyName",
  "email",
  "phone",
  "mobile",
  "taxPin",
  "notes",
  "source",
  "sourceDetail",
  "sourceCampaign",
  "preferredChannel",
  "marketingConsent",
  "marketingConsentAt",
  "createdAt",
];

/** Deliberate ceiling: a larger export is a job, not a request. */
const EXPORT_ROW_CAP = 10_000;

/** RFC 4180 quoting: double quotes escape by doubling; quote when needed. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function text(value: string | null): string {
  return value ?? "";
}

function rowToCells(row: ExportRow): string[] {
  return [
    row.id,
    row.type,
    row.status,
    text(row.firstName),
    text(row.lastName),
    text(row.companyName),
    text(row.email),
    text(row.phone),
    text(row.mobile),
    text(row.taxPin),
    text(row.notes),
    text(row.source),
    text(row.sourceDetail),
    text(row.sourceCampaign),
    text(row.preferredChannel),
    row.marketingConsent ? "true" : "false",
    row.marketingConsentAt ? row.marketingConsentAt.toISOString() : "",
    row.createdAt.toISOString(),
  ];
}

export interface ContactExportFilter {
  readonly search?: string;
  readonly type?: "INDIVIDUAL" | "BUSINESS";
  readonly status?: "ACTIVE" | "ARCHIVED";
}

export interface ContactExportResult {
  readonly csv: string;
  readonly rowCount: number;
  readonly truncated: boolean;
}

/** Build the CSV for the authorized tenant, honouring the list filter. */
export async function exportContacts(
  authz: TenantAuthzContext,
  filter: ContactExportFilter,
): Promise<ContactExportResult> {
  const where: Prisma.ContactWhereInput = {
    tenantId: authz.tenantId,
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.search
      ? {
          OR: [
            { firstName: { contains: filter.search, mode: "insensitive" } },
            { lastName: { contains: filter.search, mode: "insensitive" } },
            { companyName: { contains: filter.search, mode: "insensitive" } },
            { email: { contains: filter.search, mode: "insensitive" } },
            { phone: { contains: filter.search, mode: "insensitive" } },
            { mobile: { contains: filter.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const rows = await prisma.contact.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: EXPORT_ROW_CAP + 1,
    select: EXPORT_SELECT,
  });

  const truncated = rows.length > EXPORT_ROW_CAP;
  const limited = truncated ? rows.slice(0, EXPORT_ROW_CAP) : rows;

  const lines = [
    CONTACT_EXPORT_HEADERS.join(","),
    ...limited.map((row) => rowToCells(row).map(csvEscape).join(",")),
  ];

  return {
    csv: `${lines.join("\r\n")}\r\n`,
    rowCount: limited.length,
    truncated,
  };
}
