/**
 * Exact decimal-string formatting for display.
 *
 * Amounts travel through the app as decimal strings and PostgreSQL `numeric`,
 * so formatting must not route them through a JS `number`: float parsing can
 * silently change a figure a customer reads on a quote or invoice. Everything
 * below operates on the text itself.
 */

/** Minor-unit places shown per currency (ISO 4217 exponent). */
const CURRENCY_DECIMALS: Record<string, number> = {
  KES: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
};

const CURRENCY_PREFIX: Record<string, string> = {
  KES: "KSh",
  USD: "US$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/**
 * Adds one to an unsigned decimal-digit string using carried text arithmetic.
 * `"999"` becomes `"1000"`; any other input returns `null`.
 */
function incrementDigits(digits: string): string | null {
  if (!/^\d+$/.test(digits)) return null;
  let carry = 1;
  let out = "";
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const sum = Number(digits[i]) + carry;
    carry = sum >= 10 ? 1 : 0;
    out = String(sum % 10) + out;
  }
  return carry === 1 ? `1${out}` : out;
}

/** Splits a decimal string into its sign, integer and fraction parts. */
function parseDecimal(value: string): {
  negative: boolean;
  intPart: string;
  fracPart: string;
} | null {
  const match = /^(-)?(\d+)?(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  return {
    negative: match[1] === "-",
    intPart: (match[2] ?? "0").replace(/^0+(?=\d)/, ""),
    fracPart: match[3] ?? "",
  };
}

/**
 * Rounds a decimal string to `places` fraction digits, half-up, without
 * floating point. Returns `null` when the input is not a plain decimal.
 */
export function roundDecimalString(
  value: string,
  places: number,
): string | null {
  const parsed = parseDecimal(value);
  if (!parsed) return null;
  const { negative, intPart, fracPart } = parsed;

  if (fracPart.length <= places) {
    const fraction = fracPart.padEnd(places, "0");
    return `${negative ? "-" : ""}${intPart}${fraction ? `.${fraction}` : ""}`;
  }

  const kept = fracPart.slice(0, places);
  const digits = `${intPart}${kept}`;
  const roundsUp = Number(fracPart[places]) >= 5;
  if (!roundsUp) {
    return `${negative ? "-" : ""}${intPart}${kept ? `.${kept}` : ""}`;
  }
  const incremented = incrementDigits(digits);
  if (incremented === null) return null;
  const intWidth = incremented.length - places;
  const nextInt = intWidth > 0 ? incremented.slice(0, intWidth) : "0";
  const nextFrac = intWidth > 0 ? incremented.slice(intWidth) : kept;
  return `${negative ? "-" : ""}${nextInt}${nextFrac ? `.${nextFrac}` : ""}`;
}

/** Inserts thousands separators into an unsigned integer digit string. */
function groupInteger(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FormatMoneyOptions {
  /** Override the shown fraction digits; defaults to the currency exponent. */
  decimals?: number;
  /** Drop trailing fraction zeros (useful for rates and quantities). */
  trailingZeros?: boolean;
}

/**
 * Formats a decimal-string amount for display, e.g. `"1234.5000"` →
 * `"KSh 1,234.50"`. Unrecognised input is returned as-is rather than being
 * rendered as `NaN`, so a bad value is visible instead of misleading.
 */
export function formatMoney(
  amount: string,
  currency: string,
  options: FormatMoneyOptions = {},
): string {
  const code = currency.trim().toUpperCase();
  const places = options.decimals ?? CURRENCY_DECIMALS[code] ?? 2;
  const rounded = roundDecimalString(amount, places);
  if (rounded === null) return amount;

  const negative = rounded.startsWith("-");
  const unsigned = negative ? rounded.slice(1) : rounded;
  const [intPart = "0", fracPart = ""] = unsigned.split(".");
  const fraction = options.trailingZeros
    ? fracPart.replace(/0+$/, "")
    : fracPart;

  const prefix = CURRENCY_PREFIX[code] ?? `${code} `;
  return `${negative ? "-" : ""}${prefix}${groupInteger(intPart)}${
    fraction ? `.${fraction}` : ""
  }`;
}

/**
 * Renders a stored 0–1 tax fraction as a percentage label, e.g. `"0.16"` →
 * `"16%"` and `"0.1667"` → `"16.67%"`.
 */
export function formatPercent(fraction: string, places = 2): string {
  const match = /^(\d+)?(?:\.(\d+))?$/.exec(fraction.trim());
  if (!match) return fraction.trim();
  const whole = match[1] ?? "";
  const digits = `${whole}${match[2] ?? ""}`;
  if (digits === "") return "0%";

  // Multiplying by 100 is a two-place decimal-point shift, done in text.
  const pointIndex = whole.length + 2;
  const padded = digits.padEnd(pointIndex, "0");
  const intPart = padded.slice(0, pointIndex).replace(/^0+(?=\d)/, "");
  const fracPart = padded.slice(pointIndex);
  const rounded = roundDecimalString(
    fracPart === "" ? intPart : `${intPart}.${fracPart}`,
    places,
  );
  if (rounded === null) return fraction.trim();

  const trimmed = rounded.includes(".")
    ? rounded.replace(/0+$/, "").replace(/\.$/, "")
    : rounded;
  const [intLabel = "0", fracLabel] = trimmed.split(".");
  return `${groupInteger(intLabel)}${fracLabel ? `.${fracLabel}` : ""}%`;
}
