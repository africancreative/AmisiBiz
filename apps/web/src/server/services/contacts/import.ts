import { prisma } from "@amisibiz/database";
import type { TenantAuthzContext } from "@/server/auth/authorization";
import { recordAudit } from "@/lib/audit";
import { appendActivity } from "@/server/services/activities/service";
import { createContactSchema } from "@/lib/validations/contact";
import { ContactServiceError } from "./errors";
import { createContactRecord } from "./create";

/**
 * Contact CSV import (AGENT 02, Phase 2B).
 *
 * Two steps, mirroring merge: the PREVIEW parses and validates the file and
 * classifies every row (valid / invalid with per-field reasons / duplicate),
 * the COMMIT re-runs the FULL `createContactSchema` per row and creates rows
 * through `createContactRecord` — the same code path a form create takes, so
 * "validated at preview" can never mean "trusted at commit".
 *
 * Retry safety: each created row is stamped with an ActivityEvent keyed
 * `import:<operationId>:<rowIndex>`. Re-running the same operationId checks
 * that key BEFORE creating, so a retried commit never double-creates.
 *
 * Never trusted from the file: `id`, `status`, `createdAt`,
 * `marketingConsentAt` and `tenantId` — row identity and lifecycle belong to
 * the server. Those columns are recognised, reported and dropped.
 */

/** Audit action for one import commit (lib/audit is outside this whitelist). */
const AUDIT_CONTACT_IMPORTED = "contact.imported";

/** Hard cap per file; anything larger is a background job, not a request. */
export const IMPORT_ROW_CAP = 5000;

/* ─────────────────────────── RFC 4180 parser ─────────────────────────────── */

/**
 * Minimal RFC 4180 state machine — quotes, doubled-quote escapes, CRLF/LF
 * line endings. No dependencies, and deliberately NOT `split(",")`: an
 * address note containing a comma or a newline inside quotes must survive
 * the round trip.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let rowStarted = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
    rowStarted = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    rowStarted = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "" && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
      rowStarted = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    field += ch;
    rowStarted = true;
  }

  // Flush a final row that did not end in a newline.
  if (field !== "" || row.length > 0 || rowStarted) endRow();

  // Blank lines (a single empty field) are not data rows.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/* ───────────────────────────── column map ────────────────────────────────── */

/**
 * Header (lower-cased) -> payload key. `null` means "recognised but dropped":
 * server-owned columns a file must never set. Anything else is an UNKNOWN
 * column — reported to the user, never guessed at.
 */
const HEADER_MAP: Readonly<Record<string, string | null>> = {
  firstname: "firstName",
  lastname: "lastName",
  companyname: "companyName",
  email: "email",
  phone: "phone",
  mobile: "mobile",
  taxpin: "taxPin",
  notes: "notes",
  type: "type",
  source: "source",
  sourcedetail: "sourceDetail",
  sourcecampaign: "sourceCampaign",
  preferredchannel: "preferredChannel",
  marketingconsent: "marketingConsent",
  // Server-owned columns: accepted, dropped, and reported as ignored.
  id: null,
  status: null,
  createdat: null,
  marketingconsentat: null,
  tenantid: null,
};

const TRUTHY = new Set(["true", "1", "yes", "y"]);
const FALSY = new Set(["false", "0", "no", "n"]);

/* ─────────────────────────── row -> payload ──────────────────────────────── */

/** Header cell classification, resolved once per file. */
interface MappedColumn {
  readonly raw: string;
  readonly header: string;
  readonly key: string;
  readonly index: number;
}

function rowPayload(
  mapped: readonly MappedColumn[],
  cells: readonly string[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const column of mapped) {
    const cell = cells[column.index] ?? "";
    if (column.header === "marketingconsent") {
      const value = cell.trim().toLowerCase();
      if (value === "") continue; // blank: absent, the schema default applies
      if (TRUTHY.has(value)) {
        data[column.key] = true;
      } else if (FALSY.has(value)) {
        data[column.key] = false;
      } else {
        // Unrecognised text stays a string so zod rejects the row with a reason.
        data[column.key] = cell;
      }
      continue;
    }
    if (cell.trim() === "") {
      // Blank cell: omit the key entirely. Text columns treat missing and ""
      // identically in the schema; omitted enums take the schema default
      // (`type`) or stay unset (source/preferredChannel).
      continue;
    }
    if (
      column.header === "type" ||
      column.header === "source" ||
      column.header === "preferredchannel"
    ) {
      data[column.key] = cell.trim().toUpperCase();
      continue;
    }
    data[column.key] = cell;
  }
  return data;
}

export interface ImportInvalidRow {
  readonly rowIndex: number;
  readonly errors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
}

export interface ImportDuplicateRow {
  readonly rowIndex: number;
  readonly matchedBy: readonly string[];
}

export interface ImportValidRow {
  readonly rowIndex: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ImportPreviewResult {
  readonly totalRows: number;
  readonly valid: readonly ImportValidRow[];
  readonly invalid: readonly ImportInvalidRow[];
  readonly duplicates: readonly ImportDuplicateRow[];
  readonly unknownColumns: readonly string[];
  readonly ignoredColumns: readonly string[];
  readonly canCommit: boolean;
}

/* ───────────────────────────── preview ───────────────────────────────────── */

/**
 * Parse + classify, READ-ONLY. Duplicates are matches against the tenant's
 * existing ACTIVE contacts (exact normalized email, exact trimmed phone or
 * mobile) and against earlier rows of the same file. A duplicate is never
 * auto-merged and never auto-created — the human decides.
 */
export async function importContactsPreview(
  authz: TenantAuthzContext,
  csvText: string,
): Promise<ImportPreviewResult> {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    throw new ContactServiceError("VALIDATION", "The CSV file is empty.");
  }
  const headerCells = rows[0] ?? [];
  const headers = headerCells.map((cell, index) => {
    const raw = cell.trim();
    const lower = raw.toLowerCase();
    const known = Object.prototype.hasOwnProperty.call(HEADER_MAP, lower)
      ? HEADER_MAP[lower]
      : undefined;
    return { raw, header: lower, index, key: known };
  });

  const unknownColumns = headers
    .filter((c) => c.key === undefined)
    .map((c) => c.raw);
  const ignoredColumns = headers
    .filter((c) => c.key === null)
    .map((c) => c.raw);
  const mapped: MappedColumn[] = [];
  headers.forEach((c) => {
    if (typeof c.key === "string") {
      mapped.push({ raw: c.raw, header: c.header, index: c.index, key: c.key });
    }
  });

  const dataRows = rows.slice(1);
  if (dataRows.length > IMPORT_ROW_CAP) {
    throw new ContactServiceError(
      "VALIDATION",
      `At most ${IMPORT_ROW_CAP} rows can be imported per file.`,
    );
  }

  const valid: ImportValidRow[] = [];
  const invalid: ImportInvalidRow[] = [];
  const duplicates: ImportDuplicateRow[] = [];

  // In-file claim sets for duplicate detection across rows of one file.
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  for (let index = 0; index < dataRows.length; index += 1) {
    const rowIndex = index + 1; // 1-based data row; the header is row 0.
    const cells = dataRows[index] ?? [];

    if (cells.length > headerCells.length) {
      invalid.push({
        rowIndex,
        errors: [
          {
            field: "row",
            message: "This row has more fields than the header defines.",
          },
        ],
      });
      continue;
    }

    const data = rowPayload(mapped, cells);
    const parsed = createContactSchema.safeParse({
      tenantId: authz.tenantId,
      ...data,
    });
    if (!parsed.success) {
      invalid.push({
        rowIndex,
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "row",
          message: issue.message,
        })),
      });
      continue;
    }

    const matchedBy: string[] = [];
    const email = parsed.data.email?.trim().toLowerCase() || null;
    const phone = parsed.data.phone?.trim() || null;

    if (email) {
      const existing = await prisma.contact.findFirst({
        where: { tenantId: authz.tenantId, email, status: "ACTIVE" },
        select: { id: true },
      });
      if (existing) matchedBy.push("email:existing");
      else if (seenEmails.has(email)) matchedBy.push("email:file");
    }
    if (phone) {
      const existing = await prisma.contact.findFirst({
        where: {
          tenantId: authz.tenantId,
          status: "ACTIVE",
          OR: [{ phone }, { mobile: phone }],
        },
        select: { id: true },
      });
      if (existing) matchedBy.push("phone:existing");
      else if (seenPhones.has(phone)) matchedBy.push("phone:file");
    }

    if (matchedBy.length > 0) {
      duplicates.push({ rowIndex, matchedBy });
      continue;
    }
    if (email) seenEmails.add(email);
    if (phone) seenPhones.add(phone);
    valid.push({ rowIndex, data });
  }

  return {
    totalRows: dataRows.length,
    valid,
    invalid,
    duplicates,
    unknownColumns,
    ignoredColumns,
    canCommit: valid.length > 0,
  };
}

/* ───────────────────────────── commit ────────────────────────────────────── */

export interface ImportCommitRowInput {
  readonly rowIndex: number;
  readonly data: Record<string, unknown>;
}

export interface ImportCommitResult {
  readonly created: number;
  readonly skippedExisting: number;
  readonly failed: readonly {
    readonly rowIndex: number;
    readonly reason: string;
  }[];
}

/**
 * Create the reviewed rows. Every row is re-validated and written through
 * `createContactRecord` — the exact path `createContactAction` takes — and
 * each success is stamped with the `import:<operationId>:<rowIndex>` event
 * that makes a replay a no-op for rows it already created.
 */
export async function importContactsCommit(
  authz: TenantAuthzContext,
  actorId: string,
  input: { operationId: string; rows: readonly ImportCommitRowInput[] },
): Promise<ImportCommitResult> {
  if (input.rows.length > IMPORT_ROW_CAP) {
    throw new ContactServiceError(
      "VALIDATION",
      `At most ${IMPORT_ROW_CAP} rows can be imported per operation.`,
    );
  }

  const tenantId = authz.tenantId;
  let created = 0;
  let skippedExisting = 0;
  const failed: {
    rowIndex: number;
    reason: string;
  }[] = [];

  for (const row of input.rows) {
    const sourceKey = `import:${input.operationId}:${row.rowIndex}`;

    // Replay guard: this exact row of this exact operation already landed.
    const recorded = await prisma.activityEvent.findFirst({
      where: {
        tenantId,
        source: "contact:import",
        sourceKey,
      },
      select: { id: true },
    });
    if (recorded) {
      skippedExisting += 1;
      continue;
    }

    const parsed = createContactSchema.safeParse({
      tenantId,
      ...row.data,
    });
    if (!parsed.success) {
      failed.push({ rowIndex: row.rowIndex, reason: "VALIDATION" });
      continue;
    }

    const outcome = await createContactRecord(authz, parsed.data);
    if (!outcome.ok) {
      failed.push({
        rowIndex: row.rowIndex,
        reason: outcome.reason,
      });
      continue;
    }

    created += 1;
    await appendActivity(authz, actorId, {
      eventType: "CONTACT_IMPORTED",
      contactId: outcome.contactId,
      source: "contact:import",
      sourceKey,
      payload: { operationId: input.operationId, rowIndex: row.rowIndex },
    });
  }

  await recordAudit({
    action: AUDIT_CONTACT_IMPORTED,
    userId: actorId,
    tenantId,
    resource: "Contact",
    metadata: {
      operationId: input.operationId,
      created,
      skippedExisting,
      failed: failed.length,
    },
  });

  return { created, skippedExisting, failed };
}
