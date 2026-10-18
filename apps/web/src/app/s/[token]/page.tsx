import type { Metadata, Viewport } from "next";
import { loadPublicSharePage } from "@/lib/public/share-data";
import { attributionFromParams } from "@/lib/public/lead-capture";
import { PublicNotFound } from "@/components/public/public-not-found";
import { PublicProductView } from "@/components/public/public-product-view";
import { PublicLeadFormView } from "@/components/public/public-lead-form-view";
import { PublicOrderStatusView } from "@/components/public/public-order-status-view";

/**
 * The public share surface: `/s/<token>` (AGENT 02 modules C/E, design spec
 * §0/§3).
 *
 * Deliberately OUTSIDE `[locale]`: a locale prefix would make next-intl's
 * `localePrefix: "always"` middleware redirect `/s/<token>` into the tenant
 * app tree, and the token — not the path — is what identifies the resource.
 * There is no tenant id, workspace slug or subdomain in this URL.
 *
 * No session is read or required. The page renders purely from the
 * unauthenticated `/api/public/*` payloads, which answer through the SECURITY
 * DEFINER functions; anything those functions refuse (unknown, revoked,
 * expired, wrong kind, item removed, order still a draft) becomes the SAME
 * neutral not-found, so the page never exposes internals or a reason.
 */

export const dynamic = "force-dynamic";

/** Customer links are not for search indexes. */
export const metadata: Metadata = {
  title: "Shared page",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

interface PublicSharePageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PublicSharePage({
  params,
  searchParams,
}: PublicSharePageProps) {
  const { token } = await params;
  const page = await loadPublicSharePage(token);

  if (page.status !== "ok") {
    // `invalid_token` and `not_found` are the same page on purpose.
    return <PublicNotFound />;
  }

  const attribution = attributionFromParams(await searchParams);

  if (page.share.kind === "PRODUCT" && page.product) {
    return (
      <PublicProductView product={page.product} attribution={attribution} />
    );
  }

  if (page.share.kind === "ORDER_STATUS" && page.order) {
    return <PublicOrderStatusView order={page.order} />;
  }

  if (page.share.kind === "LEAD_FORM") {
    return <PublicLeadFormView token={page.token} attribution={attribution} />;
  }

  // A link that resolved but whose detail payload disappeared.
  return <PublicNotFound />;
}
