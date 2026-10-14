import type { Prisma } from "@prisma/client";
import { DEFAULT_DOCUMENT_SERIES } from "@amisibiz/documents";
import {
  currentScope,
  runInScope,
  tenantScope,
  type ScopedTx,
} from "@amisibiz/database";
import { slugify } from "@/lib/utils";
import { AUDIT_ACTIONS, appendAuditLog } from "@/lib/audit";
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
 *
 * RLS shape (design §5.4, migration 20261018000002): the rows are written in
 * two stages because that is what the policies allow.
 *
 *  1. With the *creator* context (`app.current_user_id` = the actor, no tenant
 *     selected): the `Tenant` row — `status = 'PENDING'` and
 *     `createdById = current_user_id()` is the anchor its INSERT policy admits —
 *     plus its settings/branding/domain defaults and, for self-registration, the
 *     owner membership.
 *  2. Then inside the *new tenant's own* context: the document-numbering series
 *     and the first status-history row. Their policies are the ordinary
 *     write/read families, which need `app.current_tenant_id` to match; they are
 *     written after stage 1 so the membership row they depend on already exists.
 *
 * `runInScope` reuses the caller's transaction, so the whole provisioning is
 * still one atomic unit — only the context changes mid-transaction.
 */
export type ProvisionTenantInput = {
  name: string;
  /** Optional preferred slug; a validated unique slug is generated when absent. */
  slug?: string | undefined;
  ownerUserId?: string | undefined;
  /** Who provisions the tenant (self-registration or platform operator). */
  createdById?: string | undefined;
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
  //
  // Under RLS this probe only sees tenants the actor may already see, so a slug
  // taken by another workspace is not detected here. That is intentional — the
  // alternative would be a global existence oracle over every tenant's slug.
  // The real check is `Tenant_slug_key`, and a collision surfaces as a unique
  // violation that the caller reports as a generic failure.
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

/**
 * The context stage 2 runs in: the new tenant, addressed by the actor who is
 * already authorized (an owner claiming their own workspace, or a platform
 * operator acting on somebody else's).
 */
function newTenantContext(
  tenantId: string,
  input: ProvisionTenantInput,
): ReturnType<typeof tenantScope> {
  const ambient = currentScope();
  const actorId = ambient?.userId ?? input.createdById ?? input.ownerUserId;

  if (!actorId) {
    throw new Error(
      "provisionTenant requires an authorized actor: no request scope is open and no createdById was supplied.",
    );
  }

  return tenantScope(
    actorId,
    tenantId,
    input.ownerUserId ? "TENANT_OWNER" : null,
    {
      // Never self-declared: the ambient scope only carries platform claims that
      // were read from the actor's own row by the authorization service.
      isPlatformAdmin: ambient?.isPlatformAdmin === true,
      isPlatformSupport: ambient?.isPlatformSupport === true,
    },
  );
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
      ...(input.createdById ? { createdById: input.createdById } : {}),
      settings: { create: {} },
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
    // The self-registration path: `tenant_member_insert` admits exactly this
    // shape — the creator claiming TENANT_OWNER of the PENDING tenant they made.
    // A platform operator provisioning for somebody else takes the
    // `is_platform_admin()` branch and no membership at all: ownership arrives
    // through an invitation the recipient accepts.
    await tx.tenantMember.create({
      data: {
        tenantId: tenant.id,
        userId: input.ownerUserId,
        role: "TENANT_OWNER",
        isDefault: true,
      },
    });
  }

  const scope = newTenantContext(tenant.id, input);

  await runInScope(scope, async (scopedTx: ScopedTx) => {
    // Stage 2 rows. The numbering series is the write family's business, and the
    // history row is append-only evidence of how the workspace was born.
    await scopedTx.documentNumbering.createMany({
      data: DEFAULT_DOCUMENT_SERIES.map((series) => ({
        tenantId: tenant.id,
        type: series.type,
        prefix: series.prefix,
      })),
    });

    await scopedTx.tenantStatusHistory.create({
      data: {
        tenantId: tenant.id,
        fromStatus: null,
        toStatus: "PENDING",
        changedById: input.createdById ?? null,
        reason: "provisioned",
      },
    });
  });

  return { tenantId: tenant.id, slug: tenant.slug, hostname };
}

/** Records tenant creation in the append-only audit log (inside the caller's tx). */
export async function recordTenantCreated(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; userId: string; slug: string },
): Promise<void> {
  await appendAuditLog(tx as ScopedTx, {
    tenantId: input.tenantId,
    userId: input.userId,
    action: AUDIT_ACTIONS.TENANT_CREATED,
    resource: "Tenant",
    resourceId: input.tenantId,
    metadata: { slug: input.slug },
  });
}
