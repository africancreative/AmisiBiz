import type { SqlDriver } from "./driver";
import { cellBoolean, cellString, type SqlRow } from "./types";
import {
  DOCUMENT_TYPES,
  TENANT_STATUSES,
  type LocalDocumentType,
  type LocalTenantStatus,
} from "./constants";
import {
  assertFrameTenant,
  boolField,
  decimalField,
  enumField,
  intField,
  textField,
  timestampField,
  type PullFrame,
} from "./changes";

/**
 * The pull-only half of the local database: the facts the server owns and the
 * device only ever reads.
 *
 * There is no write API here on purpose. Tenant activation, currency, locale,
 * branding, numbering settings and tax rates are server facts; a client that
 * could edit them locally could print a document whose tax rate exists nowhere.
 * A pull overwrites these rows because the device has no competing version of
 * them — the "never overwrite silently" rule protects data the device can
 * change, and none of this is.
 */

export interface LocalTenantProfile {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: LocalTenantStatus;
  readonly country: string | null;
  readonly currency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly planName: string | null;
  readonly activatedAt: string | null;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  readonly serverUpdatedAt: string | null;
  readonly syncedAt: string | null;
}

export interface LocalTenantBranding {
  readonly tenantId: string;
  readonly displayName: string | null;
  readonly registeredName: string | null;
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly accentColor: string;
  readonly primaryForeground: string;
  readonly logoUrl: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly postalAddress: string | null;
  readonly physicalAddress: string | null;
  readonly website: string | null;
  readonly taxPin: string | null;
  readonly currency: string;
  readonly defaultFooter: string | null;
  readonly paymentInstructions: string | null;
  readonly documentLayout: string;
  readonly serverUpdatedAt: string | null;
  readonly syncedAt: string | null;
}

export interface LocalNumberingConfig {
  readonly tenantId: string;
  readonly type: LocalDocumentType;
  readonly prefix: string;
  readonly padding: number;
  readonly separator: string;
  readonly periodStyle: "NONE" | "CALENDAR_YEAR" | "FINANCIAL_YEAR";
  readonly fiscalStartMonth: number;
  /** The server's counter as of the last pull — preview material, never authority. */
  readonly nextValue: number;
  readonly serverUpdatedAt: string | null;
}

export interface LocalTaxCategory {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly updatedAt: string;
}

export interface LocalTaxRate {
  readonly id: string;
  readonly tenantId: string;
  readonly categoryId: string;
  readonly name: string;
  /** Decimal text, e.g. "0.1600" — the server's `numeric(5,4)`. */
  readonly rate: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
  readonly updatedAt: string;
}

const PERIOD_STYLES = ["NONE", "CALENDAR_YEAR", "FINANCIAL_YEAR"] as const;

function profileFrom(row: SqlRow): LocalTenantProfile {
  return {
    tenantId: String(row.tenant_id),
    name: String(row.name),
    slug: String(row.slug),
    status: String(row.status) as LocalTenantStatus,
    country: cellString(row, "country"),
    currency: String(row.currency),
    timezone: String(row.timezone),
    locale: String(row.locale),
    planName: cellString(row, "plan_name"),
    activatedAt: cellString(row, "activated_at"),
    suspendedAt: cellString(row, "suspended_at"),
    suspensionReason: cellString(row, "suspension_reason"),
    serverUpdatedAt: cellString(row, "server_updated_at"),
    syncedAt: cellString(row, "synced_at"),
  };
}

function brandingFrom(row: SqlRow): LocalTenantBranding {
  return {
    tenantId: String(row.tenant_id),
    displayName: cellString(row, "display_name"),
    registeredName: cellString(row, "registered_name"),
    primaryColor: String(row.primary_color),
    secondaryColor: String(row.secondary_color),
    accentColor: String(row.accent_color),
    primaryForeground: String(row.primary_foreground),
    logoUrl: cellString(row, "logo_url"),
    contactEmail: cellString(row, "contact_email"),
    contactPhone: cellString(row, "contact_phone"),
    postalAddress: cellString(row, "postal_address"),
    physicalAddress: cellString(row, "physical_address"),
    website: cellString(row, "website"),
    taxPin: cellString(row, "tax_pin"),
    currency: String(row.currency),
    defaultFooter: cellString(row, "default_footer"),
    paymentInstructions: cellString(row, "payment_instructions"),
    documentLayout: String(row.document_layout),
    serverUpdatedAt: cellString(row, "server_updated_at"),
    syncedAt: cellString(row, "synced_at"),
  };
}

export class ProvisioningRepository {
  private readonly driver: SqlDriver;
  private readonly now: () => Date;

  constructor(driver: SqlDriver, options: { now?: () => Date } = {}) {
    this.driver = driver;
    this.now = options.now ?? (() => new Date());
  }

  /** Applies a `tenant` frame. For this entity the frame id IS the tenant id. */
  async applyTenant(frame: PullFrame, tenantId: string): Promise<void> {
    if (frame.id !== tenantId) {
      throw new Error(
        `Tenant frame ${frame.id} does not match the tenant it was pulled for`,
      );
    }

    await this.driver.run(
      `INSERT INTO tenant_profile (tenant_id, name, slug, status, country, currency,
                                   timezone, locale, plan_name, activated_at, suspended_at,
                                   suspension_reason, server_updated_at, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         name = excluded.name, slug = excluded.slug, status = excluded.status,
         country = excluded.country, currency = excluded.currency,
         timezone = excluded.timezone, locale = excluded.locale,
         plan_name = excluded.plan_name, activated_at = excluded.activated_at,
         suspended_at = excluded.suspended_at,
         suspension_reason = excluded.suspension_reason,
         server_updated_at = excluded.server_updated_at, synced_at = excluded.synced_at`,
      [
        frame.id,
        textField(frame, "name", { required: true }),
        textField(frame, "slug", { required: true }),
        enumField(frame, "status", TENANT_STATUSES, "PENDING"),
        textField(frame, "country"),
        textField(frame, "currency") ?? "KES",
        textField(frame, "timezone") ?? "UTC",
        textField(frame, "locale") ?? "en",
        textField(frame, "planName"),
        timestampField(frame, "activatedAt"),
        timestampField(frame, "suspendedAt"),
        textField(frame, "suspensionReason"),
        frame.updatedAt,
        this.now().toISOString(),
      ],
    );
  }

  /** Keyed by tenant locally, so the branding row's own id is not used. */
  async applyBranding(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);

    await this.driver.run(
      `INSERT INTO tenant_branding (tenant_id, display_name, registered_name, primary_color,
                                    secondary_color, accent_color, primary_foreground, logo_url,
                                    contact_email, contact_phone, postal_address, physical_address,
                                    website, tax_pin, currency, default_footer, payment_instructions,
                                    document_layout, server_updated_at, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         display_name = excluded.display_name, registered_name = excluded.registered_name,
         primary_color = excluded.primary_color, secondary_color = excluded.secondary_color,
         accent_color = excluded.accent_color, primary_foreground = excluded.primary_foreground,
         logo_url = excluded.logo_url, contact_email = excluded.contact_email,
         contact_phone = excluded.contact_phone, postal_address = excluded.postal_address,
         physical_address = excluded.physical_address, website = excluded.website,
         tax_pin = excluded.tax_pin, currency = excluded.currency,
         default_footer = excluded.default_footer,
         payment_instructions = excluded.payment_instructions,
         document_layout = excluded.document_layout,
         server_updated_at = excluded.server_updated_at, synced_at = excluded.synced_at`,
      [
        tenantId,
        textField(frame, "displayName"),
        textField(frame, "registeredName"),
        textField(frame, "primaryColor") ?? "#1d4ed8",
        textField(frame, "secondaryColor") ?? "#1e3a5f",
        textField(frame, "accentColor") ?? "#f59e0b",
        textField(frame, "primaryForeground") ?? "#f8fafc",
        textField(frame, "logoUrl"),
        textField(frame, "contactEmail"),
        textField(frame, "contactPhone"),
        textField(frame, "postalAddress"),
        textField(frame, "physicalAddress"),
        textField(frame, "website"),
        textField(frame, "taxPin"),
        textField(frame, "currency") ?? "KES",
        textField(frame, "defaultFooter"),
        textField(frame, "paymentInstructions"),
        textField(frame, "documentLayout") ?? "standard",
        frame.updatedAt,
        this.now().toISOString(),
      ],
    );
  }

  /** Numbering settings, keyed by (tenant, type). */
  async applyNumbering(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);
    const type = enumField(frame, "type", DOCUMENT_TYPES);
    if (!type) {
      throw new Error(`Numbering frame ${frame.id} has no document type`);
    }

    await this.driver.run(
      `INSERT INTO document_numbering (tenant_id, type, prefix, padding, separator,
                                       period_style, fiscal_start_month, next_value,
                                       server_updated_at, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, type) DO UPDATE SET
         prefix = excluded.prefix, padding = excluded.padding,
         separator = excluded.separator, period_style = excluded.period_style,
         fiscal_start_month = excluded.fiscal_start_month,
         next_value = excluded.next_value,
         server_updated_at = excluded.server_updated_at, synced_at = excluded.synced_at`,
      [
        tenantId,
        type,
        textField(frame, "prefix") ?? "",
        intField(frame, "padding", 4),
        textField(frame, "separator") ?? "-",
        enumField(frame, "periodStyle", PERIOD_STYLES, "CALENDAR_YEAR"),
        intField(frame, "fiscalStartMonth", 1),
        intField(frame, "nextValue", 1),
        frame.updatedAt,
        this.now().toISOString(),
      ],
    );
  }

  async applyTaxCategory(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);

    await this.driver.run(
      `INSERT INTO tax_category (id, tenant_id, name, description, is_default,
                                 created_at, updated_at, server_updated_at, synced_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         is_default = excluded.is_default, updated_at = excluded.updated_at,
         server_updated_at = excluded.server_updated_at,
         synced_at = excluded.synced_at, deleted = excluded.deleted`,
      [
        frame.id,
        tenantId,
        textField(frame, "name", { required: true }),
        textField(frame, "description"),
        boolField(frame, "isDefault") ? 1 : 0,
        timestampField(frame, "createdAt") ?? frame.updatedAt,
        frame.updatedAt,
        frame.updatedAt,
        this.now().toISOString(),
        frame.deleted ? 1 : 0,
      ],
    );
  }

  async applyTaxRate(frame: PullFrame, tenantId: string): Promise<void> {
    assertFrameTenant(frame, tenantId);

    await this.driver.run(
      `INSERT INTO tax_rate (id, tenant_id, category_id, name, rate, effective_from,
                             effective_to, is_active, created_at, updated_at,
                             server_updated_at, synced_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         tenant_id = excluded.tenant_id, category_id = excluded.category_id,
         name = excluded.name, rate = excluded.rate,
         effective_from = excluded.effective_from, effective_to = excluded.effective_to,
         is_active = excluded.is_active, updated_at = excluded.updated_at,
         server_updated_at = excluded.server_updated_at,
         synced_at = excluded.synced_at, deleted = excluded.deleted`,
      [
        frame.id,
        tenantId,
        textField(frame, "categoryId", { required: true }),
        textField(frame, "name", { required: true }),
        decimalField(frame, "rate", "0.0000"),
        timestampField(frame, "effectiveFrom", { required: true }),
        timestampField(frame, "effectiveTo"),
        boolField(frame, "isActive", true) ? 1 : 0,
        timestampField(frame, "createdAt") ?? frame.updatedAt,
        frame.updatedAt,
        frame.updatedAt,
        this.now().toISOString(),
        frame.deleted ? 1 : 0,
      ],
    );
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async profile(tenantId: string): Promise<LocalTenantProfile | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM tenant_profile WHERE tenant_id = ?`,
      [tenantId],
    );
    return row ? profileFrom(row) : null;
  }

  async branding(tenantId: string): Promise<LocalTenantBranding | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM tenant_branding WHERE tenant_id = ?`,
      [tenantId],
    );
    return row ? brandingFrom(row) : null;
  }

  async numbering(
    tenantId: string,
    type: LocalDocumentType,
  ): Promise<LocalNumberingConfig | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM document_numbering WHERE tenant_id = ? AND type = ?`,
      [tenantId, type],
    );
    if (!row) return null;
    return {
      tenantId,
      type,
      prefix: String(row.prefix),
      padding: Number(row.padding),
      separator: String(row.separator),
      periodStyle: String(
        row.period_style,
      ) as LocalNumberingConfig["periodStyle"],
      fiscalStartMonth: Number(row.fiscal_start_month),
      nextValue: Number(row.next_value),
      serverUpdatedAt: cellString(row, "server_updated_at"),
    };
  }

  async taxCategories(tenantId: string): Promise<LocalTaxCategory[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM tax_category WHERE tenant_id = ? AND deleted = 0 ORDER BY name`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      description: cellString(row, "description"),
      isDefault: cellBoolean(row, "is_default"),
      updatedAt: String(row.updated_at),
    }));
  }

  async taxRates(tenantId: string): Promise<LocalTaxRate[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM tax_rate WHERE tenant_id = ? AND deleted = 0
        ORDER BY effective_from DESC, name ASC`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      categoryId: String(row.category_id),
      name: String(row.name),
      rate: String(row.rate),
      effectiveFrom: String(row.effective_from),
      effectiveTo: cellString(row, "effective_to"),
      isActive: cellBoolean(row, "is_active"),
      updatedAt: String(row.updated_at),
    }));
  }

  async taxRate(
    tenantId: string,
    rateId: string,
  ): Promise<LocalTaxRate | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM tax_rate WHERE tenant_id = ? AND id = ? AND deleted = 0`,
      [tenantId, rateId],
    );
    if (!row) return null;
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      categoryId: String(row.category_id),
      name: String(row.name),
      rate: String(row.rate),
      effectiveFrom: String(row.effective_from),
      effectiveTo: cellString(row, "effective_to"),
      isActive: cellBoolean(row, "is_active"),
      updatedAt: String(row.updated_at),
    };
  }
}
