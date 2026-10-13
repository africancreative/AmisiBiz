import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";

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
  const session = await auth();

  redirect(session?.user?.id ? `/${locale}/dashboard` : `/${locale}/login`);
}
