import * as React from "react";
import { Badge } from "@amisibiz/ui/badge";
import { formatMoney } from "@amisibiz/documents";
import type { PublicProduct } from "@/lib/public-share";
import { PublicShell } from "./public-shell";
import { LeadCaptureForm } from "./lead-capture-form";
import type { PublicLeadAttribution } from "@/lib/public/lead-capture";

/**
 * Public PRODUCT page (`GET /api/public/product/<token>` payload, verbatim).
 *
 * Shows exactly what the SECURITY DEFINER function released: the item's name,
 * description, SKU and unit, its ACTIVE variants with an explicit currency on
 * every price, and the brand fields the function chose to include. It invents
 * nothing:
 *  - images are rendered ONLY if the payload actually carries them — the
 *    migrated `app_public_product_view` returns none, so today this page shows
 *    no picture and no placeholder (recorded gap);
 *  - there is no stock, availability or delivery estimate anywhere (§7:
 *    inventory is out of scope; the only call to action is "Request a quote");
 *  - no client-side arithmetic: each variant's price string goes straight into
 *    `formatMoney` with the currency on the same row.
 */

function currencyFor(product: PublicProduct): string {
  const fromVariant = product.variants.find(
    (variant) => typeof variant.currency === "string" && variant.currency,
  );
  return fromVariant?.currency ?? product.item.currency ?? "KES";
}

export function PublicProductView({
  product,
  attribution,
}: {
  product: PublicProduct;
  attribution?: PublicLeadAttribution | undefined;
}) {
  const { item, tenant } = product;
  const brandName = tenant?.displayName || tenant?.name;
  const unitLabel = item.unitOfMeasure ? ` per ${item.unitOfMeasure}` : "";
  const images = (product.images ?? []).filter((image) =>
    Boolean(image.blobUrl || image.url),
  );

  // The capture endpoint accepts a LEAD_FORM token or a tenant id. A product
  // link's token is NOT a LEAD_FORM token, so the enquiry is addressed with the
  // tenant id this page was already handed by the product payload — the only
  // documented target that resolves. It is never rendered visibly.
  const captureTarget = product.tenantId
    ? { tenantId: product.tenantId }
    : undefined;

  return (
    <PublicShell brandName={brandName} brandLogoUrl={tenant?.logoUrl}>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">{item.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {item.sku ? (
            <Badge tone="neutral">
              SKU <span className="ml-1 font-mono">{item.sku}</span>
            </Badge>
          ) : null}
          {item.unitOfMeasure ? (
            <Badge tone="neutral">{item.unitOfMeasure}</Badge>
          ) : null}
          {item.status !== "ACTIVE" ? (
            <Badge tone="warning">Listing not active</Badge>
          ) : null}
        </div>
      </div>

      {item.status !== "ACTIVE" ? (
        <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground">
          This listing is no longer active in the business&apos;s catalogue. You
          can still send an enquiry, but confirm availability with the business
          first.
        </p>
      ) : null}

      {item.description ? (
        <p className="whitespace-pre-line text-sm leading-6 text-muted-foreground">
          {item.description}
        </p>
      ) : null}

      {images.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image, index) => (
            <li key={image.id ?? `${index}`}>
              {/* Only a URL the payload actually supplied reaches the DOM. */}
              <img
                src={image.blobUrl ?? image.url}
                alt={image.alt ?? `${item.name} image ${index + 1}`}
                className="aspect-square w-full rounded-lg border border-border object-cover"
                loading="lazy"
              />
            </li>
          ))}
        </ul>
      ) : null}

      <section aria-labelledby="variant-options-heading" className="space-y-2">
        <h2 id="variant-options-heading" className="text-sm font-semibold">
          {product.variants.length > 0
            ? "Options and prices"
            : "Price shown by the business"}
        </h2>

        {product.variants.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {product.variants.map((variant) => (
              <li
                key={variant.id}
                className="flex items-baseline justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{variant.name}</p>
                  {variant.sku ? (
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {variant.sku}
                    </p>
                  ) : null}
                </div>
                {/* Currency comes from the variant row itself — never inherited. */}
                <p className="shrink-0 font-mono text-sm">
                  {formatMoney(variant.unitPrice, variant.currency)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            This listing has no published price options yet. Prices are stated
            by the business when it replies
            {unitLabel ? `, per ${item.unitOfMeasure}` : ""}.
          </p>
        )}
      </section>

      {captureTarget ? (
        <LeadCaptureForm
          target={captureTarget}
          attribution={attribution}
          defaultCurrency={currencyFor(product)}
          heading="Request a quote"
          description="Tell the business what you need. This sends an enquiry — it does not place an order and nothing is reserved."
          submitLabel="Send enquiry"
          enquiryLabel={`What do you need${item.name ? ` for ${item.name}` : ""}?`}
          enquiryPlaceholder="Quantity, timing, delivery location…"
          successTitle="Your enquiry has been sent"
          successBody="The business will reply with a quote or to confirm the details. No order has been placed."
        />
      ) : (
        // The payload carried no capture target at all: the form is rendered
        // disabled and says so, rather than pretending to send.
        <LeadCaptureForm
          target={null}
          defaultCurrency={currencyFor(product)}
          heading="Request a quote"
          submitLabel="Send enquiry"
          successTitle="Your enquiry has been sent"
          successBody=""
        />
      )}

      {tenant?.contactEmail || tenant?.contactPhone || tenant?.website ? (
        <section
          aria-labelledby="contact-heading"
          className="rounded-lg border border-border bg-card p-4"
        >
          <h2 id="contact-heading" className="text-sm font-semibold">
            Contact {brandName ?? "the business"}
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {tenant.contactEmail ? (
              <li>
                <a
                  className="underline hover:text-foreground text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={`mailto:${tenant.contactEmail}`}
                >
                  {tenant.contactEmail}
                </a>
              </li>
            ) : null}
            {tenant.contactPhone ? (
              <li>
                <a
                  className="underline hover:text-foreground text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={`tel:${tenant.contactPhone}`}
                >
                  {tenant.contactPhone}
                </a>
              </li>
            ) : null}
            {tenant.website ? (
              <li>
                <a
                  className="underline hover:text-foreground text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={tenant.website}
                  target="_blank"
                  rel="noreferrer nofollow"
                >
                  {tenant.website}
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </PublicShell>
  );
}
