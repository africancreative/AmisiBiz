import type { SqlDriver } from "./driver";
import {
  cellBoolean,
  cellDecimal,
  cellString,
  type SqlRow,
  type SqlValue,
} from "./types";
import {
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  type LocalDocumentStatus,
  type LocalDocumentType,
  type SyncState,
} from "./constants";
import {
  assertFrameTenant,
  decimalField,
  enumField,
  intField,
  jsonField,
  textField,
  timestampField,
  type PullFrame,
} from "./changes";
import { readRowState } from "./sync-state";
import { isLocalReference, localReference, newUuid } from "./ids";
import type { LocalOutbox } from "./outbox";
import {
  DOCUMENT_ROUNDING_POLICY,
  calculateDocument,
  isEditable,
  outstandingBalance,
  sumDecimalStrings,
  type DocumentLineInput,
  type TaxBreakdownEntry,
} from "@amisibiz/documents";

/**
 * Document drafts, offline.
 *
 * The three rules that shape this file, in order of how much they cost to
 * break:
 *
 *   1. **An offline draft has no number and no issue date.** `number` and
 *      `issued_at` stay NULL, and two CHECK constraints in `schema.ts` refuse
 *      any write that would set them on a row that has never reached the
 *      server. What the UI shows instead is derived from the id
 *      (`LOCAL-XXXXXXXX`), so there is no column that could lie. Issuance is a
 *      *command* in the outbox; the server allocates the number under
 *      `FOR UPDATE` and the pull carries it back.
 *   2. **Totals are a local preview computed by the shared engine.** Line and
 *      document figures come from `@amisibiz/documents`' `calculateDocument` —
 *      the same decimal-string arithmetic the server runs, imported rather than
 *      copied. The server recomputes at issuance regardless, and the pull
 *      replaces these figures, so a device cannot talk itself into a total the
 *      server would not produce.
 *   3. **An issued document is immutable.** Nothing here writes a line, price
 *      or status of a row the server has issued; `EDITABLE` is decided by the
 *      same `isEditable` the server uses.
 */

export interface LocalDocumentLine {
  readonly id: string;
  readonly documentId: string;
  readonly position: number;
  readonly itemId: string | null;
  readonly description: string;
  readonly itemCode: string | null;
  readonly unitOfMeasure: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountType: "PERCENT" | "AMOUNT" | null;
  readonly discountPercent: string;
  readonly discountAmount: string;
  readonly lineTotal: string;
  readonly lineDiscount: string;
  readonly lineNet: string;
  readonly lineTax: string;
  readonly taxRateId: string | null;
  readonly taxName: string | null;
  readonly taxRate: string;
  readonly deliveredQuantity: string;
  readonly syncState: SyncState;
}

export interface LocalDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly type: LocalDocumentType;
  readonly status: LocalDocumentStatus;
  /** NULL until the server allocates it. Never a `LOCAL-…` string. */
  readonly number: string | null;
  readonly currency: string;
  readonly contactId: string | null;
  readonly sourceDocumentId: string | null;
  readonly replacementOfId: string | null;
  readonly idempotencyKey: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly expiryDate: string | null;
  readonly deliveryDate: string | null;
  readonly deliveryNote: string | null;
  readonly issuedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly customerNote: string | null;
  readonly terms: string | null;
  readonly subtotal: string;
  readonly totalDiscount: string;
  readonly taxableBase: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly roundingPolicy: string;
  readonly snapshotAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly syncState: SyncState;
  readonly serverUpdatedAt: string | null;
  readonly baseRevision: number | null;
  readonly deleted: boolean;
  readonly lastError: string | null;
}

export interface LocalDocumentPayment {
  readonly id: string;
  readonly documentId: string;
  readonly amount: string;
  readonly occurredOn: string;
  readonly method: string;
  readonly reference: string | null;
  readonly note: string | null;
  readonly reversedAt: string | null;
}

export interface DocumentWithLines extends LocalDocument {
  readonly lines: readonly LocalDocumentLine[];
  readonly taxBreakdown: readonly TaxBreakdownEntry[];
  /** The reference to print: the server number when there is one, else `LOCAL-…`. */
  readonly reference: string;
}

export interface NewDocumentLine {
  readonly id?: string;
  readonly itemId?: string | null;
  readonly description: string;
  readonly itemCode?: string | null;
  readonly unitOfMeasure?: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountType?: "PERCENT" | "AMOUNT" | null;
  readonly discountPercent?: string | null;
  readonly discountAmount?: string | null;
  readonly taxRateId?: string | null;
  readonly taxName?: string | null;
  readonly taxRate?: string | null;
}

export interface NewDocumentDraft {
  readonly tenantId: string;
  readonly id?: string;
  readonly type: LocalDocumentType;
  readonly contactId?: string | null;
  readonly currency?: string;
  readonly issueDate?: string;
  readonly dueDate?: string | null;
  readonly expiryDate?: string | null;
  readonly deliveryDate?: string | null;
  readonly deliveryNote?: string | null;
  readonly customerNote?: string | null;
  readonly terms?: string | null;
  /** Quotation → invoice, or the sales document a delivery note is against. */
  readonly sourceDocumentId?: string | null;
  readonly lines: readonly NewDocumentLine[];
}

export interface DraftPatch {
  readonly contactId?: string | null;
  readonly currency?: string;
  readonly issueDate?: string;
  readonly dueDate?: string | null;
  readonly expiryDate?: string | null;
  readonly deliveryDate?: string | null;
  readonly deliveryNote?: string | null;
  readonly customerNote?: string | null;
  readonly terms?: string | null;
}

export interface DocumentListOptions {
  readonly type?: LocalDocumentType;
  readonly status?: LocalDocumentStatus;
  readonly contactId?: string;
  readonly syncState?: SyncState;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

const DOCUMENT_COLUMNS = `id, tenant_id, type, status, number, currency, contact_id,
                          source_document_id, replacement_of_id, idempotency_key,
                          issue_date, due_date, expiry_date, delivery_date, delivery_note,
                          issued_at, issued_by_id, voided_at, void_reason, voided_by_id,
                          customer_note, terms, subtotal, total_discount, taxable_base,
                          tax_total, total, tax_breakdown, rounding_policy, snapshot_at,
                          created_at, updated_at, sync_state, server_updated_at,
                          base_revision, deleted, last_error`;

const LINE_COLUMNS = `id, tenant_id, document_id, position, item_id, source_line_id,
                      description, item_code, unit_of_measure, quantity, unit_price,
                      discount_type, discount_percent, discount_amount, line_total,
                      line_discount, line_net, line_tax, tax_rate_id, tax_name, tax_rate,
                      delivered_quantity, created_at, updated_at, sync_state,
                      server_updated_at, base_revision, deleted`;

function documentFrom(row: SqlRow): LocalDocument {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    type: String(row.type) as LocalDocumentType,
    status: String(row.status) as LocalDocumentStatus,
    number: cellString(row, "number"),
    currency: String(row.currency),
    contactId: cellString(row, "contact_id"),
    sourceDocumentId: cellString(row, "source_document_id"),
    replacementOfId: cellString(row, "replacement_of_id"),
    idempotencyKey: cellString(row, "idempotency_key"),
    issueDate: String(row.issue_date),
    dueDate: cellString(row, "due_date"),
    expiryDate: cellString(row, "expiry_date"),
    deliveryDate: cellString(row, "delivery_date"),
    deliveryNote: cellString(row, "delivery_note"),
    issuedAt: cellString(row, "issued_at"),
    voidedAt: cellString(row, "voided_at"),
    voidReason: cellString(row, "void_reason"),
    customerNote: cellString(row, "customer_note"),
    terms: cellString(row, "terms"),
    subtotal: cellDecimal(row, "subtotal"),
    totalDiscount: cellDecimal(row, "total_discount"),
    taxableBase: cellDecimal(row, "taxable_base"),
    taxTotal: cellDecimal(row, "tax_total"),
    total: cellDecimal(row, "total"),
    roundingPolicy: String(row.rounding_policy),
    snapshotAt: cellString(row, "snapshot_at"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncState: String(row.sync_state) as SyncState,
    serverUpdatedAt: cellString(row, "server_updated_at"),
    baseRevision:
      row.base_revision === null ? null : Math.trunc(Number(row.base_revision)),
    deleted: cellBoolean(row, "deleted"),
    lastError: cellString(row, "last_error"),
  };
}

function lineFrom(row: SqlRow): LocalDocumentLine {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    position: Math.trunc(Number(row.position)),
    itemId: cellString(row, "item_id"),
    description: String(row.description),
    itemCode: cellString(row, "item_code"),
    unitOfMeasure: String(row.unit_of_measure),
    quantity: cellDecimal(row, "quantity"),
    unitPrice: cellDecimal(row, "unit_price"),
    discountType: row.discount_type
      ? (String(row.discount_type) as LocalDocumentLine["discountType"])
      : null,
    discountPercent: cellDecimal(row, "discount_percent"),
    discountAmount: cellDecimal(row, "discount_amount"),
    lineTotal: cellDecimal(row, "line_total"),
    lineDiscount: cellDecimal(row, "line_discount"),
    lineNet: cellDecimal(row, "line_net"),
    lineTax: cellDecimal(row, "line_tax"),
    taxRateId: cellString(row, "tax_rate_id"),
    taxName: cellString(row, "tax_name"),
    taxRate: cellDecimal(row, "tax_rate"),
    deliveredQuantity: cellDecimal(row, "delivered_quantity"),
    syncState: String(row.sync_state) as SyncState,
  };
}

function parseBreakdown(raw: string | null): TaxBreakdownEntry[] {
  if (raw === null || raw.length === 0) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as TaxBreakdownEntry[]) : [];
}

function lineInput(
  line: LocalDocumentLine | NewDocumentLine,
): DocumentLineInput {
  return {
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountType: line.discountType ?? null,
    discountPercent: line.discountPercent ?? null,
    discountAmount: line.discountAmount ?? null,
    taxRate: line.taxRate ?? null,
    taxName: line.taxName ?? null,
  };
}

export class DocumentRepository {
  private readonly driver: SqlDriver;
  private readonly outbox: LocalOutbox;
  private readonly requireTenant: (tenantId: string) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    driver: SqlDriver,
    outbox: LocalOutbox,
    options: {
      requireTenant: (tenantId: string) => void;
      now?: () => Date;
      newId?: () => string;
    },
  ) {
    this.driver = driver;
    this.outbox = outbox;
    this.requireTenant = options.requireTenant;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? newUuid;
  }

  async createDraft(input: NewDocumentDraft): Promise<DocumentWithLines> {
    this.requireTenant(input.tenantId);
    if (input.lines.length === 0) {
      throw new Error(
        "A draft with no lines would be an empty document; add a line first",
      );
    }

    const id = input.id ?? this.newId();
    const timestamp = this.now().toISOString();
    const calculation = calculateDocument({
      // `lineInput` is the same conversion the update path uses: an absent
      // discount or tax becomes an explicit `null`, which is what the shared
      // engine's `DocumentLineInput` expects under
      // `exactOptionalPropertyTypes`. Spreading `?? undefined` here would make
      // "not specified" and "specified as none" different things to the engine,
      // and they are not.
      lines: input.lines.map((line) => lineInput(line)),
    });

    await this.driver.transaction(async () => {
      await this.driver.run(
        `INSERT INTO document (${DOCUMENT_COLUMNS})
         VALUES (?,?,?,'DRAFT',NULL,?,?,?,NULL,NULL,
                 ?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,
                 ?,?,?,?,?,?,?,?,?,NULL,
                 ?,?,'local',NULL,NULL,0,NULL)`,
        [
          id,
          input.tenantId,
          input.type,
          input.currency ?? "KES",
          input.contactId ?? null,
          input.sourceDocumentId ?? null,
          input.issueDate ?? timestamp,
          input.dueDate ?? null,
          input.expiryDate ?? null,
          input.deliveryDate ?? null,
          input.deliveryNote ?? null,
          input.customerNote ?? null,
          input.terms ?? null,
          calculation.subtotal,
          calculation.totalDiscount,
          calculation.taxableBase,
          calculation.taxTotal,
          calculation.total,
          JSON.stringify(calculation.taxBreakdown),
          DOCUMENT_ROUNDING_POLICY,
          timestamp,
          timestamp,
        ],
      );

      for (const [index, line] of input.lines.entries()) {
        const computed = calculation.lines[index];
        if (!computed) throw new Error(`Line ${index + 1} was not computed`);
        await this.insertLine({
          id: line.id ?? this.newId(),
          tenantId: input.tenantId,
          documentId: id,
          position: index + 1,
          line,
          computed,
          timestamp,
          syncState: "local",
        });
      }

      const created = await this.get(id, input.tenantId);
      if (!created) throw new Error(`Draft ${id} was not written`);
      await this.outbox.enqueue({
        tenantId: input.tenantId,
        entity: "document",
        entityId: id,
        type: "document.draft.create",
        payload: draftPayload(created),
      });
    });

    const persisted = await this.get(id, input.tenantId);
    if (!persisted) throw new Error(`Draft ${id} vanished after commit`);
    return persisted;
  }

  /**
   * Edits a draft header and replaces its lines in one step.
   *
   * Lines travel as a whole set rather than as individual operations: the
   * server's draft update does the same, and it means the ordering problem
   * ("a line operation ahead of its document operation") cannot arise at all.
   */
  async updateDraft(
    tenantId: string,
    id: string,
    patch: { header?: DraftPatch; lines?: readonly NewDocumentLine[] },
  ): Promise<DocumentWithLines> {
    this.requireTenant(tenantId);
    const existing = await this.get(id, tenantId);
    if (!existing) {
      throw new Error(
        `Draft ${id} is not in this workspace, or belongs to another tenant`,
      );
    }
    if (!isEditable(existing.status)) {
      throw new Error(
        `${existing.type} ${existing.reference ?? existing.id} is ${existing.status}. ` +
          `Issued documents are immutable; void it or raise a replacement instead.`,
      );
    }
    if (existing.syncState === "conflict") {
      throw new Error(
        `Draft ${id} has an unresolved conflict; resolve it before editing`,
      );
    }

    const timestamp = this.now().toISOString();
    const lines = patch.lines ?? existing.lines;
    if (lines.length === 0) {
      throw new Error("A document must keep at least one line");
    }

    const calculation = calculateDocument({ lines: lines.map(asLineInput) });
    const header = { ...existing, ...compact(patch.header ?? {}) };

    await this.driver.transaction(async () => {
      await this.driver.run(
        `UPDATE document
            SET contact_id = ?, currency = ?, issue_date = ?, due_date = ?, expiry_date = ?,
                delivery_date = ?, delivery_note = ?, customer_note = ?, terms = ?,
                subtotal = ?, total_discount = ?, taxable_base = ?, tax_total = ?, total = ?,
                tax_breakdown = ?, rounding_policy = ?, updated_at = ?,
                sync_state = 'pending', last_error = NULL
          WHERE id = ? AND tenant_id = ? AND status = 'DRAFT'`,
        [
          header.contactId,
          header.currency,
          header.issueDate,
          header.dueDate,
          header.expiryDate,
          header.deliveryDate,
          header.deliveryNote,
          header.customerNote,
          header.terms,
          calculation.subtotal,
          calculation.totalDiscount,
          calculation.taxableBase,
          calculation.taxTotal,
          calculation.total,
          JSON.stringify(calculation.taxBreakdown),
          DOCUMENT_ROUNDING_POLICY,
          timestamp,
          id,
          tenantId,
        ],
      );

      await this.driver.run(
        `UPDATE document_line SET deleted = 1, updated_at = ?
          WHERE document_id = ? AND tenant_id = ? AND deleted = 0`,
        [timestamp, id, tenantId],
      );

      for (const [index, line] of lines.entries()) {
        const computed = calculation.lines[index];
        if (!computed) throw new Error(`Line ${index + 1} was not computed`);
        await this.insertLine({
          id: line.id ?? this.newId(),
          tenantId,
          documentId: id,
          position: index + 1,
          line,
          computed,
          timestamp,
          syncState: "pending",
        });
      }

      const updated = await this.get(id, tenantId);
      if (!updated) throw new Error(`Draft ${id} vanished mid-update`);
      await this.outbox.enqueue({
        tenantId,
        entity: "document",
        entityId: id,
        type: "document.draft.update",
        payload: draftPayload(updated),
        ...(existing.baseRevision === null
          ? {}
          : { baseRevision: existing.baseRevision }),
      });
    });

    const persisted = await this.get(id, tenantId);
    if (!persisted) throw new Error(`Draft ${id} vanished after the update`);
    return persisted;
  }

  /**
   * Queues an issuance command. **Nothing here sets a number or an issue date**:
   * the server allocates the number inside its issuance transaction and the
   * pull brings it back, so an offline draft can never claim a number it was
   * not given. Until then the row is shown as `LOCAL-…` and the UI says
   * "unsynchronized".
   */
  async requestIssuance(
    tenantId: string,
    id: string,
    options: { expectedNumber?: string; issuedById?: string } = {},
  ): Promise<string> {
    this.requireTenant(tenantId);
    const document = await this.get(id, tenantId);
    if (!document) throw new Error(`Document ${id} is not in this workspace`);
    if (!isEditable(document.status)) {
      throw new Error(
        `${document.reference ?? id} is already ${document.status}`,
      );
    }

    return this.driver.transaction(async () => {
      const operation = await this.outbox.enqueue({
        tenantId,
        entity: "document",
        entityId: id,
        type: "document.issue",
        payload: {
          id,
          // A preview the user saw, sent so the server can refuse if the series
          // has moved on — never treated as the allocated number.
          ...(options.expectedNumber === undefined
            ? {}
            : { expectedNumber: options.expectedNumber }),
          ...(options.issuedById === undefined
            ? {}
            : { issuedById: options.issuedById }),
        },
        ...(document.baseRevision === null
          ? {}
          : { baseRevision: document.baseRevision }),
      });
      await this.driver.run(
        `UPDATE document SET sync_state = 'pending', last_error = NULL
          WHERE id = ? AND tenant_id = ?`,
        [id, tenantId],
      );
      return operation.id;
    });
  }

  /** Payments, voids, status transitions and conversions are server commands. */
  async requestCommand(
    tenantId: string,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    this.requireTenant(tenantId);
    const document = await this.get(id, tenantId);
    if (!document) throw new Error(`Document ${id} is not in this workspace`);

    return this.driver.transaction(async () => {
      const operation = await this.outbox.enqueue({
        tenantId,
        entity: "document",
        entityId: id,
        type,
        payload: { documentId: id, ...payload },
        ...(document.baseRevision === null
          ? {}
          : { baseRevision: document.baseRevision }),
      });
      return operation.id;
    });
  }

  /** The reference to show. Derived, never stored — see `ids.ts`. */
  reference(id: string): string {
    return localReference(id);
  }

  async get(id: string, tenantId: string): Promise<DocumentWithLines | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM document WHERE id = ? AND tenant_id = ? AND deleted = 0`,
      [id, tenantId],
    );
    if (!row) return null;
    const document = documentFrom(row);
    return {
      ...document,
      lines: await this.lines(id),
      taxBreakdown: parseBreakdown(cellString(row, "tax_breakdown")),
      reference: document.number ?? localReference(document.id),
    };
  }

  async lines(documentId: string): Promise<LocalDocumentLine[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT ${LINE_COLUMNS} FROM document_line
        WHERE document_id = ? AND deleted = 0
        ORDER BY position ASC, id ASC`,
      [documentId],
    );
    return rows.map(lineFrom);
  }

  async payments(documentId: string): Promise<LocalDocumentPayment[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT id, tenant_id, document_id, amount, occurred_on, method, reference, note,
              reversed_at, reversed_by, created_at, updated_at, sync_state,
              server_updated_at, base_revision, deleted
         FROM document_payment
        WHERE document_id = ? AND deleted = 0
        ORDER BY occurred_on ASC, created_at ASC, id ASC`,
      [documentId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      documentId: String(row.document_id),
      amount: cellDecimal(row, "amount"),
      occurredOn: String(row.occurred_on),
      method: String(row.method),
      reference: cellString(row, "reference"),
      note: cellString(row, "note"),
      reversedAt: cellString(row, "reversed_at"),
    }));
  }

  /**
   * What is still owed, from the payments the **server** recorded.
   *
   * An offline device shows the balance as of its last exchange and labels it
   * stale; it never invents a payment, so it never reports an invoice as paid
   * because somebody typed a number locally.
   */
  async balance(
    document: DocumentWithLines,
  ): Promise<{ paid: string; outstanding: string }> {
    const settled = (await this.payments(document.id))
      .filter((payment) => payment.reversedAt === null)
      .map((payment) => payment.amount);
    const paid = sumDecimalStrings(settled);
    return { paid, outstanding: outstandingBalance(document.total, paid) };
  }

  async list(
    tenantId: string,
    options: DocumentListOptions = {},
  ): Promise<LocalDocument[]> {
    const where: string[] = [`tenant_id = ?`, `deleted = 0`];
    const params: SqlValue[] = [tenantId];

    for (const [column, value] of [
      ["type", options.type],
      ["status", options.status],
      ["contact_id", options.contactId],
      ["sync_state", options.syncState],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (options.search && options.search.trim().length > 0) {
      where.push(
        `(number LIKE ? ESCAPE '\\' OR customer_note LIKE ? ESCAPE '\\')`,
      );
      const pattern = `%${options.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(pattern, pattern);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = await this.driver.all<SqlRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM document
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(documentFrom);
  }

  /** Unsettled drafts and queued commands — what the "waiting to sync" screen reads. */
  async unsynchronizedCount(tenantId: string): Promise<number> {
    const row = await this.driver.get<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM document
        WHERE tenant_id = ? AND deleted = 0 AND sync_state IN ('local','pending','rejected','conflict')`,
      [tenantId],
    );
    return Math.trunc(Number(row?.count ?? 0));
  }

  /**
   * Stores the snapshot the server froze at issuance, and nothing else. The
   * local PDF render reads from here, which is why a re-issued document cannot
   * change an already-printed one.
   */
  async saveSnapshot(input: {
    documentId: string;
    snapshot: unknown;
    snapshotAt: string | null;
  }): Promise<void> {
    await this.driver.run(
      `INSERT INTO document_snapshot (document_id, snapshot, snapshot_at)
       VALUES (?,?,?)
       ON CONFLICT(document_id) DO UPDATE SET
         snapshot = excluded.snapshot, snapshot_at = excluded.snapshot_at`,
      [input.documentId, JSON.stringify(input.snapshot), input.snapshotAt],
    );
  }

  async snapshot(documentId: string): Promise<unknown | null> {
    const row = await this.driver.get<{ snapshot: string }>(
      `SELECT snapshot FROM document_snapshot WHERE document_id = ?`,
      [documentId],
    );
    return row ? JSON.parse(row.snapshot) : null;
  }

  /**
   * Records a locally rendered PDF. The path is device-local, the file is
   * marked by its provenance (a preview of an unsynchronized draft, or a render
   * of a frozen snapshot), and the document is a commercial document — never a
   * tax invoice (constitution), which is why no path here claims otherwise.
   */
  async recordLocalRender(input: {
    documentId: string;
    path: string;
    generatedAt: string;
  }): Promise<void> {
    await this.driver.run(
      `INSERT INTO document_snapshot (document_id, snapshot, local_pdf_path, local_pdf_generated)
       VALUES (?,'{}',?,?)
       ON CONFLICT(document_id) DO UPDATE SET
         local_pdf_path = excluded.local_pdf_path,
         local_pdf_generated = excluded.local_pdf_generated`,
      [input.documentId, input.path, input.generatedAt],
    );
  }

  async renderMetadata(
    documentId: string,
  ): Promise<{ path: string; generatedAt: string } | null> {
    const row = await this.driver.get<{
      local_pdf_path: string | null;
      local_pdf_generated: string | null;
    }>(
      `SELECT local_pdf_path, local_pdf_generated FROM document_snapshot WHERE document_id = ?`,
      [documentId],
    );
    if (!row?.local_pdf_path || !row.local_pdf_generated) return null;
    return { path: row.local_pdf_path, generatedAt: row.local_pdf_generated };
  }

  // ── Pull appliers ────────────────────────────────────────────────────────

  async applyPull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const timestamp = this.now().toISOString();

    if (frame.deleted) {
      await this.driver.run(
        `UPDATE document SET deleted = 1, updated_at = ?, sync_state = 'synced',
                             server_updated_at = ?, base_revision = ?
          WHERE id = ? AND tenant_id = ?`,
        [timestamp, frame.updatedAt, frame.revision, frame.id, tenantId],
      );
      return;
    }

    const type = enumField(frame, "type", DOCUMENT_TYPES);
    const status = enumField(frame, "status", DOCUMENT_STATUSES, "DRAFT");
    if (!type) throw new Error(`Document frame ${frame.id} has no type`);

    // A number arriving from the server is the whole point of the exchange: it
    // is the reference the server allocated inside its issuance transaction.
    // What must never arrive in this column is the device's own placeholder —
    // that would mean the local `LOCAL-…` label had been fed back as if it were
    // official, which is exactly the claim §4 forbids.
    const number = textField(frame, "number");
    if (number !== null && isLocalReference(number)) {
      throw new Error(
        `Document frame ${frame.id} carries a local reference as its number; refused`,
      );
    }

    const values: SqlValue[] = [
      type,
      status,
      number,
      textField(frame, "currency") ?? "KES",
      textField(frame, "contactId"),
      textField(frame, "sourceDocumentId"),
      textField(frame, "replacementOfId"),
      textField(frame, "idempotencyKey"),
      timestampField(frame, "issueDate", { required: true }),
      timestampField(frame, "dueDate"),
      timestampField(frame, "expiryDate"),
      timestampField(frame, "deliveryDate"),
      textField(frame, "deliveryNote"),
      timestampField(frame, "issuedAt"),
      textField(frame, "issuedById"),
      timestampField(frame, "voidedAt"),
      textField(frame, "voidReason"),
      textField(frame, "voidedById"),
      textField(frame, "customerNote"),
      textField(frame, "terms"),
      decimalField(frame, "subtotal", "0.0000"),
      decimalField(frame, "totalDiscount", "0.0000"),
      decimalField(frame, "taxableBase", "0.0000"),
      decimalField(frame, "taxTotal", "0.0000"),
      decimalField(frame, "total", "0.0000"),
      jsonField(frame, "taxBreakdown"),
      textField(frame, "roundingPolicy") ?? DOCUMENT_ROUNDING_POLICY,
      timestampField(frame, "snapshotAt"),
      timestampField(frame, "createdAt") ?? frame.updatedAt,
      frame.updatedAt,
      "synced",
      frame.updatedAt,
      frame.revision,
    ];

    const columns = DOCUMENT_COLUMNS.split(",").map((name) => name.trim());
    const setClause = columns
      .filter(
        (name) =>
          name !== "id" && name !== "tenant_id" && name !== "last_error",
      )
      .map((name) => `${name} = excluded.${name}`)
      .join(", ");

    await this.driver.run(
      `INSERT INTO document (${DOCUMENT_COLUMNS})
       VALUES (${["?", "?", ...values.map(() => "?"), "0", "NULL"].join(",")})
       ON CONFLICT(id) DO UPDATE SET ${setClause}, last_error = NULL`,
      [frame.id, tenantId, ...values],
    );
  }

  async applyLinePull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const timestamp = this.now().toISOString();
    const documentId = textField(frame, "documentId", { required: true });
    if (!documentId) throw new Error(`Line frame ${frame.id} has no document`);

    if (frame.deleted) {
      await this.driver.run(
        `UPDATE document_line SET deleted = 1, updated_at = ?, sync_state = 'synced',
                                  server_updated_at = ?, base_revision = ?
          WHERE id = ? AND tenant_id = ?`,
        [timestamp, frame.updatedAt, frame.revision, frame.id, tenantId],
      );
      return;
    }

    const exists = await readRowState(this.driver, "document_line", frame.id);
    const values: SqlValue[] = [
      tenantId,
      documentId,
      intField(frame, "position", 1),
      textField(frame, "itemId"),
      textField(frame, "sourceLineId"),
      textField(frame, "description", { required: true }),
      textField(frame, "itemCode"),
      textField(frame, "unitOfMeasure") ?? "each",
      decimalField(frame, "quantity", "0.0000"),
      decimalField(frame, "unitPrice", "0.0000"),
      enumField(frame, "discountType", ["PERCENT", "AMOUNT"] as const, null),
      decimalField(frame, "discountPercent", "0.00"),
      decimalField(frame, "discountAmount", "0.0000"),
      decimalField(frame, "lineTotal", "0.0000"),
      decimalField(frame, "lineDiscount", "0.0000"),
      decimalField(frame, "lineNet", "0.0000"),
      decimalField(frame, "lineTax", "0.0000"),
      textField(frame, "taxRateId"),
      textField(frame, "taxName"),
      decimalField(frame, "taxRate", "0.0000"),
      decimalField(frame, "deliveredQuantity", "0.0000"),
      timestampField(frame, "createdAt") ?? frame.updatedAt,
      frame.updatedAt,
      "synced",
      frame.updatedAt,
      frame.revision,
      0,
    ];

    if (exists) {
      await this.driver.run(
        `UPDATE document_line
            SET tenant_id = ?, document_id = ?, position = ?, item_id = ?, source_line_id = ?,
                description = ?, item_code = ?, unit_of_measure = ?, quantity = ?, unit_price = ?,
                discount_type = ?, discount_percent = ?, discount_amount = ?, line_total = ?,
                line_discount = ?, line_net = ?, line_tax = ?, tax_rate_id = ?, tax_name = ?,
                tax_rate = ?, delivered_quantity = ?, created_at = ?, updated_at = ?,
                sync_state = ?, server_updated_at = ?, base_revision = ?, deleted = ?
          WHERE id = ?`,
        [...values, frame.id],
      );
      return;
    }

    await this.driver.run(
      `INSERT INTO document_line (id, ${LINE_COLUMNS})
       VALUES (?,${values.map(() => "?").join(",")})`,
      [frame.id, ...values],
    );
  }

  async applyPaymentPull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const documentId = textField(frame, "documentId", { required: true });
    if (!documentId)
      throw new Error(`Payment frame ${frame.id} has no document`);

    await this.driver.run(
      `INSERT INTO document_payment (id, tenant_id, document_id, amount, occurred_on, method,
                                     reference, note, reversed_at, reversed_by, created_at,
                                     updated_at, sync_state, server_updated_at, base_revision,
                                     deleted, last_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'synced', ?,?,0,NULL)
       ON CONFLICT(id) DO UPDATE SET
         amount = excluded.amount, occurred_on = excluded.occurred_on, method = excluded.method,
         reference = excluded.reference, note = excluded.note, reversed_at = excluded.reversed_at,
         reversed_by = excluded.reversed_by, updated_at = excluded.updated_at,
         server_updated_at = excluded.server_updated_at, base_revision = excluded.base_revision,
         deleted = excluded.deleted`,
      [
        frame.id,
        tenantId,
        documentId,
        decimalField(frame, "amount", "0.0000"),
        timestampField(frame, "occurredOn", { required: true }),
        textField(frame, "method") ?? "BANK_TRANSFER",
        textField(frame, "reference"),
        textField(frame, "note"),
        timestampField(frame, "reversedAt"),
        textField(frame, "reversedBy"),
        timestampField(frame, "createdAt") ?? frame.updatedAt,
        frame.updatedAt,
        frame.updatedAt,
        frame.revision,
      ],
    );
  }

  /**
   * Status events arrive append-only, exactly as the server's trigger enforces
   * them. The local triggers refuse an UPDATE or DELETE, so a device cannot
   * rewrite the history it was shown.
   */
  async applyStatusEventPull(
    frame: PullFrame,
    tenantId: string,
  ): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const documentId = textField(frame, "documentId", { required: true });
    if (!documentId)
      throw new Error(`Status event ${frame.id} has no document`);

    const existing = await this.driver.get<{ id: string }>(
      `SELECT id FROM document_status_event WHERE id = ?`,
      [frame.id],
    );
    if (existing) return;

    await this.driver.run(
      `INSERT INTO document_status_event (id, tenant_id, document_id, from_status, to_status,
                                          reason, actor_id, created_at, sync_state)
       VALUES (?,?,?,?,?,?,?,?, 'synced')`,
      [
        frame.id,
        tenantId,
        documentId,
        enumField(frame, "fromStatus", DOCUMENT_STATUSES, null),
        enumField(frame, "toStatus", DOCUMENT_STATUSES, "DRAFT"),
        textField(frame, "reason"),
        textField(frame, "actorId"),
        timestampField(frame, "createdAt", { required: true }),
      ],
    );
  }

  /** Server rows the device may not keep after a tombstone or a re-provision. */
  async applySnapshotPull(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const documentId = textField(frame, "documentId", { required: true });
    if (!documentId)
      throw new Error(`Snapshot frame ${frame.id} has no document`);
    const snapshot = jsonField(frame, "snapshot");
    if (snapshot === null)
      throw new Error(`Snapshot frame ${frame.id} is empty`);

    await this.saveSnapshot({
      documentId,
      snapshot: JSON.parse(snapshot),
      snapshotAt: timestampField(frame, "snapshotAt") ?? frame.updatedAt,
    });
  }

  private async insertLine(input: {
    id: string;
    tenantId: string;
    documentId: string;
    position: number;
    line: NewDocumentLine;
    computed: {
      lineTotal: string;
      lineDiscount: string;
      lineNet: string;
      lineTax: string;
    };
    timestamp: string;
    syncState: SyncState;
  }): Promise<void> {
    await this.driver.run(
      `INSERT INTO document_line (${LINE_COLUMNS})
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.id,
        input.tenantId,
        input.documentId,
        input.position,
        input.line.itemId ?? null,
        null,
        input.line.description,
        input.line.itemCode ?? null,
        input.line.unitOfMeasure ?? "each",
        input.line.quantity,
        input.line.unitPrice,
        input.line.discountType ?? null,
        input.line.discountPercent ?? "0.00",
        input.line.discountAmount ?? "0.0000",
        input.computed.lineTotal,
        input.computed.lineDiscount,
        input.computed.lineNet,
        input.computed.lineTax,
        input.line.taxRateId ?? null,
        input.line.taxName ?? null,
        input.line.taxRate ?? "0.0000",
        "0.0000",
        input.timestamp,
        input.timestamp,
        input.syncState,
        null,
        null,
        0,
      ],
    );
  }
}

/** What the server's draft schema reads. No tenantId, no number, no status. */
function draftPayload(document: DocumentWithLines): Record<string, unknown> {
  return {
    id: document.id,
    type: document.type,
    currency: document.currency,
    contactId: document.contactId,
    sourceDocumentId: document.sourceDocumentId,
    issueDate: document.issueDate,
    dueDate: document.dueDate,
    expiryDate: document.expiryDate,
    deliveryDate: document.deliveryDate,
    deliveryNote: document.deliveryNote,
    customerNote: document.customerNote,
    terms: document.terms,
    lines: document.lines.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      description: line.description,
      itemCode: line.itemCode,
      unitOfMeasure: line.unitOfMeasure,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discountPercent: line.discountPercent,
      discountAmount: line.discountAmount,
      taxRateId: line.taxRateId,
      taxName: line.taxName,
      taxRate: line.taxRate,
    })),
  };
}

function asLineInput(
  line: LocalDocumentLine | NewDocumentLine,
): DocumentLineInput {
  return lineInput(line);
}

function compact<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}
