"use client";

import * as React from "react";
import { getTaxCategoriesAction } from "@/server/actions/item";
import { formatPercent } from "@amisibiz/documents";

/**
 * The tenant's tax rates, as the option list both the item dialog and the
 * variant dialog need.
 *
 * Rates are read through the existing `getTaxCategoriesAction` (permission
 * `ITEMS_READ`) and only ACTIVE rates are offered. Selecting none is a real
 * choice, not a default: an item or variant with no rate is untaxed, and the
 * client never computes a rate.
 */
export interface TaxRateOption {
  id: string;
  label: string;
}

export type TaxRateState = {
  options: TaxRateOption[];
  isLoading: boolean;
  error: string | null;
};

export function useTaxRateOptions(tenantId: string): TaxRateState & {
  reload: () => void;
} {
  const [options, setOptions] = React.useState<TaxRateOption[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await getTaxCategoriesAction({
          tenantId,
          page: 1,
          pageSize: 100,
        });
        if (!active) return;
        // Two separate narrowings on purpose: a single `!success || !data`
        // condition leaves `result` un-narrowed afterwards, so `result.error`
        // would not exist on the union member that survives.
        if (!result.success) {
          setError(result.error || "Failed to load tax rates.");
          return;
        }
        if (!result.data) {
          setError("Failed to load tax rates.");
          return;
        }
        setOptions(
          result.data.categories.flatMap((category) =>
            category.rates
              .filter((rate) => rate.isActive)
              // The Decimal keeps its exact text form; `formatPercent` reads it.
              .map((rate) => ({
                id: rate.id,
                label: `${category.name}: ${rate.name} (${formatPercent(
                  rate.rate.toString(),
                )})`,
              })),
          ),
        );
      } catch {
        if (active) setError("Failed to load tax rates.");
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [tenantId, nonce]);

  return { options, isLoading, error, reload: () => setNonce((n) => n + 1) };
}
