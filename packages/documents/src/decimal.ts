/**
 * Exact decimal-string arithmetic.
 *
 * Money and quantities travel through AmisiBiz as decimal STRINGS and are stored
 * in PostgreSQL `numeric`. They must never pass through a JS `number`: an issued
 * quote or invoice whose line total shifted in the last binary place is a figure
 * a customer can dispute. Everything here works on the digits of the text, so a
 * multiplication or subtraction is exact regardless of magnitude.
 *
 * This module is deliberately dependency-free (no Prisma, no runtime): the same
 * arithmetic has to run in the web server today and inside a future SQLite-backed
 * offline client, where `Prisma.Decimal` is not available.
 */

type ParsedDecimal = {
  negative: boolean;
  /** Unsigned digit string with no leading zeros (at least "0"). */
  digits: string;
  /** Number of fraction digits. */
  scale: number;
};

/** Parses a plain decimal string, or returns null when it is not one. */
function parseDecimalString(value: string): ParsedDecimal | null {
  const match = /^(-)?(\d+)?(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;

  const intPart = (match[2] ?? "").replace(/^0+(?=\d)/, "");
  const fracPart = match[3] ?? "";
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "");

  return {
    negative: match[1] === "-" && digits !== "0",
    digits: digits === "" ? "0" : digits,
    scale: fracPart.length,
  };
}

/** Renders sign + scaled digit string back into a decimal string. */
function formatDecimal(
  digits: string,
  scale: number,
  negative: boolean,
): string {
  const normalised = digits.replace(/^0+(?=\d)/, "") || "0";
  const sign = negative && normalised !== "0" ? "-" : "";

  if (scale === 0) return `${sign}${normalised}`;

  const padded = normalised.padStart(scale + 1, "0");
  const intPart = padded.slice(0, padded.length - scale);
  const fracPart = padded.slice(padded.length - scale);
  return `${sign}${intPart}.${fracPart}`;
}

/** Unsigned integer addition on digit strings. */
function addDigits(a: string, b: string): string {
  let carry = 0;
  let out = "";
  let i = a.length - 1;
  let j = b.length - 1;
  while (i >= 0 || j >= 0 || carry > 0) {
    const sum =
      (i >= 0 ? Number(a[i]) : 0) + (j >= 0 ? Number(b[j]) : 0) + carry;
    out = String(sum % 10) + out;
    carry = Math.floor(sum / 10);
    i -= 1;
    j -= 1;
  }
  return out.replace(/^0+(?=\d)/, "") || "0";
}

/** Unsigned integer subtraction `a - b`, assuming `a >= b`. */
function subtractDigits(a: string, b: string): string {
  let borrow = 0;
  let out = "";
  let i = a.length - 1;
  let j = b.length - 1;
  while (i >= 0 || j >= 0) {
    let minuend = (i >= 0 ? Number(a[i]) : 0) - borrow;
    const subtrahend = j >= 0 ? Number(b[j]) : 0;
    if (minuend < subtrahend) {
      minuend += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    out = String(minuend - subtrahend) + out;
    i -= 1;
    j -= 1;
  }
  return out.replace(/^0+(?=\d)/, "") || "0";
}

/** Compares two unsigned digit strings: -1, 0 or 1. */
function compareDigits(a: string, b: string): -1 | 0 | 1 {
  const left = a.replace(/^0+(?=\d)/, "") || "0";
  const right = b.replace(/^0+(?=\d)/, "") || "0";
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Schoolbook unsigned integer multiplication on digit strings. */
function multiplyDigits(a: string, b: string): string {
  if (a === "0" || b === "0") return "0";
  const result: number[] = new Array(a.length + b.length).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const product = Number(a[i]) * Number(b[j]);
      const lowIndex = i + j + 1;
      const highIndex = i + j;
      const sum = (result[lowIndex] ?? 0) + product;
      result[lowIndex] = sum % 10;
      result[highIndex] = (result[highIndex] ?? 0) + Math.floor(sum / 10);
    }
  }
  return result.join("").replace(/^0+(?=\d)/, "") || "0";
}

/** Negates a decimal string. */
export function negateDecimalString(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("-") ? trimmed.slice(1) : `-${trimmed}`;
}

/** Exact `a + b` for two decimal strings, or null when either is malformed. */
export function addDecimalStrings(a: string, b: string): string | null {
  const x = parseDecimalString(a);
  const y = parseDecimalString(b);
  if (!x || !y) return null;

  const scale = Math.max(x.scale, y.scale);
  const ax = x.digits.padEnd(x.digits.length + (scale - x.scale), "0");
  const by = y.digits.padEnd(y.digits.length + (scale - y.scale), "0");

  if (x.negative === y.negative) {
    return formatDecimal(addDigits(ax, by), scale, x.negative);
  }

  const comparison = compareDigits(ax, by);
  if (comparison === 0) return formatDecimal("0", scale, false);
  if (comparison > 0) {
    return formatDecimal(subtractDigits(ax, by), scale, x.negative);
  }
  return formatDecimal(subtractDigits(by, ax), scale, y.negative);
}

/** Exact `a - b` for two decimal strings, or null when either is malformed. */
export function subtractDecimalStrings(a: string, b: string): string | null {
  return addDecimalStrings(a, negateDecimalString(b));
}

/** Exact `a * b` for two decimal strings, or null when either is malformed. */
export function multiplyDecimalStrings(a: string, b: string): string | null {
  const x = parseDecimalString(a);
  const y = parseDecimalString(b);
  if (!x || !y) return null;

  const product = multiplyDigits(x.digits, y.digits);
  const negative = x.negative !== y.negative;
  return formatDecimal(product, x.scale + y.scale, negative);
}

/**
 * Exact three-way comparison of two decimal strings: `-1`, `0` or `1`, or null
 * when either is malformed.
 *
 * This exists so a decision such as "is this invoice fully paid" is taken by
 * digit comparison rather than by `Number(a) >= Number(b)`, which can be wrong
 * at the last place for the magnitudes invoices reach. It is the comparison a
 * derived-status rule must use.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 | null {
  const difference = subtractDecimalStrings(a, b);
  if (difference === null) return null;
  const trimmed = difference.trim();
  const negative = trimmed.startsWith("-");
  const magnitude = negative ? trimmed.slice(1) : trimmed;
  // Any non-zero digit means the two values differ.
  if (/[1-9]/.test(magnitude)) return negative ? -1 : 1;
  return 0;
}
