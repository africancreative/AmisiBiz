import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";

/**
 * Lead duplicate detection (AGENT 02 Phase 2A).
 *
 * Never automatic, never blocking: the design rule is "no silent dedupe", so
 * this module SCORES candidates and the caller (createLead, the action, the
 * UI) shows them to a human. A strong match is a normalized email or phone
 * equality on an OPEN lead; company-name equality is an ambiguous match shown
 * for review only.
 *
 * Normalization contract (shared with `createLead`, which stores emails
 * lower-cased):
 *  - email: trim + lowercase;
 *  - phone: digits only, then the LAST 9 digits. That collapses local-format
 *    noise (`0712 345 678` vs `+254712345678` in a 9-digit-national world)
 *    into one comparable suffix; numbers shorter than 9 digits compare as
 *    their full digit string.
 */

export type DuplicateMatchBasis = "EMAIL" | "PHONE" | "COMPANY_NAME";

export interface DuplicateSuspect {
  readonly id: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: string;
  readonly createdAt: Date;
  readonly basis: readonly DuplicateMatchBasis[];
}

/** A lead's status is "open" while it can still be worked; terminal ones are
 *  excluded from duplicate pressure so an old lost lead never blocks a fresh
 *  enquiry by shadowing the board. */
const OPEN_STATUSES = ["NEW", "CONTACTED", "QUALIFIED"] as const;

export function normalizeEmail(
  email: string | null | undefined,
): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export function normalizePhone(
  phone: string | null | undefined,
): string | null {
  const digits = phone?.replace(/\D/g, "") ?? "";
  if (digits.length === 0) return null;
  return digits.slice(-9);
}

function normalizeCompanyName(name: string | null | undefined): string | null {
  const trimmed = name?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

interface CandidateRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: Date;
}

/**
 * Find open leads in the authorized tenant that plausibly describe the same
 * enquiry. `excludeLeadId` lets the update path check without self-matching.
 *
 * The phone scan reads open leads that carry any phone (bounded by
 * `take` like any list surface); exact email/company comparisons run as
 * indexed predicates. Normalization is a client-side comparison because SQL
 * cannot compute "digits only, last 9".
 */
export async function findDuplicateLeads(
  authz: TenantAuthzContext,
  query: {
    email?: string | null;
    phone?: string | null;
    companyName?: string | null;
    excludeLeadId?: string;
  },
): Promise<DuplicateSuspect[]> {
  const email = normalizeEmail(query.email);
  const phoneSuffix = normalizePhone(query.phone);
  const company = normalizeCompanyName(query.companyName);

  const candidates = new Map<string, DuplicateSuspect>();
  const addBasis = (row: CandidateRow, basis: DuplicateMatchBasis): void => {
    const existing = candidates.get(row.id);
    if (existing) {
      candidates.set(row.id, {
        ...existing,
        basis: existing.basis.includes(basis)
          ? existing.basis
          : [...existing.basis, basis],
      });
      return;
    }
    candidates.set(row.id, {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      companyName: row.companyName,
      email: row.email,
      phone: row.phone,
      status: row.status,
      createdAt: row.createdAt,
      basis: [basis],
    });
  };
  const accept = (row: CandidateRow): void => {
    if (query.excludeLeadId && row.id === query.excludeLeadId) return;
    // The DB predicate narrows; the normalized comparison is authoritative.
    if (email && row.email && normalizeEmail(row.email) === email) {
      addBasis(row, "EMAIL");
    }
    if (phoneSuffix && row.phone && normalizePhone(row.phone) === phoneSuffix) {
      addBasis(row, "PHONE");
    }
    if (
      company &&
      row.companyName &&
      normalizeCompanyName(row.companyName) === company
    ) {
      addBasis(row, "COMPANY_NAME");
    }
  };

  const suspectSelect = {
    id: true,
    firstName: true,
    lastName: true,
    companyName: true,
    email: true,
    phone: true,
    status: true,
    createdAt: true,
  } as const;

  if (email) {
    const rows = await prisma.lead.findMany({
      where: {
        tenantId: authz.tenantId,
        status: { in: [...OPEN_STATUSES] },
        email,
      },
      select: suspectSelect,
      take: 50,
    });
    for (const row of rows) accept(row);
  }

  if (phoneSuffix) {
    const rows = await prisma.lead.findMany({
      where: {
        tenantId: authz.tenantId,
        status: { in: [...OPEN_STATUSES] },
        phone: { not: null },
      },
      select: suspectSelect,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    for (const row of rows) accept(row);
  }

  if (company) {
    const rows = await prisma.lead.findMany({
      where: {
        tenantId: authz.tenantId,
        status: { in: [...OPEN_STATUSES] },
        companyName: { equals: company, mode: "insensitive" },
      },
      select: suspectSelect,
      take: 50,
    });
    for (const row of rows) accept(row);
  }

  return [...candidates.values()].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}
