import { requireAuth } from "@/lib/auth/helpers";
import { prisma } from "@/lib/db/prisma";
import {
  authorizePlatform,
  AuthorizationError,
} from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { TenantLifecycleActions } from "@/components/platform/tenant-lifecycle-actions";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function PlatformPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await requireAuth(locale);
  const tNav = await getTranslations("nav");

  // Platform authorization is a separate domain from tenant authorization.
  // Denied users get a generic, non-enumerating message.
  try {
    await authorizePlatform(session.user.id, PERMISSIONS.PLATFORM_TENANTS_READ);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return (
        <main className="mx-auto max-w-3xl px-4 py-12">
          <div className="card p-6 text-sm text-slate-600">
            You do not have access to the platform console.
          </div>
        </main>
      );
    }
    throw err;
  }

  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      createdAt: true,
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            Platform console
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Activate or suspend customer workspaces.
          </p>
        </div>
        <SignOutButton label={tNav("signOut")} />
      </header>

      <section className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-6 py-3">Organisation</th>
              <th className="px-6 py-3">Slug</th>
              <th className="px-6 py-3">Status</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td className="px-6 py-3 font-medium text-slate-800">
                  {tenant.name}
                </td>
                <td className="px-6 py-3 text-slate-500">{tenant.slug}</td>
                <td className="px-6 py-3 text-slate-700">{tenant.status}</td>
                <td className="px-6 py-3">
                  <div className="flex justify-end">
                    <TenantLifecycleActions
                      tenantId={tenant.id}
                      status={tenant.status}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {tenants.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-6 py-4 text-center text-slate-500"
                >
                  No organisations yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </main>
  );
}
