/**
 * Display formatting for the provider console's read-only panels.
 *
 * Deliberately UTC and minute-precision: `Tenant.lastActivityAt`,
 * `lastSyncAt`, the status history and the audit trail all arrive as database
 * timestamps, and a console that shows a suspension "an hour later" than the
 * operator performed it because of a browser timezone is a console nobody can
 * trust during an incident. No locale-dependent magic — the whole column has to
 * read the same for every administrator.
 */
export function formatDateTime(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 16).replace("T", " ");
}

/** Same, with the caller's own "nothing recorded" wording. */
export function formatDateTimeOr(value: Date | null, fallback: string): string {
  return formatDateTime(value) ?? fallback;
}
