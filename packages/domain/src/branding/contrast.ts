/**
 * Colour contrast helpers shared by the branding form (live warning) and the
 * branding Server Action (authoritative rejection).
 *
 * WCAG 2.1 relative luminance and contrast ratio. These are presentation
 * metrics, not financial values, so floating point is appropriate here.
 */

export const WCAG_AA_NORMAL_TEXT_RATIO = 4.5;

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;

function toRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX_COLOR.test(hex)) return null;
  const value = parseInt(hex.replace("#", ""), 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

function relativeLuminance(hex: string): number | null {
  const rgb = toRgb(hex);
  if (!rgb) return null;
  const linear = (channel: number) =>
    channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  return (
    0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
  );
}

/** Contrast ratio between two hex colours, or `null` when either is invalid. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * True only when both colours parse and the pair meets the WCAG AA ratio for
 * normal text. An unparsable colour is treated as failing, never as passing.
 */
export function meetsContrastMinimum(
  a: string,
  b: string,
  minimum: number = WCAG_AA_NORMAL_TEXT_RATIO,
): boolean {
  const ratio = contrastRatio(a, b);
  return ratio !== null && ratio >= minimum;
}
