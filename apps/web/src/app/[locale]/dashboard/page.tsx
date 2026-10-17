import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireAuth, getPrimaryMembership } from "@/lib/auth/helpers";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await requireAuth(locale);
  const membership = await getPrimaryMembership(session.user.id);

  if (!membership && session.user.platformRole === "SUPER_ADMIN") {
    redirect(`/${locale}/admin`);
  }

  if (membership?.role === "CUSTOMER_PORTAL_USER") {
    redirect(`/${locale}/portal`);
  }

  const t = await getTranslations("dashboard");
  const tNav = await getTranslations("nav");
  const tTeam = await getTranslations("team");

  if (!membership) {
    // A user should always have at least one membership after registering.
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <div className="card p-6">
          <p className="text-sm text-slate-600">
            No organisation is associated with this account yet.
          </p>
        </div>
      </main>
    );
  }

  const { tenant, role } = membership;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {t("welcome", {
              name: session.user.name ?? session.user.email ?? "",
            })}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {tenant.name} &middot; {tTeam(`roles.${role}`)}
          </p>
        </div>
        <SignOutButton label={tNav("signOut")} />
      </header>

      <section className="grid gap-6 sm:grid-cols-2">
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-700">
            {t("overview")}
          </h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Organisation</dt>
              <dd className="font-medium text-slate-800">{tenant.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Slug</dt>
              <dd className="font-medium text-slate-800">{tenant.slug}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Status</dt>
              <dd className="font-medium text-slate-800">{tenant.status}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Currency</dt>
              <dd className="font-medium text-slate-800">{tenant.currency}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Timezone</dt>
              <dd className="font-medium text-slate-800">{tenant.timezone}</dd>
            </div>
          </dl>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-700">
            {t("quickActions")}
          </h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li>
              <a
                href={`/${locale}/team`}
                className="font-medium text-brand-700 hover:underline"
              >
                {tNav("team")}
              </a>
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
