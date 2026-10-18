import type { getItemAction } from "@/server/actions/item";

/**
 * Row shapes the catalogue client surfaces render.
 *
 * They are derived from the Server Action's own return type (type-only import,
 * erased at build time), so a change in the action's `include` shows up as a
 * compile error here rather than a runtime `undefined` in a table cell.
 */
type ItemActionSuccess = Extract<
  Awaited<ReturnType<typeof getItemAction>>,
  { success: true }
>;

/** One item with its category, images, variants and tax rate. */
export type ItemDetailRow = Exclude<
  NonNullable<ItemActionSuccess["data"]>["item"],
  null
>;

export type ItemImageRow = ItemDetailRow["images"][number];
export type ItemVariantRow = ItemDetailRow["variants"][number];
