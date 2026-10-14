import type { Prisma } from "@prisma/client";
import { slugify } from "@/lib/utils";
import { AUDIT_ACTIONS } from "@/lib/audit";
import {
  buildTenantHostname,
  getBaseDomain,
  isValidSlug,
} from "@/lib/tenancy/host";

/**
 * Tenant provisioning.
 *
 * Creates a tenant in the PENDING state together with its default settings,
 * branding and hostname mapping. The tenant must be ACTIVATED by an authorized
 * platform administrator before it becomes usable — provisioning never grants
 * access on its own.
 *
 * Ownership is established separately (self-registration, or an invitation the
 * owner must accept). An owner is NEVER assigned purely from a submitted email.
 */
export type ProvisionTenantInput = {
  name: string;
  /** Optional preferred slug; a validated unique slug is generated when absent. */
  slug?: string | undefined;
  ownerUserId?: string | undefined;
  country?: string | undefined;
  currency?: string | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
};

export type ProvisionedTenant = {
  tenantId: string;
  slug: string;
  hostname: string | null;
};

/**
 * The three document series a new tenant starts with.
 *
 * Numbering lives in `DocumentNumbering` (one row per tenant per type) rather
 * than on `TenantSettings`, because the document engine and the browser must
 * never hold two ideas of what the next number is. `allocate_document_number()`
 * applies the same defaults on first use, so a tenant that was provisioned
 * before this table existed can still issue its first document; creating the
 * rows here simply means the numbering screen has something to show and edit.
 */
export const DEFAULT_DOCUMENT_SERIES = [
  { type: "QUOTATION", prefix: "QUO" },
  { type: "INVOICE", prefix: "INV" },
  { type: "DELIVERY_NOTE", prefix: "DN" },
] as const;

/** Generates a validated, unique, non-reserved slug for a tenant name. */
export async function generateUniqueTenantSlug(
  tx: Prisma.TransactionClient,
  name: string,
  preferred?: string,
): Promise<string> {
  const candidates: string[] = [];
  const fromPreferred = preferred ? slugify(preferred) : "";
  if (fromPreferred && isValidSlug(fromPreferred))
    candidates.push(fromPreferred);

  const fromName = slugify(name);
  if (fromName && isValidSlug(fromName)) candidates.push(fromName);

  const base = candidates[0] ?? "workspace";

  let slug = base;
  let attempt = 0;
  // Bound the loop; collisions are resolved with a numeric suffix.
  while (
    attempt < 50 &&
    (!isValidSlug(slug) ||
      (await tx.tenant.findUnique({ where: { slug }, select: { id: true } })))
  ) {
    attempt++;
    slug = `${base}-${attempt}`;
  }
  return slug;
}

export async function provisionTenant(
  tx: Prisma.TransactionClient,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const slug = await generateUniqueTenantSlug(tx, input.name, input.slug);
  const baseDomain = getBaseDomain();
  const hostname = buildTenantHostname(slug, baseDomain);

  const tenant = await tx.tenant.create({
    data: {
      name: input.name,
      slug,
      status: "PENDING",
      country: input.country ?? null,
      currency: input.currency ?? "USD",
      timezone: input.timezone ?? "UTC",
      locale: input.locale ?? "en",
      settings: { create: {} },
      documentNumberings: {
        create: DEFAULT_DOCUMENT_SERIES.map((series) => ({
          type: series.type,
          prefix: series.prefix,
        })),
      },
      branding: {
        create: {
          displayName: input.name,
          primaryColor: "#1d4ed8",
          accentColor: "#f59e0b",
          primaryForeground: "#f8fafc",
        },
      },
      ...(hostname
        ? { domains: { create: { hostname, isPrimary: true } } }
        : {}),
    },
    select: { id: true, slug: true },
  });

  if (input.ownerUserId) {
    await tx.tenantMember.create({
      data: {
        tenantId: tenant.id,
        userId: input.ownerUserId,
        role: "BUSINESS_OWNER",
        isDefault: true,
      },
    });
  }

  return { tenantId: tenant.id, slug: tenant.slug, hostname };
}

/** Records tenant creation in the append-only audit log (inside the caller's tx). */
export async function recordTenantCreated(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; userId: string; slug: string },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: AUDIT_ACTIONS.TENANT_CREATED,
      resource: "Tenant",
      resourceId: input.tenantId,
      metadata: { slug: input.slug },
    },
  });
}
