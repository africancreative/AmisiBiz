import { getTranslations } from "next-intl/server";
import { getPortalState } from "@/server/auth/portal";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { AccessDenied } from "@/components/layout/access-denied";
import { getInitials } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await getPortalState(locale);
  const tNav = await getTranslations("nav");

  if (state.status !== "ok") {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10 text-center">
            <h2 className="text-xl font-bold text-slate-900 mb-2">
              Customer Portal Access
            </h2>
            <p className="text-sm text-slate-600 mb-6">{state.reason}</p>
            <SignOutButton label={tNav("signOut")} />
          </div>
        </div>
      </div>
    );
  }

  const { tenant, contact, user } = state;
  const customerDisplayName =
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    contact.companyName ||
    user.name ||
    user.email ||
    "Customer";

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Customer Portal Restricted Header */}
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background px-4 sm:px-8 shadow-xs">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-700 text-sm font-bold text-white shadow-xs"
          >
            {getInitials(tenant.name)}
          </span>
          <div>
            <span className="block text-sm font-bold text-foreground">
              {tenant.name}
            </span>
            <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Customer Portal
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden sm:block text-right">
            <span className="block text-xs font-semibold text-foreground">
              {customerDisplayName}
            </span>
            {contact.email ? (
              <span className="block text-xs text-muted-foreground">
                {contact.email}
              </span>
            ) : null}
          </div>
          <SignOutButton label={tNav("signOut")} />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-8 py-8">
        {children}
      </main>

      {/* Security Footer */}
      <footer className="border-t border-border bg-background py-4 text-center text-xs text-muted-foreground">
        AmisiBiz Customer Portal &middot; Secured by Amisi Genuine Enterprises
      </footer>
    </div>
  );
}
