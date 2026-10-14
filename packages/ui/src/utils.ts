import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional Tailwind class names, with later classes winning conflicts.
 * Lives in the UI package so every component — wherever it renders — builds
 * class lists the same way.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
