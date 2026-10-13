import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges class names using clsx and tailwind-merge.
 * Deduplicates conflicting Tailwind utility classes.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Generates a URL-safe slug from a string.
 * e.g. "Amisi Co. Ltd" → "amisi-co-ltd"
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Formats a date using Intl.DateTimeFormat.
 */
export function formatDate(
  date: Date | string,
  locale = "en",
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...options,
  }).format(d);
}

/**
 * Masks an email address for safe display: user@example.com → u***@e***.com
 */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "***@***.***";
  const [domainName, ...tld] = domain.split(".");
  return `${user[0]}***@${domainName?.[0] ?? "*"}***.${tld.join(".")}`;
}

/**
 * Returns initials from a name string.
 * e.g. "Amisi Genuine" → "AG"
 */
export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Safe JSON parse — returns undefined instead of throwing.
 */
export function safeJsonParse<T>(str: string): T | undefined {
  try {
    return JSON.parse(str) as T;
  } catch {
    return undefined;
  }
}
