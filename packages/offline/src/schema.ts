/**
 * The local schema, as ordered migrations.
 *
 * Three deliberate choices:
 *
 * 1. **Statements are arrays, not one script.** Each entry is a single SQLite
 *    statement. `node:sqlite`, Capacitor's native plugin and Tauri's SQL plugin
 *    all run one statement reliably; multi-statement strings are where those
 *    three drivers disagree, and a migration that half-applies on a phone is
 *    exactly the failure this phase is meant to prevent.
 * 2. **The checksum covers the canonical JSON of the statements.** Editing a
 *    statement in a released migration changes its checksum, and the migrator
 *    refuses to open a database whose recorded history no longer matches. That
 *    is what makes the migration list append-only in practice.
 * 3. **Constraints, not conventions.** The rules the directive cares about —
 *    an unsynchronized document has no number, a status event is append-only,
 *    a tenant is never shared between rows — are CHECK constraints and unique
 *    indexes, so a future code path that forgets the rule fails at the
 *    database instead of shipping a wrong document.
 *
 * The shape mirrors `apps/web/prisma/schema.prisma`:
 *
 *   - Timestamps are ISO-8601 UTC **TEXT** (`2026-10-15T07:04:00.000Z`).
 *     `TEXT` has no collation surprises, round-trips through every driver, and
 *     compares correctly with `>=` for the `(updated_at, id)` cursor, which is
 *     how a pull resumes after interruption.
 *   - Money, quantities and rates are decimal **TEXT** at the server's scale
 *     (`numeric(18,4)` → `"1234.5600"`). SQLite's REAL is a binary float, and a
 *     total that only closes after rounding is the bug the document engine
 *     exists to avoid — so the local store keeps the server's representation
 *     and `@amisibiz/documents`' decimal-string arithmetic operates on it
 *     unchanged.
 *   - UUIDs are TEXT and are generated on the device (`ids.ts`), so a retried
 *    create cannot mint a second row.
 *
 * Every mirrored table carries the same synchronization tail: `sync_state`,
 * `server_updated_at`, `base_revision`, `deleted`, `last_error`.
 */

import type { Migration } from "./migrate";

const SYNC_STATE_CHECK = `CHECK (sync_state IN ('local','pending','synced','rejected','conflict'))`;
const NOT_DELETED = `CHECK (deleted IN (0,1))`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "meta_and_provisioning",
    statements: [
      `-- Applied migrations. A row here is a promise that the schema matches
      -- these exact statements; the migrator compares the checksum before
      -- opening the database and refuses on a mismatch.
      CREATE TABLE amisibiz_schema_version (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        checksum   TEXT    NOT NULL,
        applied_at TEXT    NOT NULL
      )`,
      `-- Device-local facts: installation id, the session the data belongs to,
      -- the cached authorization and its expiry, the schema version. Nothing in
      -- here is authority for the server; it is what the client may show while
      -- disconnected, and how it decides that it may not.
      CREATE TABLE local_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT NOT NULL
      )`,
      `-- The authorized tenant's own display facts, pulled from the server.
      -- Never edited locally: activation, currency and locale are the server's.
      CREATE TABLE tenant_profile (
        tenant_id         TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        slug              TEXT NOT NULL,
        status            TEXT NOT NULL
                          CHECK (status IN ('PENDING','ACTIVE','SUSPENDED')),
        country           TEXT,
        currency          TEXT NOT NULL DEFAULT 'KES',
        timezone          TEXT NOT NULL DEFAULT 'UTC',
        locale            TEXT NOT NULL DEFAULT 'en',
        plan_name         TEXT,
        activated_at      TEXT,
        suspended_at      TEXT,
        suspension_reason TEXT,
        server_updated_at TEXT,
        synced_at         TEXT
      )`,
      `-- Branding for the tenant's own documents. Colours are what an offline
      -- PDF can render; the logo needs the network, so it is stored as a URL and
      -- omitted from an offline render rather than cached unverified.
      CREATE TABLE tenant_branding (
        tenant_id             TEXT PRIMARY KEY,
        display_name          TEXT,
        registered_name       TEXT,
        primary_color         TEXT NOT NULL DEFAULT '#1d4ed8',
        secondary_color       TEXT NOT NULL DEFAULT '#1e3a5f',
        accent_color          TEXT NOT NULL DEFAULT '#f59e0b',
        primary_foreground    TEXT NOT NULL DEFAULT '#f8fafc',
        logo_url              TEXT,
        contact_email         TEXT,
        contact_phone         TEXT,
        postal_address        TEXT,
        physical_address      TEXT,
        website               TEXT,
        tax_pin               TEXT,
        currency              TEXT NOT NULL DEFAULT 'KES',
        default_footer        TEXT,
        payment_instructions  TEXT,
        document_layout       TEXT NOT NULL DEFAULT 'standard',
        server_updated_at     TEXT,
        synced_at             TEXT
      )`,
      `-- Numbering SETTINGS are pull-only configuration. "next_value" is what the
      -- server's sequence row said at the last pull and may only be shown as a
      -- preview; allocation happens under FOR UPDATE on the server and nowhere
      -- else, which is why an offline draft cannot have a real number.
      CREATE TABLE document_numbering (
        tenant_id          TEXT NOT NULL,
        type               TEXT NOT NULL
                           CHECK (type IN ('QUOTATION','INVOICE','DELIVERY_NOTE')),
        prefix             TEXT NOT NULL DEFAULT '',
        padding            INTEGER NOT NULL DEFAULT 4,
        separator          TEXT NOT NULL DEFAULT '-',
        period_style       TEXT NOT NULL DEFAULT 'CALENDAR_YEAR'
                           CHECK (period_style IN ('NONE','CALENDAR_YEAR','FINANCIAL_YEAR')),
        fiscal_start_month INTEGER NOT NULL DEFAULT 1,
        next_value         INTEGER NOT NULL DEFAULT 1,
        server_updated_at  TEXT,
        synced_at          TEXT,
        PRIMARY KEY (tenant_id, type)
      )`,
      `-- Records only what actually happened. A failed exchange leaves the
      -- cursor where it was, so the next pull resumes from the last position the
      -- server confirmed rather than from a guess.
      CREATE TABLE sync_checkpoint (
        tenant_id    TEXT PRIMARY KEY,
        cursor       TEXT,
        last_push_at TEXT,
        last_pull_at TEXT,
        last_error   TEXT,
        server_time  TEXT,
        updated_at   TEXT NOT NULL
      )`,
      `-- Both revisions of a conflicted row, kept until the user chooses. The
      -- client never resolves a conflict by silently overwriting either side.
      CREATE TABLE conflict (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        operation_id    TEXT NOT NULL,
        entity          TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        server_revision INTEGER NOT NULL,
        base_revision   INTEGER,
        server_snapshot TEXT,
        local_payload   TEXT NOT NULL,
        detected_at     TEXT NOT NULL,
        resolved_at     TEXT,
        resolution      TEXT
                        CHECK (resolution IN ('kept_server','reapplied_local','discarded')),
        UNIQUE (tenant_id, operation_id)
      )`,
    ],
  },
  {
    version: 2,
    name: "contacts",
    statements: [
      `CREATE TABLE contact (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        type              TEXT NOT NULL DEFAULT 'INDIVIDUAL'
                          CHECK (type IN ('INDIVIDUAL','BUSINESS')),
        status            TEXT NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','ARCHIVED')),
        first_name        TEXT,
        last_name         TEXT,
        company_name      TEXT,
        email             TEXT,
        phone             TEXT,
        mobile            TEXT,
        tax_pin           TEXT,
        notes             TEXT,
        portal_user_id    TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        archived_at       TEXT,
        sync_state        TEXT NOT NULL,
        server_updated_at TEXT,
        base_revision     INTEGER,
        deleted           INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        ${SYNC_STATE_CHECK},
        ${NOT_DELETED}
      )`,
      `CREATE INDEX contact_tenant_state ON contact (tenant_id, sync_state)`,
      `CREATE INDEX contact_tenant_updated ON contact (tenant_id, updated_at, id)`,
      `CREATE INDEX contact_tenant_name ON contact (tenant_id, company_name, last_name)`,
      `-- Addresses belong to a contact. A local contact and its addresses are
      -- ONE outbox operation, so no address can outlive the row that owns it.
      CREATE TABLE contact_address (
        id                TEXT PRIMARY KEY,
        contact_id        TEXT NOT NULL,
        type              TEXT NOT NULL CHECK (type IN ('POSTAL','PHYSICAL')),
        line1             TEXT NOT NULL,
        line2             TEXT,
        city              TEXT,
        state             TEXT,
        postal_code       TEXT,
        country           TEXT,
        is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        sync_state        TEXT NOT NULL,
        server_updated_at TEXT,
        base_revision     INTEGER,
        deleted           INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        ${SYNC_STATE_CHECK},
        ${NOT_DELETED}
      )`,
      `CREATE INDEX contact_address_contact ON contact_address (contact_id)`,
    ],
  },
  {
    version: 3,
    name: "catalogue",
    statements: [
      `-- Tax configuration is pull-only: an offline device must not invent a
      -- rate, because tax printed on a document is a claim about the real world.
      CREATE TABLE tax_category (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        name              TEXT NOT NULL,
        description       TEXT,
        is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        server_updated_at TEXT,
        synced_at         TEXT,
        deleted           INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1))
      )`,
      `CREATE UNIQUE INDEX tax_category_tenant_name
         ON tax_category (tenant_id, name) WHERE deleted = 0`,
      `CREATE TABLE tax_rate (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        category_id       TEXT NOT NULL,
        name              TEXT NOT NULL,
        rate              TEXT NOT NULL,
        effective_from    TEXT NOT NULL,
        effective_to      TEXT,
        is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        server_updated_at TEXT,
        synced_at         TEXT,
        deleted           INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1))
      )`,
      `CREATE INDEX tax_rate_tenant ON tax_rate (tenant_id, category_id)`,
      `CREATE TABLE item (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        type              TEXT NOT NULL DEFAULT 'PRODUCT'
                          CHECK (type IN ('PRODUCT','SERVICE')),
        status            TEXT NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','INACTIVE')),
        name              TEXT NOT NULL,
        sku               TEXT,
        description       TEXT,
        unit_of_measure   TEXT NOT NULL DEFAULT 'each',
        unit_price        TEXT NOT NULL,
        currency          TEXT NOT NULL DEFAULT 'KES',
        tax_rate_id       TEXT,
        notes             TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        sync_state        TEXT NOT NULL,
        server_updated_at TEXT,
        base_revision     INTEGER,
        deleted           INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        ${SYNC_STATE_CHECK},
        ${NOT_DELETED}
      )`,
      `-- The server's @@unique([tenantId, sku]); SQLite enforces it with a
      -- partial index because a deleted row must not block the code forever.
      CREATE UNIQUE INDEX item_tenant_sku ON item (tenant_id, sku)
         WHERE sku IS NOT NULL AND deleted = 0`,
      `CREATE INDEX item_tenant_name ON item (tenant_id, name)`,
      `CREATE INDEX item_tenant_state ON item (tenant_id, status, sync_state)`,
      `-- Customer-specific catalogue entries (custom code/name, agreed price,
      -- discount). Mirrored because a quotation for a known customer is priced
      -- from here while the device is offline.
      CREATE TABLE customer_price (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        contact_id        TEXT NOT NULL,
        item_id           TEXT NOT NULL,
        custom_code       TEXT,
        custom_name       TEXT,
        agreed_price      TEXT NOT NULL,
        discount_percent  TEXT NOT NULL DEFAULT '0.00',
        is_available      INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        sync_state        TEXT NOT NULL,
        server_updated_at TEXT,
        base_revision     INTEGER,
        deleted           INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        ${SYNC_STATE_CHECK},
        ${NOT_DELETED},
        UNIQUE (tenant_id, contact_id, item_id)
      )`,
      `CREATE INDEX customer_price_contact ON customer_price (tenant_id, contact_id)`,
    ],
  },
  {
    version: 4,
    name: "documents",
    statements: [
      `-- Local drafts and the last synchronized copy of issued documents.
      --
      -- The two CHECK constraints at the bottom encode the directive's rules
      -- rather than trusting the code above them: a row that has never reached
      -- the server cannot carry a document number, and cannot claim it was
      -- issued. If a future path tries to set either, the write fails here.
      CREATE TABLE document (
        id                 TEXT PRIMARY KEY,
        tenant_id          TEXT NOT NULL,
        type               TEXT NOT NULL
                           CHECK (type IN ('QUOTATION','INVOICE','DELIVERY_NOTE')),
        status             TEXT NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT','ISSUED','ACCEPTED','REJECTED',
                                             'EXPIRED','CANCELLED','PARTIALLY_PAID',
                                             'PAID','OVERDUE','VOID',
                                             'PARTIALLY_DELIVERED','DELIVERED')),
        number             TEXT,
        currency           TEXT NOT NULL DEFAULT 'KES',
        contact_id         TEXT,
        source_document_id TEXT,
        replacement_of_id  TEXT,
        idempotency_key    TEXT,
        issue_date         TEXT NOT NULL,
        due_date           TEXT,
        expiry_date        TEXT,
        delivery_date      TEXT,
        delivery_note      TEXT,
        issued_at          TEXT,
        issued_by_id       TEXT,
        voided_at          TEXT,
        void_reason        TEXT,
        voided_by_id       TEXT,
        customer_note      TEXT,
        terms              TEXT,
        subtotal           TEXT NOT NULL DEFAULT '0.0000',
        total_discount     TEXT NOT NULL DEFAULT '0.0000',
        taxable_base       TEXT NOT NULL DEFAULT '0.0000',
        tax_total          TEXT NOT NULL DEFAULT '0.0000',
        total              TEXT NOT NULL DEFAULT '0.0000',
        tax_breakdown      TEXT,
        rounding_policy    TEXT NOT NULL DEFAULT 'half-up-per-line-v1',
        snapshot_at        TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        sync_state         TEXT NOT NULL,
        server_updated_at  TEXT,
        base_revision      INTEGER,
        deleted            INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        ${SYNC_STATE_CHECK},
        ${NOT_DELETED},
        CHECK (number IS NULL OR sync_state <> 'local'),
        CHECK (issued_at IS NULL OR sync_state <> 'local')
      )`,
      `CREATE UNIQUE INDEX document_tenant_number ON document (tenant_id, type, number)
         WHERE number IS NOT NULL AND deleted = 0`,
      `CREATE UNIQUE INDEX document_tenant_idempotency ON document (tenant_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL AND deleted = 0`,
      `CREATE INDEX document_tenant_list ON document (tenant_id, type, status, updated_at, id)`,
      `CREATE INDEX document_tenant_contact ON document (tenant_id, contact_id)`,
      `CREATE TABLE document_line (
        id                  TEXT PRIMARY KEY,
        tenant_id           TEXT NOT NULL,
        document_id         TEXT NOT NULL,
        position            INTEGER NOT NULL,
        item_id             TEXT,
        source_line_id      TEXT,
        description         TEXT NOT NULL,
        item_code           TEXT,
        unit_of_measure     TEXT NOT NULL DEFAULT 'each',
        quantity            TEXT NOT NULL,
        unit_price          TEXT NOT NULL,
        discount_type       TEXT
                            CHECK (discount_type IS NULL
                                   OR discount_type IN ('PERCENT','AMOUNT')),
        discount_percent    TEXT NOT NULL DEFAULT '0.00',
        discount_amount     TEXT NOT NULL DEFAULT '0.0000',
        line_total          TEXT NOT NULL,
        line_discount       TEXT NOT NULL DEFAULT '0.0000',
        line_net            TEXT NOT NULL,
        line_tax            TEXT NOT NULL DEFAULT '0.0000',
        tax_rate_id         TEXT,
        tax_name            TEXT,
        tax_rate            TEXT NOT NULL DEFAULT '0.0000',
        delivered_quantity  TEXT NOT NULL DEFAULT '0.0000',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        sync_state          TEXT NOT NULL,
        server_updated_at   TEXT,
        base_revision       INTEGER,
        deleted             INTEGER NOT NULL DEFAULT 0,
        last_error          TEXT,
        ${SYNC_STATE_CHECK},
        ${NOT_DELETED},
        UNIQUE (tenant_id, document_id, position)
      )`,
      `CREATE INDEX document_line_document ON document_line (tenant_id, document_id)`,
      `-- Payments are facts about money the server has confirmed. An offline
      -- device never creates one; these rows arrive from a pull so that a
      -- synchronized invoice can show its real balance with no network.
      CREATE TABLE document_payment (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        document_id       TEXT NOT NULL,
        amount            TEXT NOT NULL,
        occurred_on       TEXT NOT NULL,
        method            TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
                          CHECK (method IN ('CASH','BANK_TRANSFER','MOBILE_MONEY',
                                            'CARD','CHEQUE','OTHER')),
        reference         TEXT,
        note              TEXT,
        reversed_at       TEXT,
        reversed_by       TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        sync_state        TEXT NOT NULL,
        server_updated_at TEXT,
        base_revision     INTEGER,
        deleted           INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        ${SYNC_STATE_CHECK},
        ${NOT_DELETED}
      )`,
      `CREATE INDEX document_payment_document ON document_payment (tenant_id, document_id)`,
      `CREATE TABLE document_status_event (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        document_id TEXT NOT NULL,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        reason      TEXT,
        actor_id    TEXT,
        created_at  TEXT NOT NULL,
        sync_state  TEXT NOT NULL DEFAULT 'synced',
        ${SYNC_STATE_CHECK}
      )`,
      `CREATE INDEX document_status_event_document
         ON document_status_event (tenant_id, document_id)`,
      `-- Append-only, mirroring the server's trigger of the same name. Editing a
      -- status event locally would be a fabricated audit trail.
      CREATE TRIGGER document_status_event_is_append_only
      BEFORE UPDATE ON document_status_event
      BEGIN
        SELECT RAISE(ABORT, 'document_status_event rows are append-only');
      END`,
      `CREATE TRIGGER document_status_event_no_delete
      BEFORE DELETE ON document_status_event
      BEGIN
        SELECT RAISE(ABORT, 'document_status_event rows are append-only');
      END`,
      `-- The frozen snapshot captured at issuance, stored apart because it is the
      -- largest column on the table and the only one a PDF render needs — list
      -- queries must not have to pull it. Also holds the local render cache
      -- metadata, which is device-local and never a server fact.
      CREATE TABLE document_snapshot (
        document_id         TEXT PRIMARY KEY,
        snapshot            TEXT NOT NULL,
        snapshot_at         TEXT,
        local_pdf_path      TEXT,
        local_pdf_generated TEXT
      )`,
    ],
  },
  {
    version: 5,
    name: "outbox",
    statements: [
      `-- The durable operation queue. This table is what makes "recover after
      -- interruption" a property of storage rather than a hope: a row here is
      -- written in the SAME transaction as the local change it represents, so
      -- there is no state where one exists without the other.
      CREATE TABLE outbox_operation (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        entity          TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        type            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        base_revision   INTEGER,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','in_flight','applied',
                                          'failed','conflict')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        -- Transactional claiming: a push stamps its batch with a generation
        -- token. Rows still carrying an OLDER generation at start-up are the
        -- ones the previous process never finished; they return to 'pending'
        -- and are re-sent under the SAME operation id, which is what makes the
        -- retry safe — the server's receipt store answers 'duplicate'.
        generation      TEXT,
        last_error      TEXT,
        rejected_reason TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        next_attempt_at TEXT,
        applied_at      TEXT,
        -- Monotonic per database, assigned inside the write transaction from
        -- max(seq) + 1. SQLite has no sequences, and the ordering rule only
        -- needs a counter that says "this came after that".
        seq             INTEGER NOT NULL
      )`,
      `CREATE INDEX outbox_claimable ON outbox_operation (status, next_attempt_at, seq)`,
      `CREATE INDEX outbox_entity ON outbox_operation (entity, entity_id)`,
      `CREATE INDEX outbox_tenant_status ON outbox_operation (tenant_id, status)`,
    ],
  },
];

/** The schema version this build of the package expects. */
export const CURRENT_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
