import { redirect } from "next/navigation";

/**
 * Root page — redirects to the default locale.
 * next-intl middleware will further redirect to /en/login or /en/dashboard.
 */
export default function RootPage() {
  redirect("/en");
}
