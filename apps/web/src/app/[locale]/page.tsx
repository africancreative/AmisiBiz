import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session-user";

export const dynamic = "force-dynamic";

/**
 * Locale root. Sends authenticated users to their dashboard and everyone else
 * to the sign-in screen. Module routes land in later phases.
 */
export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await getSessionUser();

  redirect(user ? `/${locale}/dashboard` : `/${locale}/login`);
}
