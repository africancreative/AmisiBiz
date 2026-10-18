import type { ScopedTx } from "@amisibiz/database";

/**
 * Contact tags (AGENT 02, design spec §1.2).
 *
 * A tag is a tenant-owned name; `Tag` is unique per (tenant, name) with the
 * database additionally carrying a functional unique index on `lower(name)`.
 * Prisma cannot express that functional index, so the SERVICE does the
 * case-insensitive work: names are trimmed, emptied entries dropped and
 * duplicates folded case-insensitively (the first spelling seen wins) before
 * anything is looked up or created. The database index then guarantees what
 * the service already normalised.
 *
 * Replace-set semantics: `replaceContactTags` makes the contact carry exactly
 * the given tags — missing links deleted, absent tags created or linked.
 */

type TagDb = Pick<ScopedTx, "tag" | "contactTag">;

/** Trim and bound one tag name; `null` for an unusable entry. */
export function normaliseTagName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return trimmed;
}

/**
 * Normalise a whole tag list: trim, drop empties, fold case-insensitive
 * duplicates keeping the FIRST spelling, and preserve order.
 */
export function normaliseTagNames(names: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const raw of names) {
    const name = normaliseTagName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()];
}

/**
 * Make `contactId` carry exactly `names` (replace-set). Returns the tag names
 * that ended up linked, normalised — the caller echoes them back to the form.
 */
export async function replaceContactTags(
  db: TagDb,
  tenantId: string,
  contactId: string,
  names: readonly string[],
): Promise<string[]> {
  const desired = normaliseTagNames(names);

  const existing = await db.tag.findMany({
    where: { tenantId },
    select: { id: true, name: true },
  });
  // Case-insensitive lookup, service-side: the same folding the functional
  // unique index enforces in the database.
  const byKey = new Map(existing.map((tag) => [tag.name.toLowerCase(), tag]));

  const tagIds: string[] = [];
  for (const name of desired) {
    const key = name.toLowerCase();
    let tag = byKey.get(key);
    if (!tag) {
      tag = await db.tag.create({
        data: { tenantId, name },
        select: { id: true, name: true },
      });
      byKey.set(key, tag);
    }
    tagIds.push(tag.id);
  }

  await db.contactTag.deleteMany({ where: { tenantId, contactId } });
  if (tagIds.length > 0) {
    await db.contactTag.createMany({
      // `tagIds` is deduped by construction above, so the (contactId, tagId)
      // primary key cannot collide within one replace.
      data: tagIds.map((tagId) => ({ tenantId, contactId, tagId })),
    });
  }

  return desired;
}
