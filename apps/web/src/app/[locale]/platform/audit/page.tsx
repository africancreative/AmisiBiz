import { requireAuth } from "@/lib/auth/helpers";
import { prisma, runInScope } from "@amisibiz/database";
import {
  authorizePlatform,
  AuthorizationError,
  type PlatformAuthzContext,
} from "@/server/auth/authorization";
import { PERMISSIONS } from "@amisibiz/auth";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@amisibiz/ui/page-header";
import { AuditLogViewer } from "@/components/audit/audit-log-viewer";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Provider audit viewer (`/platform/audit`).
 *
 * Cross-tenant, so it requires `platform.audit.read` — held by SUPER_ADMIN only.
 * Support holds the tenant-scoped `audit.read` through an explicit grant and is
 * deliberately NOT given a global view: a support engagement is scoped to one
 * workspace at a time, and that constraint is enforced here by the permission,
 * not by convention.
 */
export default async function PlatformAuditPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await requireAuth(locale);

  let context: PlatformAuthzContext;
  try {
    context = await authorizePlatform(
      session.user.id,
      PERMISSIONS.PLATFORM_AUDIT_READ,
    );
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return (
        <main className="mx-auto max-w-3xl px-4 py-12">
          <div className="card p-6 text-sm text-slate-600">
            You do not have access to the platform audit trail.
          </div>
        </main>
      );
    }
    throw err;
  }

  // A Server Component render does not inherit the scope `authorizePlatform`
  // entered (via `enterWith`), so scope the read explicitly with `runInScope`.
  const tenants = await runInScope(context.scope, () =>
    prisma.tenant.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  );

  const t = await getTranslations("audit");

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6">
        <Link
          href={`/${locale}/platform`}
          className="text-sm text-slate-500 hover:underline"
        >
          ← Platform console
        </Link>
      </div>
      <PageHeader
        title={t("platformTitle")}
        description={t("platformDescription")}
      />
      <AuditLogViewer source="platform" locale={locale} tenants={tenants} />
    </main>
  );
}
